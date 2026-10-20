import {openObjectView,closeObjectView,objectNavigationBar,notifyNotebook} from './assistantNavigation';
/** Local region assets, references and editable evidence draft. Preparing material never sends it. */
import './evidenceWorkspace.css';
import { createRegionAsset, loadRegionAssets, loadRemovedRegionAssets, loadReferences, changeReferences, setRegionDeleted, blobDataUrl } from '../evidence/repository';
import { ReferenceLimitError, type ReferenceAction, type ReferenceState } from '../evidence/referenceModel';
import { immutableEvidence, type EvidenceAttachment } from '../evidence/types';
import type { PdfQuad } from '../pdf/geometry';
import type { SelectionSnapshot } from '../pdf/selectionModel';
import type { Box } from '../pdf/anchor';
import type { RegionRecord } from '../shared/idb';
import { h, qs } from '../shared/dom';
import { toastError,toastUndo } from '../shared/toast';
import { state } from './state';

let host: HTMLElement | null = null;
let selectedAssetId='';
let assets: RegionRecord[] = [];
let removedAssets:RegionRecord[]=[];
let references: ReferenceState = { pinnedAssetIds: [], activeAssetId: null };
let materials: EvidenceAttachment[] = [];
let images = new Map<string, string>();
let documentId = '', mode = false, loadVersion = 0;
let replaceAsset: string | null = null;
type RegionIntent='figure'|'formula-new'|'formula-append';
let regionIntent:RegionIntent='figure';
let overlay: HTMLElement | null = null;
interface RegionDraft { docId:string;viewer:NonNullable<typeof state.viewer>;pageIndex:number;quad:PdfQuad;preview?:string;caption?:string;kind?:RegionRecord['kind'] }
let pendingRegion:RegionDraft|null=null;
const returnStack: { docId: string; viewer: NonNullable<typeof state.viewer>; pageIndex: number; ratio: number }[] = [];
let actionVersion = 0;
let lastRemoved:RegionRecord|null=null;
let savingDraft: object | null = null;
let regionSaveError='';

