import {openObjectView,closeObjectView,objectNavigationBar,notifyNotebook} from './assistantNavigation';
import { renderMarkdown } from './markdown';
/** Formula correction is local. Recognition / explanation always use the production dispatcher. */
import './formulaWorkspace.css';
import 'katex/dist/katex.min.css';
import { h } from '../shared/dom';
import { state } from './state';
import { copyFormulaCode } from '../formula/clipboard';
import { toast,toastUndo } from '../shared/toast';
import { renderFormula } from '../formula/render';
import { loadRegionAssets, blobDataUrl } from '../evidence/repository';
import type { RegionRecord } from '../shared/idb';
import { returnToEvidenceSource, startRegionSelection } from './evidenceWorkspace';
import { requestSessionGeneration } from './requestWorkspace';
import { createFormulaRecognition } from '../ai/formulaRecognition';
import { authorizeExplicitSend } from '../ai/preparedRequest';
import type { PreparedDocument } from '../ai/dispatcher';
import { ensureReaderAiAccess } from '../ai/dispatcher';
import { isConfigured } from '../shared/settings';
import { listFormulas, loadFormula, createFormula, reviseFormula, restoreFormulaRevision,
  saveFormulaCandidate, saveFormulaExplanation, setFormulaDeleted } from '../formula/repository';
import type { FormulaDocument, FormulaSegmentRef } from '../formula/model';

/** Pure operations never truncate or mutate the caller's fragment list. */
export function formulaSegmentOrder(segments: readonly FormulaSegmentRef[], from: number, to: number): FormulaSegmentRef[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= segments.length || to >= segments.length) throw new Error('片段位置无效');
  const result = structuredClone([...segments]); const [item] = result.splice(from, 1); result.splice(to, 0, item);
  return result.map((segment, order) => ({ ...segment, order }));
}
export function formulaSegmentAppend(segments: readonly FormulaSegmentRef[], next: FormulaSegmentRef): FormulaSegmentRef[] {
  if (segments.length >= 8) throw new Error('同一公式最多8个片段；请明确移除或另建公式，不会静默丢图');
  return [...structuredClone(segments), structuredClone(next)].map((segment, order) => ({ ...segment, order }));
}
export function formulaSegmentReplace(segments: readonly FormulaSegmentRef[], index: number, next: FormulaSegmentRef): FormulaSegmentRef[] {
  if (!Number.isInteger(index) || index < 0 || index >= segments.length) throw new Error('要替换的片段不存在');
  return segments.map((segment, order) => ({ ...structuredClone(order === index ? next : segment), order }));
}
export function formulaSegmentRemove(segments: readonly FormulaSegmentRef[], index: number): FormulaSegmentRef[] {
  if (!Number.isInteger(index) || index < 0 || index >= segments.length) throw new Error('要移除的片段不存在');
  if (segments.length <= 1) throw new Error('至少保留一个原图片段；可以替换该片段');
  return segments.filter((_, i) => i !== index).map((segment, order) => ({ ...structuredClone(segment), order }));
}
export function formulaCandidateApplicable(dirty: boolean, running: boolean): boolean { return !dirty && !running; }

