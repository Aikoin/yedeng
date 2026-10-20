/** Reader-first AI actions: direct intent, one output, bounded context and durable request claims. */
import { prepareDocumentContext, type DocumentAction, type DocumentContext, type DocumentSource } from '../ai/documentContext';
import { productionDispatcher, ensureReaderAiAccess, setDocumentAiPolicy } from '../ai/dispatcher';
import { authorizeExplicitSend, supportsThinkingToggle } from '../ai/preparedRequest';
import { h, qs } from '../shared/dom';
import { idbGet, idbPut, type ChatRecord } from '../shared/idb';
import { isConfigured, loadSettings, saveSettings, type FeatureKey } from '../shared/settings';
import { toast } from '../shared/toast';
import { persistDocumentChatTurn } from '../shared/documentChat';
import type { Section } from '../pdf/extract';
import { sha256Hex } from '../shared/hash';
import { renderMarkdown } from './markdown';
import { jumpToPage, rebuildIndex, state } from './state';
import { search } from '../pdf/bm25';
import { requestSessionGeneration } from './requestWorkspace';
import { openDocumentSource } from './documentSources';
import { parseOverview } from '../ai/overview';

const dispatcher = productionDispatcher(() => ({ docId: state.docId, sessionGeneration: requestSessionGeneration() }));
interface StoredAnswer extends ChatRecord { sources?: DocumentSource[]; sourceRevision?: string }
let epoch = 0, registered = false;
let job: { docId: string; viewer: object; epoch: number; controller: AbortController; output?: HTMLElement } | null = null;
let history: { role: 'user' | 'assistant'; content: string; at: number; sources?: DocumentSource[] }[] = [];
const featureFor = (action: DocumentAction): FeatureKey => action === 'overview' ? 'summary' : action === 'sectionBatch' ? 'sectionSummary' : action;
const keyFor = (action: DocumentAction, index?: number) => `${state.docId}:g4-${action === 'sectionSummary' ? `section:${index}` : action}`;