function button(label: string, action: () => void | Promise<void>, className = 'ghost'): HTMLButtonElement {
  return h('button', { class: className, on: { click: () => { try { Promise.resolve(action()).catch(toastError); } catch (error) { toastError(error); } } } }, label);
}
function sameSession(docId: string, viewer: typeof state.viewer): boolean { return !!docId && state.docId === docId && state.viewer === viewer && documentId === docId; }
export function getPreparedEvidenceSnapshot(): readonly EvidenceAttachment[] { return immutableEvidence(materials); }
export function initEvidenceWorkspace(element: HTMLElement): void {
  host = element;
  // Keep the already captured immutable text selection when clicking evidence controls.
  host.addEventListener('mousedown', event => event.stopPropagation());
  qs('#scroller').addEventListener('pointerdown', beginRegion, { capture: true });
  qs('#scroller').addEventListener('scroll', syncRegionOverlay, { passive: true });
  window.addEventListener('resize', syncRegionOverlay);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && (mode || pendingRegion)) cancelRegion(); });
  const regionButton=qs<HTMLButtonElement>('#btn-region-select');regionButton.onclick=()=>{try{if(mode&&regionIntent==='figure'){cancelRegion();return;}const sidebar=qs('#sidebar');sidebar.hidden=false;document.body.classList.remove('ml-focus');openObjectView('figures');startRegionSelection();}catch(error){toastError(error);}};
  render();
}
export function resetEvidenceWorkspace(): void {
  selectedAssetId='';loadVersion++; actionVersion++; lastRemoved=null;removedAssets=[]; documentId = ''; assets = []; materials = []; images.clear();
  references = { pinnedAssetIds: [], activeAssetId: null }; replaceAsset = null; returnStack.length = 0; cancelRegion(); render();
}
export async function loadEvidenceWorkspace(): Promise<void> {
  resetEvidenceWorkspace(); const docId = state.docId, viewer = state.viewer, version = ++loadVersion; documentId = docId;
  if (!docId || !viewer) { render(); return; }
  const [loaded, pins,removed] = await Promise.all([loadRegionAssets(docId), loadReferences(docId),loadRemovedRegionAssets(docId)]);
  const decoded = await Promise.all(loaded.flatMap(asset => (asset.segments ?? []).map(async segment => [segment.id, await blobDataUrl(segment.cropBlob)] as const)));
  if (version !== loadVersion || !sameSession(docId, viewer)) return;
  assets = loaded; removedAssets=removed; references = pins; images = new Map(decoded); render();
}
export function startRegionSelection(intent:'figure'|'formula-new'|'formula-append'='figure'): void {
  if (!state.viewer || !state.doc || documentId !== state.docId) throw new Error('请先打开PDF');
  cancelRegion(); regionIntent=intent;qs('#sidebar').hidden=false;document.body.classList.remove('ml-focus');openObjectView(intent==='figure'?'figures':'formulas');mode = true; document.body.classList.add('ml-region-selecting'); render();
}
export function attachSelectionEvidence(snapshot: SelectionSnapshot): readonly EvidenceAttachment[] {
  if (!snapshot.docId || snapshot.docId !== state.docId || documentId !== state.docId || !snapshot.pdfRegions?.length) throw new Error('选区已过期或缺少原文锚点，请重新选择');
  const evidence: EvidenceAttachment = { id: crypto.randomUUID(), docId: state.docId, kind: 'text', label: `文字 · P${snapshot.pageIndex + 1}`,
    pageIndices: snapshot.pdfRegions.map(region => region.pageIndex), text: snapshot.text, sourceQuads: structuredClone(snapshot.pdfRegions) };
  materials.push(evidence); render(); return immutableEvidence([evidence]);
}
function boundingQuad(quads: readonly PdfQuad[]): PdfQuad {
  const points = quads.flat(), xs = points.map(p => p.x), ys = points.map(p => p.y);
  const left = Math.min(...xs), right = Math.max(...xs), bottom = Math.min(...ys), top = Math.max(...ys);
  return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
}
export async function captureSelectionEvidence(snapshot: SelectionSnapshot): Promise<readonly EvidenceAttachment[]> {
  const docId = state.docId, viewer = state.viewer, doc = state.doc;
  if (!doc || !viewer || !snapshot.docId || snapshot.docId !== docId || !snapshot.pdfRegions?.length || documentId !== docId) throw new Error('选区已过期，请重新选择');
  const asset = await createRegionAsset(doc, docId, 'region', snapshot.pdfRegions.map(region => {
    if (!region.quads.length) throw new Error('选区缺少页面坐标');
    return { pageIndex: region.pageIndex, quad: boundingQuad(region.quads) };
  }), snapshot.text, '选中文字的原图');
  if (!sameSession(docId, viewer)) throw new Error('原图已保存到原文献，当前文献已切换，请重新附加');
  assets.push(asset); await decodeAsset(asset); if (!sameSession(docId, viewer)) return [];
  return attachAsset(asset);
}
async function decodeAsset(asset: RegionRecord): Promise<void> {
  for (const segment of asset.segments ?? []) {
    const image = await blobDataUrl(segment.cropBlob);
    if (documentId !== asset.docId || state.docId !== asset.docId) return;
    images.set(segment.id, image);
  }
}
function attachAsset(asset: RegionRecord): readonly EvidenceAttachment[] {
  if (asset.docId !== documentId) throw new Error('不能附加其他文献资源');
  const added = (asset.segments ?? []).map(segment => ({ id: `${asset.id}:${segment.id}`, assetId: asset.id, assetVersion: asset.assetVersion ?? 1,
    docId: asset.docId, kind: 'image' as const, label: `${asset.caption || '区域原图'} · P${segment.pageIndex + 1}`, pageIndices: [segment.pageIndex],
    text: asset.quote || undefined, image: images.get(segment.id), sourceQuads: [{ pageIndex: segment.pageIndex, quads: [structuredClone(segment.quad)] }] }));
  if (added.some(item => !item.image)) throw new Error('原图尚未加载，不能附加不完整材料');
  for (const item of added) if (!materials.some(existing => existing.id === item.id)) materials.push(item);
  render(); return immutableEvidence(added);
}
async function referenceAction(action: ReferenceAction): Promise<void> {
  const docId = documentId, viewer = state.viewer;
  try {
    const updated = await changeReferences(docId, action);
    if (!sameSession(docId, viewer)) return;
    references = updated; replaceAsset = null; render();
  } catch (error) {
    if (error instanceof ReferenceLimitError && action.type === 'pin') { replaceAsset = action.assetId; render(); return; }
    throw error;
  }
}
export async function returnToEvidenceSource(evidence: EvidenceAttachment): Promise<void> {
  if (evidence.docId !== state.docId || !state.viewer) throw new Error('来源不属于当前文献');
  const region = evidence.sourceQuads?.[0]; if (!region?.quads.length) throw new Error('缺少可靠来源锚点');
  const viewer = state.viewer, scroll = qs('#scroller'), docId = state.docId;
  const previousPage = viewer.currentPageIndex();
  const previousBox = viewer.getPageElement(previousPage)?.getBoundingClientRect();
  const previousRatio = previousBox?.height ? Math.max(0, Math.min(1, (scroll.getBoundingClientRect().top - previousBox.top) / previousBox.height)) : 0;
  await viewer.ensurePageRendered(region.pageIndex);
  if (!sameSession(docId, viewer)) return;
  const rect = viewer.annotationRect(region.pageIndex, boundingQuad(region.quads));
  if (!rect) throw new Error('来源页面尚未就绪');
  returnStack.push({ docId, viewer, pageIndex: previousPage, ratio: previousRatio });
  scroll.scrollTo({ top: scroll.scrollTop + rect.top - scroll.getBoundingClientRect().top - 80, behavior: 'instant' });
  const visible = viewer.annotationRect(region.pageIndex, boundingQuad(region.quads)) ?? rect;
  const flash = h('div', { class: 'ml-evidence-source-flash' });
  Object.assign(flash.style, { left: `${visible.left}px`, top: `${visible.top}px`, width: `${visible.width}px`, height: `${visible.height}px` });
  document.body.appendChild(flash); window.setTimeout(() => flash.remove(), 1200); render();
}
export async function backToReading(): Promise<void> {
  const previous = returnStack.pop(); if (!previous || !sameSession(previous.docId, previous.viewer)) return;
  await previous.viewer.ensurePageRendered(previous.pageIndex);
  if (!sameSession(previous.docId, previous.viewer)) return;
  const page = previous.viewer.getPageElement(previous.pageIndex), scroll = qs('#scroller');
  if (page) { const rect = page.getBoundingClientRect(); scroll.scrollTo({ top: scroll.scrollTop + rect.top - scroll.getBoundingClientRect().top + previous.ratio * rect.height, behavior: 'instant' }); }
  render();
}
function assetEvidence(asset: RegionRecord): EvidenceAttachment {
  return { id: asset.id, docId: asset.docId, kind: 'image', label: asset.caption || '区域', pageIndices: (asset.segments ?? []).map(segment => segment.pageIndex),
    sourceQuads: (asset.segments ?? []).map(segment => ({ pageIndex: segment.pageIndex, quads: [segment.quad] })) };
}
export async function openFigureAsset(id:string):Promise<void>{
 if(documentId!==state.docId)return;const asset=assets.find(a=>a.id===id);if(!asset){await reloadFigures();if(!assets.some(a=>a.id===id))throw new Error('图表已删除或暂不可用，请从笔记重新打开');}
 selectedAssetId=id;openObjectView('figures');render();
}
async function reloadFigures():Promise<void>{const docId=documentId,viewer=state.viewer,version=loadVersion;const loaded=await loadRegionAssets(docId),removed=await loadRemovedRegionAssets(docId),pins=await loadReferences(docId);if(version!==loadVersion||!sameSession(docId,viewer))return;assets=loaded;removedAssets=removed;references=pins;for(const asset of loaded)await decodeAsset(asset);render();}
export async function restoreFigureAsset(id:string):Promise<void>{const docId=documentId,viewer=state.viewer;await setRegionDeleted(docId,id,false);if(!sameSession(docId,viewer))return;await reloadFigures();notifyNotebook();}
async function deleteAsset(asset:RegionRecord):Promise<void>{const docId=documentId,viewer=state.viewer;references=await setRegionDeleted(docId,asset.id,true);if(!sameSession(docId,viewer))return;assets=assets.filter(a=>a.id!==asset.id);materials=materials.filter(m=>m.assetId!==asset.id);removedAssets.push(asset);lastRemoved=asset;selectedAssetId='';render();closeObjectView();notifyNotebook();toastUndo('图表已移到笔记回收站',async()=>{await restoreFigureAsset(asset.id);});}
function interpretAsset(asset:RegionRecord):void{const evidence=(asset.segments??[]).map(segment=>({...assetEvidence(asset),id:`${asset.id}:${segment.id}`,assetId:asset.id,assetVersion:asset.assetVersion??1,pageIndices:[segment.pageIndex],image:images.get(segment.id),sourceQuads:[{pageIndex:segment.pageIndex,quads:[segment.quad]}]}));if(!evidence.length||evidence.some(e=>!e.image))throw new Error('原图尚未读到，请重试');window.dispatchEvent(new CustomEvent('yedeng:explain-image',{detail:evidence[0]}));}
function render():void{
 const figureMode=mode&&regionIntent==='figure';const entry=document.querySelector<HTMLButtonElement>('#btn-region-select');if(entry){entry.textContent=figureMode?'取消框选':'框选图表';entry.setAttribute('aria-pressed',String(figureMode));}
 const tray=document.querySelector<HTMLElement>('#pinned-references');if(tray){tray.replaceChildren();const pinned=references.pinnedAssetIds.map(id=>assets.find(a=>a.id===id)).filter((a):a is RegionRecord=>!!a);tray.hidden=!pinned.length;if(pinned.length)tray.append(h('small',{},'置顶参考'));for(const asset of pinned){const segment=asset.segments?.[0],image=segment&&images.get(segment.id);tray.append(h('div',{class:'yd-pin-item'},h('button',{'aria-label':`打开置顶图表 ${asset.caption||''}`,on:{click:()=>void openFigureAsset(asset.id).catch(toastError)}},image?h('img',{src:image,alt:asset.caption||'图表'}):null,h('span',{},asset.caption||`第 ${(segment?.pageIndex??0)+1} 页`)),button('×',()=>referenceAction({type:'unpin',assetId:asset.id}),'ghost')));}}
 if(!host)return;host.replaceChildren();const formulaCrop=regionIntent!=='figure'&&(mode||!!pendingRegion),cropHost=document.querySelector<HTMLElement>('#formula-crop-workspace');if(cropHost){cropHost.replaceChildren();cropHost.hidden=!formulaCrop;}const formulaHost=document.querySelector<HTMLElement>('#formula-workspace');if(formulaHost)formulaHost.hidden=formulaCrop;
 const activeCropHost=formulaCrop&&cropHost?cropHost:host;
 if(mode||pendingRegion){activeCropHost.append(objectNavigationBar(),h('div',{class:'yd-object-heading'},h('h2',{},regionIntent==='figure'?'框选图表':'框选公式'),h('p',{},'在正文拖框，松开即可打开。'),button('取消框选',cancelRegion)));
 if(pendingRegion){activeCropHost.append(h('p',{role:'status'},regionSaveError||'正在保存原图…'));if(regionSaveError)activeCropHost.append(button('重试保存',()=>saveRegionDraft(pendingRegion!,regionIntent),'yd-primary'));}return;}
 host.append(objectNavigationBar());
 if(lastRemoved){const removed=lastRemoved;host.append(h('div',{role:'status'},h('span',{},'图表已移到回收站'),button('撤销删除',async()=>{await restoreFigureAsset(removed.id);lastRemoved=null;await openFigureAsset(removed.id);})));}
 if(replaceAsset){const id=replaceAsset;host.append(h('p',{},'已置顶三张，请选一张替换。'));for(const oldId of references.pinnedAssetIds){const asset=assets.find(a=>a.id===oldId);host.append(button(`替换 ${asset?.caption||'图表'}`,()=>referenceAction({type:'pin',assetId:id,replaceId:oldId})));}host.append(button('保留现有置顶',()=>{replaceAsset=null;render();}));return;}
 const asset=assets.find(a=>a.id===selectedAssetId);
 if(!asset){host.append(h('div',{class:'yd-object-heading'},h('h2',{},'把图表放在手边'),h('p',{},'框选后可讲解或置顶，已保存的图表在笔记里。')),button('框选图表',()=>startRegionSelection(),'yd-primary'));return;}
 const pinned=references.pinnedAssetIds.includes(asset.id),content=h('div',{class:'yd-object-content'},h('div',{class:'yd-object-heading'},h('small',{},`图表 · 第 ${(asset.segments??[]).map(s=>s.pageIndex+1).join('、')} 页`),h('div',{class:'ml-row'},h('h2',{},asset.caption||'图表'),button('删除',()=>deleteAsset(asset)))));
 for(const segment of asset.segments??[]){const image=images.get(segment.id);if(image)content.append(h('div',{class:'yd-object-images'},h('img',{src:image,alt:`图表原图 · 第 ${segment.pageIndex+1} 页`})));}
 if(asset.quote)content.append(h('p',{class:'ml-muted'},asset.quote));
 content.append(h('div',{class:'yd-object-actions'},button('讲解这幅图',()=>interpretAsset(asset),'yd-primary'),button(pinned?'取消置顶':'置顶参考',()=>referenceAction(pinned?{type:'unpin',assetId:asset.id}:{type:'pin',assetId:asset.id})),button('定位原文',()=>returnToEvidenceSource(assetEvidence(asset)))));host.append(content);notifyNotebook();
}