let host: HTMLElement | null = null;
let documentId = '', generation = 0, workspaceReadVersion = 0, activeId = '', current: FormulaDocument | null = null;
let formulas: FormulaDocument[] = [], assets: RegionRecord[] = [];
let sourceText = '', contextText = '', dirty = false, busy = false, statusText = '';
const contextByFormula=new Map<string,string>();
const editorDrafts=new Map<string,string>();
let prepared: PreparedDocument | null = null, preparation = 0;
let binding: { formulaId: string; sourceRevisionId: string; expectedRevision: number; action: 'recognize'|'explain'; source: {latex:string;segments:FormulaSegmentRef[]}; previousExplanationId?:string } | null = null;
let controller: AbortController | null = null;
let service: ReturnType<typeof createFormulaRecognition> | null = null;
let statusHost:HTMLElement|null=null;
let requestHost:HTMLElement|null=null;
let requestStatus: HTMLElement | null = null;
const imageCache = new Map<string, string>();
let stopSubscription: (()=>void) | null = null;
let listenersRegistered=false;
function matches(docId=documentId, version=generation): boolean { return !!docId && docId === state.docId && documentId === docId && version === generation; }
function message(text: string, error=false): void { statusText=text; if(statusHost){statusHost.textContent=text;statusHost.dataset.kind=error?'error':'normal';} if(error)toast(text,'error'); }
function action(label: string, handler: ()=>void|Promise<void>, primary=false): HTMLButtonElement {
  const button=h('button',{class:primary?'yd-primary':'ghost',disabled:busy},label);
  button.onclick=()=>{try{void Promise.resolve(handler()).catch(error=>message(error instanceof Error?error.message:'操作未完成；原记录保留',true));}catch(error){message(error instanceof Error?error.message:'操作未完成',true);}};
  return button;
}
export function initFormulaWorkspace(element: HTMLElement): void {
  host=element;host.classList.add('yd-formula-workspace');
  host.addEventListener('mousedown',event=>event.stopPropagation());
  stopSubscription?.();
  service=createFormulaRecognition(()=>({docId:state.docId,sessionGeneration:requestSessionGeneration()}));
  if(!listenersRegistered){listenersRegistered=true;chrome.runtime.onMessage.addListener((message:{type?:string})=>{if(message?.type==='settings-changed')service?.invalidate('服务配置已改变');});chrome.storage?.onChanged?.addListener((changes,area)=>{if(area==='local'&&'settings.v1' in changes)service?.invalidate('本机服务配置已更新');});if(typeof BroadcastChannel!=='undefined'){const channel=new BroadcastChannel('yedeng-document-ai-policy');channel.onmessage=()=>service?.invalidate('文献策略已改变');}}
  stopSubscription=service.subscribe(reason=>{preparation++;prepared=null;if(requestStatus)requestStatus.textContent=`${reason}；请重新准备，没有补发。`;if(requestHost)requestHost.querySelector<HTMLButtonElement>('[data-send-formula]')?.setAttribute('disabled','');});
  window.addEventListener('yedeng:formula-region',event=>{const detail=(event as CustomEvent<{assetId:string;append:boolean}>).detail;void openRegionAsFormula(detail.assetId,detail.append).catch(error=>message(String(error),true));});
  document.querySelector<HTMLButtonElement>('#btn-formula-select')!.onclick=()=>startFormulaCrop(false);
  render();
}
export function resetFormulaWorkspace(): void {
  generation++;workspaceReadVersion++;preparation++;controller?.abort();controller=null;prepared=null;binding=null;
  contextByFormula.clear();documentId='';activeId='';current=null;host?.classList.remove('is-expanded');formulas=[];assets=[];sourceText='';contextText='';dirty=false;busy=false;statusText='';imageCache.clear();render();
}
export async function loadFormulaWorkspace(docId=state.docId): Promise<void> {
  resetFormulaWorkspace();documentId=docId;const version=generation;
  if(!matches(docId,version)){render();return;}
  const [records,regions]=await Promise.all([listFormulas(docId,true),loadRegionAssets(docId)]);
  if(!matches(docId,version))return;
  formulas=records.filter(record=>!record.deletedAt);assets=regions;
  // Earlier builds saved formula crops before creating a head. Adopt them once with a stable key.
  const referenced=new Set(records.flatMap(record=>record.segments.map(segment=>segment.assetId)));
  for(const region of regions.filter(region=>region.kind==='formula'&&!referenced.has(region.id))){
    if(!matches(docId,version))return;const segments=references().filter(s=>s.assetId===region.id);
    if(!segments.length)continue;const record=await createFormula(docId,segments,'','legacy:'+region.id);if(!matches(docId,version))return;formulas.push(record);
  }notifyNotebook();render();
}
function startFormulaCrop(append:boolean):void {
  if(busy||dirty){message('请先保存修改或等待当前操作',true);return;}
  if(append&&current&&current.segments.length>=8){message('这条公式已有8张原图，请先移除一张原图后再添加',true);return;}
  startRegionSelection(append?'formula-append':'formula-new');
}
async function openRegionAsFormula(assetId:string,append:boolean):Promise<void>{
  if(!matches()||busy||dirty)throw new Error('公式当前不可切换，请先保存修改');
  const docId=documentId,version=generation,expectedId=activeId,read=++workspaceReadVersion;assets=await loadRegionAssets(docId);if(!matches(docId,version)||activeId!==expectedId||workspaceReadVersion!==read)return;
  const picked=references().find(item=>item.assetId===assetId);if(!picked)throw new Error('公式原图暂不可用');
  if(append&&current)await safeSegmentMutation(segments=>formulaSegmentAppend(segments,picked));
  else {const record=await createFormula(docId,[{...picked,order:0}]);if(!matches(docId,version)||activeId!==expectedId||workspaceReadVersion!==read)return;current=record;activeId=record.id;contextText='';formulas.push(record);sourceText='';dirty=false;}
  openObjectView('formulas');statusText='';render();
}
/** Optional assembly hook: select an existing formula after a saved region is chosen. */
export async function openFormulaWorkspace(formulaId?:string):Promise<void> {
  if(!matches()){render();return;}
  if(busy){if(!formulaId)return;throw new Error('公式操作进行中，请先等待或取消请求');}
  if(dirty&&formulaId)throw new Error('请先保存或撤销手改，工作区不会覆盖未保存文本');
  const version=generation,docId=documentId,read=++workspaceReadVersion;
  if(formulaId){const record=await loadFormula(formulaId);if(!matches(docId,version)||read!==workspaceReadVersion||busy||dirty)return;if(!record||record.docId!==docId)throw new Error('公式不属于当前文献');if(record.deletedAt)throw new Error('公式已删除，可在笔记回收站恢复');current=record;activeId=record.id;contextText=contextByFormula.get(record.id)??'';sourceText=record.latex;dirty=false;}
  else {const regions=await loadRegionAssets(docId);if(!matches(docId,version)||read!==workspaceReadVersion||busy)return;assets=regions;}
  openObjectView('formulas');render();
}
function references():FormulaSegmentRef[]{
  return assets.flatMap(asset=>(asset.segments??[]).map(segment=>({assetId:asset.id,assetVersion:asset.assetVersion??1,segmentId:segment.id,
    pageIndex:segment.pageIndex,quad:structuredClone(segment.quad),cropBlob:segment.cropBlob,hash:segment.hash,width:segment.width,height:segment.height,order:segment.order,rotation:segment.rotation})));
}
async function perform(write:(record:FormulaDocument)=>Promise<FormulaDocument>,success:string):Promise<void>{
  if(!current||busy||!matches())return;const record=current,docId=documentId,version=generation,pendingText=sourceText,pendingDirty=dirty;busy=true;prepared=null;preparation++;render();
  try{const updated=await write(record);if(!matches(docId,version))return;current=updated;sourceText=pendingDirty?pendingText:updated.latex;dirty=sourceText!==updated.latex;formulas=formulas.filter(item=>item.id!==updated.id).concat(updated);message(success);}
  finally{if(matches(docId,version)){busy=false;render();}}
}
async function saveSource():Promise<void>{
  if(!current||!dirty)return;
  if(sourceText.length>12000)throw new Error('LaTeX超过12000字符，未保存也未截断；请手动缩减或拆分');
  const latex=sourceText;await perform(record=>reviseFormula(record.id,{latex},record.revision),'公式已保存，之前的结果保留在编辑记录中。');
}
function safeSegmentMutation(change:(segments:FormulaSegmentRef[])=>FormulaSegmentRef[]):Promise<void>{
  if(dirty)throw new Error('请先保存或撤销手改，再调整原图片段');
  return perform(record=>reviseFormula(record.id,{segments:change(record.segments),latex:''},record.revision),'原图已更新，可重新讲解或复制。之前的结果仍然保留。');
}
async function imageFor(segment:FormulaSegmentRef):Promise<string>{
  const key=`${segment.assetId}:${segment.assetVersion}:${segment.segmentId}:${segment.hash}`;
  const cached=imageCache.get(key);if(cached)return cached;const image=await blobDataUrl(segment.cropBlob);imageCache.set(key,image);return image;
}
async function copyLatexToClipboard(button:HTMLButtonElement,feedback:HTMLElement):Promise<void>{
  const text=sourceText,version=generation,id=activeId;
  if(!text.trim())throw new Error('还没有可复制的结果，请先提取公式');
  button.disabled=true;button.textContent='正在复制…';feedback.replaceChildren();
  const outcome=await copyFormulaCode(text,navigator.clipboard?.writeText?value=>navigator.clipboard.writeText(value):undefined);
  if(version!==generation||id!==activeId||!button.isConnected)return;
  button.disabled=false;
  if(outcome==='copied'){
    button.textContent='✓ 已复制';feedback.textContent='已复制 LaTeX 格式，可粘贴到支持公式的笔记或编辑器。';toast('公式已复制','success');
  }else{
    button.textContent='重试复制';
    const manual=h('textarea',{'aria-label':'手动复制公式',readOnly:true,value:text,rows:3});
    manual.onfocus=()=>manual.select();
    feedback.append(h('p',{},'浏览器没有允许自动复制。公式已选中，可按 ⌘C / Ctrl+C 手动复制。'),manual);
    manual.focus();manual.select();
  }
}
function formulaDialog(title:string,body:HTMLElement):HTMLDialogElement{
  document.querySelector<HTMLDialogElement>('.yd-object-dialog')?.close();document.querySelector('.yd-object-dialog')?.remove();
  const focus=document.activeElement as HTMLElement|null,dialog=h('dialog',{class:'yd-object-dialog','aria-label':title});
  const close=()=>{dialog.close();dialog.remove();focus?.isConnected&&focus.focus({preventScroll:true});};
  dialog.append(h('header',{},h('h2',{},title),h('button',{'aria-label':'关闭弹窗',on:{click:close}},'×')),body);
  dialog.addEventListener('cancel',()=>{dialog.remove();});document.body.append(dialog);dialog.showModal();return dialog;
}
function original(segment:FormulaSegmentRef,index:number):HTMLElement{
  const frame=h('div',{class:'yd-formula-image',tabIndex:0,'aria-label':`原图 · 第 ${segment.pageIndex+1} 页`});const version=generation,docId=documentId;
  void imageFor(segment).then(image=>{if(matches(docId,version)&&frame.isConnected)frame.append(h('img',{src:image,alt:`公式原图 · 第 ${segment.pageIndex+1} 页`}));}).catch(()=>{frame.textContent='这张原图暂未读到，请重新打开。';});
  const locate=action(`第 ${segment.pageIndex+1} 页 ↗`,()=>returnToEvidenceSource({id:segment.segmentId,docId:documentId,kind:'image',label:'公式原图',pageIndices:[segment.pageIndex],sourceQuads:[{pageIndex:segment.pageIndex,quads:[segment.quad]}]}));
  const zoom=action('放大',()=>{const large=h('div',{class:'yd-object-images'},frame.cloneNode(true));formulaDialog('公式原图',large);});
  const controls=h('div',{class:'yd-formula-segment-head'},locate,zoom);
  if(current!.segments.length>1){const up=action('前移',()=>safeSegmentMutation(items=>formulaSegmentOrder(items,index,index-1)));up.disabled=busy||index===0;const down=action('后移',()=>safeSegmentMutation(items=>formulaSegmentOrder(items,index,index+1)));down.disabled=busy||index===current!.segments.length-1;controls.append(up,down,action('移除',()=>safeSegmentMutation(items=>formulaSegmentRemove(items,index))));}
  return h('article',{class:'yd-formula-segment'},controls,frame);
}
async function copyFormulaIntent():Promise<void>{
 const docId=documentId,version=generation,id=activeId;if(busy||!current)return;
 if(!current.latex.trim()){message('正在提取公式…');await prepareAi('recognize');}
 if(!matches(docId,version)||activeId!==id)return;
 if(!current?.latex.trim()){message('未提取出可复制公式，请检查原图后重试。',true);return;}
 sourceText=current.latex;const button=host?.querySelector<HTMLButtonElement>('[data-copy-formula]'),feedback=host?.querySelector<HTMLElement>('[data-copy-feedback]');if(button&&feedback)await copyLatexToClipboard(button,feedback);
}
function editFormula():void{
 if(!current||busy)return;const record=current,docId=documentId,version=generation;
 const editor=h('textarea',{'aria-label':'公式 LaTeX',value:editorDrafts.get(record.id)??record.latex,rows:5,spellcheck:false}),math=h('div',{class:'yd-formula-preview'});
 const update=()=>{const result=renderFormula(editor.value);math.replaceChildren();if(result.status==='rendered')math.innerHTML=result.html;else math.textContent=result.message;};editor.oninput=()=>{editorDrafts.set(record.id,editor.value);update();};update();
 const save=action('保存修改',async()=>{if(!matches(docId,version)||current?.id!==record.id)throw new Error('当前文献已改变，修改未保存');sourceText=editor.value;dirty=sourceText!==record.latex;try{await saveSource();if(!dirty){editorDrafts.delete(record.id);dialog.close();dialog.remove();}}catch(error){if((error as Error).name==='FormulaConflictError'){body.append(h('p',{class:'ml-muted'},'另一个窗口已更新。你的修改仍保留，可以读取最新原图后再核对。'),action('读取最新保存的内容',async()=>{const latest=await loadFormula(record.id);if(!latest||!matches(docId,version))return;current=latest;sourceText=latest.latex;dirty=false;dialog.close();dialog.remove();render();editFormula();}));}throw error;}} ,true);
 const body=h('div',{},h('p',{class:'ml-muted'},'对照原图检查上下标、括号和符号。'),h('div',{class:'yd-object-images'},...record.segments.map(readonlyOriginal)),h('h3',{},'识别结果'),math,h('label',{},'LaTeX',editor),h('div',{class:'yd-object-actions'},action('编辑记录',()=>{dialog.close();dialog.remove();showFormulaHistory();}),save));
 const dialog=formulaDialog('检查公式',body);
 // Editing is kept inside this dialog until Save, so closing cannot dirty the active object.
}
function readonlyOriginal(segment:FormulaSegmentRef):HTMLElement{const view=original(segment,0);view.querySelector('.yd-formula-segment-head')?.remove();return view;}
function resultPreview(latex:string):HTMLElement{const box=h('div',{class:'yd-formula-preview'});if(!latex.trim())box.textContent='只有原图，尚未提取公式';else{const result=renderFormula(latex);if(result.status==='rendered')box.innerHTML=result.html;else box.append(h('pre',{},latex));}return box;}
function showFormulaHistory():void{
 const record=current;if(!record)return;const body=h('div',{},h('p',{class:'ml-muted'},'恢复后，刚才的内容也会保留。'));
 const key=(value:{latex:string;segments:FormulaSegmentRef[]})=>JSON.stringify([value.latex,value.segments.map(s=>[s.hash,s.pageIndex,s.order])]);const seen=new Set([key(record)]);
 for(const revision of [...record.history].reverse()){if(seen.has(key(revision)))continue;seen.add(key(revision));body.append(h('article',{class:'yd-notebook-object'},h('strong',{},new Date(revision.createdAt).toLocaleString()),resultPreview(revision.latex),h('div',{class:'yd-object-images'},...revision.segments.map(readonlyOriginal)),action('恢复这份内容',async()=>{await perform(value=>restoreFormulaRevision(value.id,revision.id,value.revision),'已恢复；之前的内容也保留在记录中。');dialog.close();dialog.remove();},true)));}
 for(const candidate of [...record.candidates].reverse()){const revision=record.history.find(r=>r.id===candidate.sourceRevisionId);if(!revision||seen.has(key({latex:candidate.latex,segments:revision.segments})))continue;body.append(h('article',{class:'yd-notebook-object'},h('strong',{},`以前提取的结果 · ${new Date(candidate.createdAt).toLocaleString()}`),resultPreview(candidate.latex),action('使用这份结果',async()=>{await perform(value=>reviseFormula(value.id,{latex:candidate.latex,segments:revision.segments},value.revision),'已恢复公式与对应原图。');dialog.close();dialog.remove();})));}
 for(const explanation of [...record.explanations].reverse().filter(e=>e.stale))body.append(h('article',{class:'yd-notebook-object'},h('small',{},`以前的讲解 · ${new Date(explanation.createdAt).toLocaleString()}`),renderMarkdown(explanation.text)));
 if(body.children.length===1)body.append(h('p',{},'还没有以前的结果。'));
 const dialog=formulaDialog('编辑记录',body);
}
function render():void{
 if(!host)return;host.classList.remove('is-expanded');host.replaceChildren();requestHost=null;requestStatus=null;
 host.append(objectNavigationBar());statusHost=h('p',{class:'yd-status',role:'status','aria-live':'polite'},statusText);
 if(!documentId){host.append(h('div',{class:'yd-object-heading'},h('h2',{},'先打开一篇论文'),h('p',{},'在正文框住公式，就可以讲解或复制。')));return;}
 if(!current){host.append(h('div',{class:'yd-object-heading'},h('h2',{},'读懂一个公式'),h('p',{},'在正文框住公式，松开即可打开。')),action('框选公式',()=>startFormulaCrop(false),true));return;}
 const record=current;const index=formulas.findIndex(item=>item.id===record.id);if(index<0)formulas.push(record);else formulas[index]=record;
 const content=h('div',{class:'yd-object-content'}),images=h('div',{class:'yd-object-images'},...record.segments.map(original));
 const remove=action('删除',async()=>{await setFormulaDeleted(record.id,true,record.revision);const id=record.id;current=null;activeId='';formulas=formulas.filter(f=>f.id!==id);notifyNotebook();closeObjectView();toastUndo('公式已移到笔记回收站',async()=>{const latest=await loadFormula(id);if(!latest)throw new Error('公式暂未读到');await setFormulaDeleted(id,false,latest.revision);notifyNotebook();});});remove.setAttribute('aria-label','删除当前公式');
 content.append(h('div',{class:'yd-object-heading'},h('small',{},`公式 · 第 ${[...new Set(record.segments.map(s=>s.pageIndex+1))].join('、')} 页`),h('div',{class:'ml-row'},h('h2',{},'读懂这个公式'),remove)),images,action('＋ 公式跨页？补框下一页',()=>startFormulaCrop(true)));
 const latest=[...record.explanations].reverse().find(e=>!e.stale),actions=h('div',{class:'yd-object-actions'});
 if(!latest)actions.append(action('讲解这个公式',()=>prepareAi('explain'),true));
 const copy=action('复制公式',copyFormulaIntent);copy.dataset.copyFormula='true';actions.append(copy);content.append(actions);
 const feedback=h('div',{class:'yd-formula-copy-feedback',role:'status',dataset:{copyFeedback:'true'}});content.append(feedback);
 if(record.latex)content.append(h('div',{class:'ml-row'},h('small',{class:'ml-muted'},record.checkedByUser?'已对照原图检查':'LaTeX 已提取 · 请检查上下标'),action('检查 / 修改',editFormula)));
 else content.append(h('small',{class:'ml-muted'},'首次复制会使用 Flash 提取公式，之后直接复制。'));
 requestHost=h('section',{class:'yd-formula-request','aria-label':'当前公式任务'});content.append(statusHost,requestHost);
 if(latest){const revision=record.history.find(r=>r.id===latest.sourceRevisionId),sources=revision?.segments.map((s,i)=>({id:`E${i+1}`,pageIndices:[s.pageIndex]}))??[];
 const answer=renderMarkdown(latest.text,{evidenceSources:sources,onEvidenceCite:id=>{const s=revision?.segments[Number(id.slice(1))-1];if(s)void returnToEvidenceSource({id:s.segmentId,docId:documentId,kind:'image',label:'公式原图',pageIndices:[s.pageIndex],sourceQuads:[{pageIndex:s.pageIndex,quads:[s.quad]}]}).catch(error=>message(String(error),true));}});
 content.append(h('section',{class:'yd-object-answer'},h('small',{class:'ml-muted'},'基于原图与附近正文 · 已保存'),answer),action('重新讲解',()=>prepareAi('explain')));
 }else content.append(h('p',{class:'yd-formula-next'},'直接讲解公式含义与符号作用，无需先识别。'));
 const hasHistory=record.history.length>1||record.candidates.length>0||record.explanations.some(e=>e.stale);if(hasHistory)content.append(action('编辑记录',showFormulaHistory));
 host.append(content);
 const input=h('textarea',{rows:2,placeholder:'问问这个公式…','aria-label':'公式追问',value:contextByFormula.get(record.id)??'',disabled:busy});input.oninput=()=>contextByFormula.set(record.id,input.value);
 const follow=async()=>{if(busy||!input.value.trim())return;contextText=input.value.trim().slice(0,1200);contextByFormula.set(record.id,'');await prepareAi('explain',latest?.id);};
 const send=action('发送 ↑',follow,true);input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();void follow().catch(error=>message(String(error),true));}};
 if(latest)host.append(h('div',{class:'yd-object-composer'},h('small',{class:'yd-chat-context'},`当前公式 · 第 ${record.segments[0].pageIndex+1} 页`),input,h('div',{class:'ml-row'},h('small',{class:'ml-muted'},'图片 · Flash'),send)));
 notifyNotebook();
}