export function resetAiPanels(): void {
  document.querySelector('.yd-source-peek')?.remove();
  epoch++; job?.controller.abort(); job = null; history = []; dispatcher.invalidate('已切换论文');
  for (const id of ['summary-body','keywords-body','section-list','chat-log']) document.getElementById(id)?.replaceChildren();
}
export function initAiPanels(): void {
  qs('#btn-setup-ai').onclick = () => { void chrome.tabs.create({ url: chrome.runtime.getURL('welcome/index.html')+'?returnTo='+encodeURIComponent(location.href) }); };
  qs('#btn-summary-regen').textContent = '重新生成';
  qs('#btn-sections-all').hidden = true;
  qs('#btn-summary-regen').onclick = () => void run('overview', undefined, undefined, true);
  qs('#btn-sections-stop').onclick = () => job?.controller.abort();
  qs('#btn-chat-send').textContent = '发送 ↑';
  qs('#btn-chat-send').onclick = () => void run('chat');
  qs('#btn-chat-stop').onclick = () => job?.controller.abort();
  qs('#btn-chat-clear').onclick = () => void clearChat();
  qs<HTMLTextAreaElement>('#chat-input').onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void run('chat'); }
  };
  qs<HTMLSelectElement>('#model-select').onchange = event => {
    const value = (event.target as HTMLSelectElement).value;
    if (value === '__settings__') { void chrome.runtime.sendMessage({ type: 'open-options' }); return; }
    const [providerId, ...parts] = value.split('::');
    void (async () => { try {
      const settings = await loadSettings();
      for (const feature of ['chat','explain','translate','summary','sectionSummary','keywords'] as const) settings.routing[feature] = { providerId, model: parts.join('::') };
      await saveSettings(settings); state.settings = await loadSettings(); dispatcher.invalidate('模型已切换'); toast('文字模型已切换', 'success');
    } catch(error) { toast(String(error), 'error'); } })();
  };
  const auto = document.querySelector<HTMLInputElement>('#auto-overview');
  if (auto) auto.onchange = () => { void (async () => { const settings=await loadSettings();settings.reading={autoOverview:auto.checked};await saveSettings(settings);state.settings=settings; })().catch(error=>toast(String(error),'error')); };
  const docAi = document.querySelector<HTMLInputElement>('#document-ai-enabled');
  if (docAi) docAi.onchange = () => { const docId=state.docId; if(!docId)return;void setDocumentAiPolicy(docId,docAi.checked?'allowed_to_configured_provider':'deny_all_ai').then(()=>{dispatcher.invalidate('本篇AI设置已改变');const channel=new BroadcastChannel('yedeng-document-ai-policy');channel.postMessage({docId});channel.close();}).catch(error=>toast(String(error),'error')); };
  dispatcher.subscribe(() => { epoch++;const previous=job;previous?.controller.abort();if(previous?.output)previous.output.textContent='任务已暂停，可点击重新生成或重新发送。';document.querySelectorAll('.yd-inline-progress').forEach(e=>e.remove());job=null;setChatBusy(false); });
  if (!registered) {
    registered=true;
    chrome.runtime.onMessage.addListener((m:{type?:string})=>{if(m?.type==='settings-changed')dispatcher.invalidate('配置变化');});
    chrome.storage?.onChanged?.addListener((changes,area)=>{if(area==='local'&&'settings.v1' in changes)dispatcher.invalidate('配置变化');});
    if(typeof BroadcastChannel!=='undefined'){const c=new BroadcastChannel('yedeng-document-ai-policy');c.onmessage=()=>dispatcher.invalidate('文献设置变化');}
  }
  renderModelSelect();renderChat();
}
export function renderModelSelect():void {
  const select=qs<HTMLSelectElement>('#model-select');select.replaceChildren();select.setAttribute('aria-label','文字任务模型');select.title='文字任务使用此模型；图片自动使用视觉路由';
  qs('#btn-setup-ai').hidden=isConfigured(state.settings);
  const route=state.settings.routing.chat;
  for(const p of state.settings.providers.filter(p=>p.baseUrl&&p.apiKey)) for(const model of p.models.length?p.models:[p.defaultModel]) if(model)select.append(h('option',{value:`${p.id}::${model}`,selected:route?.providerId===p.id&&route.model===model},`${p.name} · ${model}`));
  select.append(h('option',{value:'__settings__'},'管理模型…'));
  const auto=document.querySelector<HTMLInputElement>('#auto-overview');if(auto)auto.checked=state.settings.reading?.autoOverview!==false;
}
function sourceDetails(sources:DocumentSource[],coverage?:string):HTMLElement {
  const details=h('details',{class:'yd-answer-sources'},h('summary',{},'来源与范围'));
  if(coverage)details.append(h('p',{class:'ml-muted'},coverage));
  for(const s of sources){const b=h('button',{class:'ghost'},`原文 · 第 ${s.pageIndices.map(p=>p+1).join('、')} 页`);b.onclick=()=>void openDocumentSource(s);details.append(b);}
  return details;
}
function showAnswer(output:HTMLElement,text:string,sources:DocumentSource[]):void {
  sources=sources.map(source=>({...source,pageIndices:source.pageIndices.filter(page=>Number.isSafeInteger(page)&&page>=0&&page<state.info.numPages)})).filter(source=>source.pageIndices.length>0);
  const pages=[...new Set(sources.flatMap(s=>s.pageIndices))];
  output.replaceChildren(renderMarkdown(text,{validPageIndices:pages,evidenceSources:sources,onEvidenceCite:id=>{const s=sources.find(s=>s.id===id);if(s)void openDocumentSource(s);},onCite:p=>{if(pages.includes(p))jumpToPage(p);}}));
  if(sources.length)output.append(sourceDetails(sources));
}
function showOverview(text:string,sources:DocumentSource[]):void {
  const value=parseOverview(text);showAnswer(qs('#summary-body'),value.summary,sources);
  qs('#keywords-body').replaceChildren(...value.keywords.map(word=>h('span',{class:'yd-keyword'},word)));
}
async function restore(key:string,output:HTMLElement|null,docId:string,viewer:object|null,version:number):Promise<boolean>{
  try{const saved=await idbGet('chats',key) as StoredAnswer|undefined;
    if(state.docId!==docId||state.viewer!==viewer||epoch!==version||!saved?.messages[0]?.content)return false;
    if(output)showAnswer(output,saved.messages[0].content,saved.sources??[]);else showOverview(saved.messages[0].content,saved.sources??[]);return true;
  }catch{return false;}
}
export function onTextExtracted():void {
  rebuildIndex();renderModelSelect();const docId=state.docId,viewer=state.viewer,version=++epoch;
  qs('#summary-body').textContent=isConfigured(state.settings)?'正在整理这篇论文…':'连接 AI 服务后，自动生成摘要与关键词。';
  qs('#keywords-body').textContent='';const host=qs('#section-list');host.replaceChildren();
  const sections=state.docText?.sections.filter(s=>s.text.trim().length>120)??[];
  if(!sections.length)host.textContent='未检测到章节目录。';
  sections.forEach((section,index)=>{
    const body=h('div',{class:'ml-section-item__body',id:`document-section-${index}`});
    const toggle=h('button',{class:'yd-section-toggle','aria-expanded':'false'},h('span',{},section.title),h('small',{},`P${section.pageIndex+1}  ›`));
    const card=h('section',{class:'yd-section-card'},toggle,body);body.hidden=true;
    toggle.onclick=()=>{body.hidden=!body.hidden;toggle.setAttribute('aria-expanded',String(!body.hidden));if(!body.hidden&&!body.textContent)void run('sectionSummary',section,index);};host.append(card);
    void restore(`${docId}:g4-section:${index}`,body,docId,viewer,version);
  });
  void(async()=>{
    const stored=await idbGet('docs',docId);if(state.docId!==docId||state.viewer!==viewer||epoch!==version)return;
    const toggle=document.querySelector<HTMLInputElement>('#document-ai-enabled');if(toggle)toggle.checked=stored?.policy!=='deny_all_ai';
    const overview=await restore(`${docId}:g4-overview`,null,docId,viewer,version);
    if(!overview){const old=await Promise.all([restore(`${docId}:g4-summary`,qs<HTMLElement>('#summary-body'),docId,viewer,version),restore(`${docId}:g4-keywords`,qs<HTMLElement>('#keywords-body'),docId,viewer,version)]);
      if(state.docId!==docId||state.viewer!==viewer||epoch!==version)return;
      if(state.settings.reading?.autoOverview!==false&&isConfigured(state.settings)&&stored?.policy!=='deny_all_ai')await run('overview');
      else if(!old[0])qs('#summary-body').textContent=stored?.policy==='deny_all_ai'?'本篇已关闭 AI，可在下方阅读设置中开启。':!isConfigured(state.settings)?'连接 AI 服务后，自动生成摘要与关键词。':'自动概览已关闭，点击“重新生成”查看摘要。';
    }
    if(state.docId!==docId||state.viewer!==viewer||epoch!==version)return;
    const saved=await idbGet('chats',`${docId}:chat`);if(state.docId!==docId||state.viewer!==viewer||epoch!==version)return;
    history=saved?.messages.filter(m=>!m.error).map(m=>({...m,role:m.role as 'user'|'assistant'}))??[];renderChat();
  })().catch(error=>{if(state.docId===docId)qs('#summary-body').textContent=String(error);});
}
function renderChat():void {
  const log=qs('#chat-log');log.replaceChildren();
  if(!history.length){const empty=h('div',{class:'yd-chat-empty'},h('span',{class:'yd-chat-orbit'},'✧'),h('h3',{},'从一个问题开始'),h('p',{},'结合这篇论文，聊聊你想弄懂的地方。'));
    for(const text of ['这篇论文最重要的发现是什么？','方法有哪些局限？']){const b=h('button',{class:'yd-suggestion'},text);b.onclick=()=>{qs<HTMLTextAreaElement>('#chat-input').value=text;qs('#chat-input').focus();};empty.append(b);}log.append(empty);
  }
  for(const message of history){const bubble=h('article',{class:`ml-bubble ml-bubble--${message.role==='user'?'user':'ai'}`});if(message.role==='user')bubble.textContent=message.content;else showAnswer(bubble,message.content,message.sources??[]);log.append(bubble);}
  log.scrollTop=log.scrollHeight;
}
function setChatBusy(value:boolean):void {qs<HTMLButtonElement>('#btn-chat-send').disabled=value;qs('#btn-chat-send').hidden=value;qs('#btn-chat-stop').classList.toggle('ml-hidden',!value);}
async function run(action:DocumentAction,section?:Section,index?:number,force=false):Promise<void>{
  if(job&&action==='chat'){epoch++;job.controller.abort();if(job.output)job.output.textContent='概览已暂停，可稍后重新生成。';job=null;}
  if(job){toast('正在处理当前任务，可以先取消','info');return;}
  const docId=state.docId,viewer=state.viewer,doc=state.docText;if(!docId||!viewer||!doc){toast('请先打开论文','info');return;}
  if(!isConfigured(state.settings)){void chrome.tabs.create({url:chrome.runtime.getURL('welcome/index.html')+'?returnTo='+encodeURIComponent(location.href)});return;}
  const question=action==='chat'?qs<HTMLTextAreaElement>('#chat-input').value.trim():'';if(action==='chat'&&!question)return;
  const owned:{docId:string;viewer:object;epoch:number;controller:AbortController;output?:HTMLElement}={docId,viewer,epoch,controller:new AbortController()};job=owned;const current=()=>job===owned&&state.docId===docId&&state.viewer===viewer&&epoch===owned.epoch;
  const output=action==='overview'?qs('#summary-body'):action==='keywords'?qs('#keywords-body'):action==='sectionSummary'?qs(`#document-section-${index}`):qs('#chat-log');
  let reply:HTMLElement=output;
  if(action==='chat'){qs('#chat-log .yd-chat-empty')?.remove();qs('#chat-log').append(h('article',{class:'ml-bubble ml-bubble--user'},question));reply=h('article',{class:'ml-bubble ml-bubble--ai'},'正在阅读相关段落…');output.append(reply);setChatBusy(true);}
  else output.textContent='正在阅读与整理…';
  owned.output=reply;
  const progress=h('div',{class:'yd-inline-progress'},h('span',{class:'ml-spinner'}),h('span',{},'生成中'),h('button',{class:'ghost'},'取消'));
  progress.querySelector('button')!.onclick=()=>owned.controller.abort();if(action!=='chat')output.before(progress);
  let context:DocumentContext|undefined;
  try{
    if(!await ensureReaderAiAccess(docId))throw new Error('本篇已关闭 AI，请在阅读设置中开启');if(!current())return;
    const hits=action==='chat'&&state.index?search(state.index,question+' '+(history.filter(m=>m.role==='user').at(-1)?.content.slice(0,300)??''),6).filter(hit=>hit.score>0).map(hit=>hit.chunk):[];
    context=prepareDocumentContext({action,question,title:state.info.title,doc,totalPages:state.info.numPages,section,hits:hits.length?hits:state.chunks.slice(0,2),retrievalMatched:hits.length>0,history,custom:[state.settings.prompts[featureFor(action)],state.settings.prompts.custom].filter(Boolean).join('\n')});
    const revision=await sha256Hex(new TextEncoder().encode(JSON.stringify(context.messages)).buffer);
    const scope={type:'document_action' as const,action:`document_${action}`,feature:featureFor(action),docId,sessionGeneration:requestSessionGeneration(),sourceRevision:revision,resultSources:context.sources};
    let prepared=await dispatcher.prepare(scope,context.messages,{maxTokens:action==='overview'?1200:1600,temperature:.2});
    if(supportsThinkingToggle(prepared.request.endpoint,prepared.request.model))prepared=await dispatcher.prepare(scope,context.messages,{maxTokens:action==='overview'?1200:1600,temperature:.2,thinking:'disabled'});
    if(!current())return;
    let text='';const result=await dispatcher.send(prepared,authorizeExplicitSend(prepared.request),{force,signal:owned.controller.signal,onDelta:delta=>{if(!current())return;text+=delta;if(action!=='overview')reply.textContent=text;}});
    if(!current())return;
    if(action==='overview')showOverview(result.text,context.sources);else showAnswer(reply,result.text,context.sources);
    if(action==='chat'){
      const at=Date.now();history.push({role:'user',content:question,at},{role:'assistant',content:result.text,at,sources:context.sources});
      if(qs<HTMLTextAreaElement>('#chat-input').value.trim()===question)qs<HTMLTextAreaElement>('#chat-input').value='';
      if(state.settings.cache.enabled){const merged=await persistDocumentChatTurn(docId,{id:prepared.request.id,question,answer:result.text,at,sources:context.sources});if(current()){history=merged;renderChat();}}
    }else if(state.settings.cache.enabled)await idbPut('chats',{key:keyFor(action,index),docId,messages:[{role:'assistant',content:result.text,at:Date.now()}],sources:context.sources,sourceRevision:revision,updatedAt:Date.now()} as StoredAnswer);
    if(current()&&result.storageWarning)reply.append(h('small',{class:'ml-muted'},result.storageWarning));
  }catch(error){if(current()){
    reply.replaceChildren(h('p',{class:'yd-status'},owned.controller.signal.aborted?'已取消，未自动重试。':error instanceof Error?error.message:String(error)));
    const retry=h('button',{class:'ghost'},'重试');retry.onclick=()=>void run(action,section,index,true);reply.append(retry);
  }}finally{progress.remove();if(job===owned){job=null;setChatBusy(false);}}
}
async function clearChat():Promise<void>{
  if(job){toast('先取消当前回答','info');return;}if(!state.docId)return;
  if(history.length&&!window.confirm('清空这篇论文的本地对话？'))return;
  const docId=state.docId;await idbPut('chats',{key:`${docId}:chat`,docId,messages:[],updatedAt:Date.now()});if(state.docId===docId){history=[];renderChat();}
}