/** Formula crops commit on pointer release. The same draft cannot be saved twice or reopen after cancellation. */
async function saveRegionDraft(draft:RegionDraft,intent:RegionIntent):Promise<void>{
  if(savingDraft===draft)return;
  if(pendingRegion!==draft||!sameSession(draft.docId,draft.viewer)||!state.doc)throw new Error('选区已改变，请重新框选');
  savingDraft=draft;regionSaveError='';const version=actionVersion,doc=state.doc;
  const owned=()=>pendingRegion===draft&&actionVersion===version&&sameSession(draft.docId,draft.viewer);
  render();
  try{
    const asset=await createRegionAsset(doc,draft.docId,intent==='figure'?'figure':'formula',[{pageIndex:draft.pageIndex,quad:draft.quad}],'',draft.caption||(intent==='figure'?`图表 · P${draft.pageIndex+1}`:`公式 · P${draft.pageIndex+1}`));
    if(!owned())return;
    assets.push(asset);await decodeAsset(asset);if(!owned())return;
    cancelRegion();
    if(intent==='figure'){selectedAssetId=asset.id;openObjectView('figures');render();notifyNotebook();}
    else window.dispatchEvent(new CustomEvent('yedeng:formula-region',{detail:{assetId:asset.id,append:intent==='formula-append'}}));
  }catch(error){if(owned()){regionSaveError=error instanceof Error?error.message:'请重试';throw error;}}
  finally{if(savingDraft===draft)savingDraft=null;if(pendingRegion===draft)render();}
}