async function prepareAi(actionType:'recognize'|'explain',explanationId?:string):Promise<void>{
  const record=current;if(!record||!service||busy||!matches())return;
  if(!isConfigured(state.settings)){void chrome.tabs.create({url:chrome.runtime.getURL('welcome/index.html')+'?returnTo='+encodeURIComponent(location.href)});return;}
  if(!await ensureReaderAiAccess(documentId))throw new Error('本篇已关闭AI，可在阅读设置中开启');if(dirty)throw new Error('请先保存或撤销手改；准备请求不会覆盖修改');
  const explanation=explanationId?record.explanations.find(item=>item.id===explanationId):undefined;
  const source=explanation?record.history.find(item=>item.id===explanation.sourceRevisionId):record;
  if(!source)throw new Error('解释来源修订不可用，未准备不完整请求');
  const sourceRevisionId=explanation?.sourceRevisionId??record.sourceRevisionId;
  const version=generation,docId=documentId,requestVersion=++preparation;prepared=null;
  const imageItems=await Promise.all(source.segments.map(async(segment,index)=>({id:segment.segmentId,label:`公式原图 ${index+1} · PDF ${segment.pageIndex+1}`,image:await imageFor(segment),pageIndex:segment.pageIndex,assetId:segment.assetId,assetVersion:segment.assetVersion,sourceQuads:[{pageIndex:segment.pageIndex,quads:[segment.quad]}]})));
  if(!matches(docId,version)||requestVersion!==preparation)return;
  const session=requestSessionGeneration();if(session===null)throw new Error('文献会话已关闭');
  const request=await service.prepare({docId,sessionGeneration:session,sourceRevision:sourceRevisionId,images:imageItems,action:actionType,latex:source.latex,
    context:[state.docText?.pages.filter(page=>source.segments.some(s=>s.pageIndex===page.pageIndex)).map(page=>page.text.slice(0,900)).join('\n').slice(0,1800),contextText].filter(Boolean).join('\n').slice(0,3000),evidence:[],previousExplanation:explanation?.text.slice(-2800)});
  if(!matches(docId,version)||requestVersion!==preparation)return;
  prepared=request;binding={formulaId:record.id,sourceRevisionId,expectedRevision:record.revision,action:actionType,source:{latex:source.latex,segments:structuredClone(source.segments)},previousExplanationId:explanationId};
  renderPrepared(request);
  if(request.policy==='allowed_to_configured_provider'&&!request.imageBlockReason)await sendPrepared();
}
function renderPrepared(value:PreparedDocument):void{
 if(!requestHost)return;requestHost.replaceChildren();requestStatus=h('p',{class:'yd-status',role:'status'},value.imageBlockReason??(binding?.action==='recognize'?'正在提取公式…':'正在讲解公式…'));requestHost.append(requestStatus);if(value.imageBlockReason)requestHost.append(action('配置图片模型',()=>{void chrome.runtime.sendMessage({type:'open-options'});}));
}
async function sendPrepared():Promise<void>{
  const request=prepared,requestBinding=binding,adapter=service;if(!request||!requestBinding||!adapter||busy||!matches())return;
  const docId=documentId,version=generation;
  const latest=await loadFormula(requestBinding.formulaId);
  if(!latest||!matches(docId,version))return;
  if(request.request.sourceRevision!==requestBinding.sourceRevisionId||latest.sourceRevisionId!==current?.sourceRevisionId||latest.revision!==requestBinding.expectedRevision||dirty){prepared=null;message('源码或原图修订已改变；请重新准备，未发送。',true);requestHost?.replaceChildren();return;}
  if(busy)return;const abort=new AbortController();controller=abort;busy=true;
  host?.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement>('input,textarea,select,button').forEach(control=>control.disabled=true);
  let rawResponse='';
  const cancel=action('取消进行中的请求',()=>abort.abort());cancel.disabled=false;requestHost?.append(cancel);if(requestStatus)requestStatus.textContent='请求进行中；取消、错误或超时均不会自动补发。';
  try{
    const response=await adapter.send(request,authorizeExplicitSend(request.request),{signal:abort.signal});rawResponse=response.text;
    if(!matches(docId,version))return;
    if(requestBinding.action==='recognize'){
      if(!response.candidate){if(requestStatus)requestStatus.textContent=response.recognitionWarning??'没有有效候选；原始响应显示在下方，可复制保留，不自动补发。';requestHost?.append(h('pre',{class:'yd-formula-raw'},response.text));return;}
      await saveFormulaCandidate(requestBinding.formulaId,{latex:response.candidate.latex,warnings:response.candidate.warnings,model:request.request.model,snapshotHash:request.request.snapshotHash},requestBinding.expectedRevision);
      const updated=await loadFormula(requestBinding.formulaId);if(!updated)throw new Error('候选已保存，但公式读取失败');
      if(!matches(docId,version))return;current=updated;
      if(!updated.latex.trim()&&updated.sourceRevisionId===requestBinding.sourceRevisionId)current=await reviseFormula(updated.id,{latex:response.candidate.latex},updated.revision);
      if(!matches(docId,version))return;sourceText=current.latex;dirty=false;message('识别完成 · 请对照原图核对');
    }else{
      await saveFormulaExplanation(requestBinding.formulaId,{text:response.text,sourceRevisionId:requestBinding.sourceRevisionId,model:request.request.model,requestId:request.request.id});
      const updated=await loadFormula(requestBinding.formulaId);if(!updated)throw new Error('解释已保存，但公式读取失败');
      if(!matches(docId,version))return;current=updated;sourceText=updated.latex;dirty=false;message('解释已保存，可对照上方原图查看。');
    }
    prepared=null;binding=null;
  }catch(error){if(matches(docId,version)){message(error instanceof Error?error.message:'请求未完成；无自动重试',true);if(requestStatus)requestStatus.textContent='未改写当前源码。若版本冲突，先复制下面的未应用响应，再刷新公式版本。';if(rawResponse){requestHost?.append(h('pre',{class:'yd-formula-raw'},rawResponse),action('复制未应用响应',async()=>{await navigator.clipboard.writeText(rawResponse);message('已复制响应；公式源码未改变。');}));}}}
  finally{if(matches(docId,version)){busy=false;controller=null;if(!prepared)render();else{host?.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement>('input,textarea,select,button').forEach(control=>control.disabled=false);if(requestHost)requestHost.querySelector<HTMLButtonElement>('[data-send-formula]')?.setAttribute('disabled','');}}}
}