function cancelRegion():void {mode=false;pendingRegion=null;regionSaveError='';actionVersion++;overlay?.remove();overlay=null;document.body.classList.remove('ml-region-selecting');render();}
function beginRegion(event:PointerEvent):void {
  if(!mode||event.button!==0||!state.viewer)return;
  const page=(event.target as Element).closest<HTMLElement>('.ml-page');if(!page)return;
  event.preventDefault();event.stopImmediatePropagation();window.getSelection()?.removeAllRanges();
  const pageIndex=Number(page.dataset.page),viewer=state.viewer,docId=state.docId,bounds=page.getBoundingClientRect();
  const x=Math.min(bounds.right,Math.max(bounds.left,event.clientX)),y=Math.min(bounds.bottom,Math.max(bounds.top,event.clientY));
  overlay?.remove();overlay=h('div',{class:'ml-region-overlay'});document.body.appendChild(overlay);
  const move=(e:PointerEvent)=>{const right=Math.min(bounds.right,Math.max(bounds.left,e.clientX)),bottom=Math.min(bounds.bottom,Math.max(bounds.top,e.clientY));drawOverlay({left:Math.min(x,right),top:Math.min(y,bottom),width:Math.abs(right-x),height:Math.abs(bottom-y)});};
  const finish=(e:PointerEvent)=>{move(e);document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',finish,true);mode=false;document.body.classList.remove('ml-region-selecting');
    if(!overlay||!sameSession(docId,viewer)){cancelRegion();return;}
    const rect=overlay.getBoundingClientRect(),quad=viewer.selectionQuad(pageIndex,rect);if(!quad||rect.width<4||rect.height<4){cancelRegion();return;}
    pendingRegion={docId,viewer,pageIndex,quad,kind:regionIntent==='figure'?'figure':'formula'};regionSaveError='';
    overlay.remove();overlay=null;void saveRegionDraft(pendingRegion,regionIntent).catch(toastError);};
  document.addEventListener('pointermove',move,true);document.addEventListener('pointerup',finish,true);
}
function drawOverlay(rect:Box):void {if(overlay)Object.assign(overlay.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});}
function syncRegionOverlay():void { if(!pendingRegion||!overlay)return; const rect=pendingRegion.viewer.annotationRect(pendingRegion.pageIndex,pendingRegion.quad); if(rect)drawOverlay(rect); }
