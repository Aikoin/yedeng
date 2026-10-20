/** 高亮与笔记：创建、持久化（IndexedDB）、渲染、侧边栏列表 */
import './annotations.css';
import { openDb, idbDeleteAnnotation, idbUpdateAnnotation, idbGetByIndex, idbPut, type AnnotationRecord, type AnnotationKind } from '../shared/idb';
import { quoteContext, type PageBoxes, type Box, type NormRect } from '../pdf/anchor';
import type { PdfQuad } from '../pdf/geometry';
import type { SelectionSnapshot } from '../pdf/selectionModel';
import { h, qs, clear } from '../shared/dom';
import { t } from '../shared/i18n';
import { toast, toastError, toastUndo } from '../shared/toast';
import { jumpToPage, state } from './state';

let latestLoad = 0;
const pendingDeletes = new Set<string>();
/** Keep unsaved editor text across list refreshes; never export it as committed data. */
const noteDrafts = new Map<string, string>();
const noteConflicts = new Set<string>();

function activeAnnotation(id: string): AnnotationRecord {
  const record = state.annotations.find(annotation => annotation.id === id && annotation.docId === state.docId);
  if (!record) throw new Error('当前文献中已找不到这条批注，请返回原文献或刷新批注列表');
  return record;
}

export async function loadAnnotations(): Promise<void> {
  if (!state.docId) return;
  const docId = state.docId;
  const viewer = state.viewer;
  const load = ++latestLoad;
  const annotations = await idbGetByIndex('annotations', 'byDoc', docId);
  if (state.docId !== docId || state.viewer !== viewer || load !== latestLoad) return;
  state.annotations = annotations;
  renderAllAnnotations();
  renderAnnotationLists();
}

export function annotationPages(annotation: AnnotationRecord): number[] {
  return annotation.anchor?.coordinateSpace === 'pdf-user-space'
    ? annotation.anchor.regions.map(region => region.pageIndex) : [annotation.pageIndex];
}

export async function addAnnotation(
  kind: AnnotationKind,
  pageBoxes: PageBoxes[],
  quote: string,
  color: 1 | 2 | 3,
  note?: string,
  snapshot?: SelectionSnapshot,
): Promise<AnnotationRecord | null> {
  if (!state.docId || pageBoxes.length === 0) return null;
  const regions = snapshot?.pdfRegions;
  if (!regions || regions.length !== pageBoxes.length || pageBoxes.some(page => {
    const region = regions.find(candidate => candidate.pageIndex === page.pageIndex);
    return !region || region.quads.length !== page.rects.length || region.quads.some(quad =>
      quad.length !== 4 || quad.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y)));
  })) {
    throw new Error('无法保存可靠的页面锚点，请等待页面渲染完成后重新选择');
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  const docId = state.docId;
  const viewer = state.viewer;
  const contextText = pageBoxes.map(page => state.docText?.pages[page.pageIndex]?.text ?? '').join(' ');
  const context = quoteContext(contextText, quote);
  const record: AnnotationRecord = {
    id, logicalId: id, revision: 1, docId, kind, color,
    pageIndex: pageBoxes[0].pageIndex, rects: pageBoxes[0].rects.map(rect => ({ ...rect })),
    quote, ...context, note, createdAt: now, updatedAt: now,
    anchor: { coordinateSpace: 'pdf-user-space', status: 'captured', regions: regions.map(region => ({
      pageIndex: region.pageIndex, quads: region.quads.map(quad => quad.map(point => ({ ...point })) as unknown as typeof quad),
    })) },
  };
  await idbPut('annotations', record);
  if (state.docId === docId && state.viewer === viewer) {
    state.annotations.push(record);
    for (const pageIndex of annotationPages(record)) renderPageAnnotations(pageIndex);
    renderAnnotationLists();
    state.lastColor = color;
  }
  else return null; // Persisted in the old document; do not open a note card in the new session.
  return record;
}

export async function deleteAnnotation(id: string): Promise<void> {
  const docId = state.docId;
  const viewer = state.viewer;
  const record = activeAnnotation(id);
  if (pendingDeletes.has(id)) throw new Error('正在删除这条批注，请等待完成');
  pendingDeletes.add(id);
  try { await idbDeleteAnnotation(id, docId, record.revision ?? 0); }
  finally { pendingDeletes.delete(id); }
  if (state.docId !== docId || state.viewer !== viewer) throw new Error('批注已从原文献删除，当前阅读会话已切换');
  noteDrafts.delete(id);
  noteConflicts.delete(id);
  state.annotations = state.annotations.filter(a => a.id !== id);
  for (const pageIndex of record ? annotationPages(record) : []) renderPageAnnotations(pageIndex);
  renderAnnotationLists();
  toastUndo('已删除标注',async()=>{const db=await openDb();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('annotations','readwrite');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('恢复未完成'));tx.onerror=()=>reject(tx.error);tx.objectStore('annotations').add({...record,revision:(record.revision??0)+1,updatedAt:Date.now()});});if(state.docId===docId&&state.viewer===viewer)await loadAnnotations();});
}

async function updateAnnotation(id: string, changes: Partial<Pick<AnnotationRecord, 'note' | 'color'>>): Promise<void> {
  const docId = state.docId;
  const viewer = state.viewer;
  const previous = activeAnnotation(id);
  if (pendingDeletes.has(id)) throw new Error('这条批注正在删除，不能继续保存');
  if ('note' in changes) noteDrafts.set(id, changes.note ?? '');
  let updated: AnnotationRecord;
  try { updated = await idbUpdateAnnotation(id, docId, previous.revision ?? 0, changes); }
  catch (error) {
    if (error instanceof Error && error.name === 'AnnotationConflictError' && 'note' in changes) {
      noteConflicts.add(id);
      if (state.docId === docId && state.viewer === viewer) renderAnnotationLists();
    }
    throw error;
  }
  if (state.docId !== docId || state.viewer !== viewer) throw new Error('批注已保存到原文献，当前阅读会话已切换');
  if ('note' in changes) {
    if (noteDrafts.get(id) === changes.note) noteDrafts.delete(id);
    noteConflicts.delete(id);
  }
  state.annotations = state.annotations.map(a => a.id === id ? updated : a);
  for (const pageIndex of annotationPages(updated)) renderPageAnnotations(pageIndex);
  renderAnnotationLists();
}
export async function updateAnnotationNote(id: string, note: string): Promise<void> {
  await updateAnnotation(id, { note });
}
export async function recolorAnnotation(id: string, color: 1 | 2 | 3): Promise<void> {
  await updateAnnotation(id, { color });
}

function annoLayerOf(pageIndex: number): HTMLElement | null {
  const pageEl = state.viewer?.getPageElement(pageIndex);
  return pageEl?.querySelector<HTMLElement>('.ml-anno-layer') ?? null;
}

/** Geometry-only projection: new PDF anchors must never fall back to legacy rectangles. */
export function annotationDisplayRects(annotation: AnnotationRecord, pageIndex: number,
  project: (quad: PdfQuad) => Box | null, layerBox: Box): NormRect[] {
  if (annotation.anchor?.coordinateSpace !== 'pdf-user-space') {
    return annotation.pageIndex === pageIndex ? annotation.rects : [];
  }
  if (layerBox.width <= 0 || layerBox.height <= 0) return [];
  const region = annotation.anchor.regions.find(candidate => candidate.pageIndex === pageIndex);
  return (region?.quads ?? []).map(project).filter((rect): rect is Box => !!rect)
    .filter(rect => [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0)
    .map(rect => ({ x: (rect.left - layerBox.left) / layerBox.width,
      y: (rect.top - layerBox.top) / layerBox.height, w: rect.width / layerBox.width, h: rect.height / layerBox.height }));
}

export function renderPageAnnotations(pageIndex: number): void {
  const layer = annoLayerOf(pageIndex);
  if (!layer) return;
  layer.replaceChildren();
  for (const annotation of state.annotations) {
    if (!annotationPages(annotation).includes(pageIndex)) continue;
    const layerBox = layer.getBoundingClientRect();
    if (layerBox.width <= 0 || layerBox.height <= 0) continue;
    const rects = annotationDisplayRects(annotation, pageIndex, quad => state.viewer?.annotationRect(pageIndex, quad) ?? null, layerBox);
    rects.forEach((rect, i) => {
      const box = h('div', {
        class: `ml-hl ml-hl--${annotation.color}${annotation.kind === 'underline' ? ' ml-underline' : ''}`,
        dataset: {annotationId: annotation.id},
        title: annotation.note ? `${annotation.quote.slice(0, 60)}…\n📝 ${annotation.note.slice(0, 80)}` : annotation.quote.slice(0, 80),
      });
      box.style.left = `${rect.x * 100}%`;
      box.style.top = `${rect.y * 100}%`;
      box.style.width = `${rect.w * 100}%`;
      box.style.height = `${rect.h * 100}%`;
      if (annotation.kind === 'note') box.style.outline = '1px dashed rgba(0,0,0,.25)';
      layer.appendChild(box);
      if (annotation.kind === 'note' && i === 0) {
        const pin = h('div', { class: 'ml-note-pin', title: annotation.note ?? '' }, '📝');
        pin.style.left = `${rect.x * 100}%`;
        pin.style.top = `${rect.y * 100}%`;
        layer.appendChild(pin);
      }
    });
  }
}

export function renderAllAnnotations(): void {
  const pages = state.viewer?.numPages ?? 0;
  for (let i = 0; i < pages; i++) renderPageAnnotations(i);
}

export function renderAnnotationLists(): void {
  renderMarksList();
  renderNotesList();
}

function renderMarksList(): void {
  const host = qs('#marks-list');
  clear(host);
  host.appendChild(h('button', { class: 'ghost', title: '加载其他页面的已保存批注，保留本页未保存草稿', on: { click: () => void loadAnnotations().catch(toastError) } }, '刷新批注'));
  const highlights = state.annotations;
  if (highlights.length === 0) {
    host.appendChild(h('div', { class: 'ml-empty' }, t('noHighlights')));
    return;
  }
  const sorted = [...highlights].sort((a, b) => a.pageIndex - b.pageIndex);
  for (const annotation of sorted) {
    const item = h('div', { class: 'ml-anno-item' });
    const quote = h('div', { class: 'ml-anno-item__quote' }, annotation.quote.slice(0, 180) || '(空)');
    quote.style.borderLeftColor = `var(--ml-hl${annotation.color})`;
    quote.addEventListener('click', () => jumpToPage(annotation.pageIndex));
    const head = h(
      'div',
      { class: 'ml-anno-item__head' },
      h('span', { class: 'ml-row' }, h('span', { class: `ml-color-dot ml-color-dot--${annotation.color}` }), h('span', { class: 'ml-muted' }, annotationLabel(annotation))),
      h(
        'span',
        { class: 'ml-row' },
        h('button', { class: 'ghost', on: { click: () => void jumpToPage(annotation.pageIndex) } }, '跳转'),
        h('button', { class: 'ghost', on: { click: () => void deleteAnnotation(annotation.id).catch(toastError) } }, t('delete'))
      )
    );
    item.append(head, quote);
    if (annotation.kind === 'note' && annotation.note) {
      item.appendChild(h('div', { class: 'ml-muted' }, `📝 ${annotation.note.slice(0, 200)}`));
    }
    host.appendChild(item);
  }
}

function renderNotesList(): void {
  const host = qs('#notes-list');
  clear(host);
  const notes = state.annotations.filter((a) => a.kind === 'note');
  if (notes.length === 0) {
    host.appendChild(h('div', { class: 'ml-empty' }, t('noNotes')));
    return;
  }
  for (const annotation of notes.sort((a, b) => a.pageIndex - b.pageIndex)) {
    const item = h('div', { class: 'ml-anno-item' });
    const quote = h('div', { class: 'ml-anno-item__quote' }, annotation.quote.slice(0, 160));
    quote.addEventListener('click', () => jumpToPage(annotation.pageIndex));
    const editor = h('textarea', {
      class: 'ml-note-editor',
      placeholder: t('notePlaceholder'),
      value: noteDrafts.get(annotation.id) ?? annotation.note ?? '',
    }) as HTMLTextAreaElement;
    editor.addEventListener('input', () => { noteDrafts.set(annotation.id, editor.value); });
    const save = h(
      'button',
      {
        class: 'primary',
        on: {
          click: async () => {
            try { await updateAnnotationNote(annotation.id, editor.value); toast(t('saved'), 'success', 1200); }
            catch (error) { toastError(error); }
          },
        },
      },
      noteConflicts.has(annotation.id) ? '用我的草稿保存' : t('save')
    );
    if (noteConflicts.has(annotation.id)) {
      item.appendChild(h('div', { class: 'ml-annotation-conflict', role: 'status' },
        h('p', {}, '其他页面已修改这条笔记。你的草稿尚未保存；先刷新已保存版本并核对。'),
        h('p', {}, `已载入的保存版本：${annotation.note ?? '（空）'}`),
        h('button', { class: 'ghost', on: { click: () => void loadAnnotations().catch(toastError) } }, '刷新已保存版本（保留我的草稿）')));
    }
    item.append(
      h(
        'div',
        { class: 'ml-anno-item__head' },
        h('span', { class: 'ml-muted' }, annotationLabel(annotation)),
        h(
          'span',
          { class: 'ml-row' },
          h('button', { class: 'ghost', on: { click: () => void jumpToPage(annotation.pageIndex) } }, '跳转'),
          h('button', { class: 'ghost', on: { click: () => void deleteAnnotation(annotation.id).catch(toastError) } }, t('delete'))
        )
      ),
      quote,
      editor,
      h('div', { class: 'ml-row' }, save)
    );
    host.appendChild(item);
  }
}

export function exportAnnotations(): void {
  const payload = JSON.stringify(
    { schemaVersion: 2, exportedAt: new Date().toISOString(), doc: state.info.title, docId: state.docId, annotations: state.annotations },
    null,
    2
  );
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const a = h('a', { href: url, download: `yedeng-annotations-${state.docId.slice(2, 10)}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Never move old normalized rectangles to a different page solely from quote matches. */
export async function reanchorAnnotations(): Promise<void> {
  // Reliable re-anchoring requires text offsets → quads and explicit ambiguous-match handling.
  // Preserve old geometry until that workflow exists. Legacy badges keep the limitation visible.
  renderAllAnnotations();
  renderAnnotationLists();
}

function annotationLabel(annotation: AnnotationRecord): string {
  const pages = annotationPages(annotation).map(page => page + 1);
  const location = pages.length > 1 ? `P${pages[0]}–${pages[pages.length - 1]}` : `P${pages[0]}`;
  const kind = annotation.kind === 'underline' ? ' · 下划线' : '';
  const legacy = annotation.anchor?.coordinateSpace !== 'pdf-user-space' ? ' · 旧批注，位置待核对' : '';
  return location + kind + legacy;
}

let inlineMenu: HTMLElement | null = null;
export function closeInlineAnnotationMenu(): void { inlineMenu?.remove(); inlineMenu = null; }
/** Hit-test projected paint rectangles without making the highlight overlay intercept text selection. */
export function annotationHit(rects: { id: string; left: number; top: number; right: number; bottom: number }[], x: number, y: number): string | null {
  return [...rects].reverse().find(r => Number.isFinite(x) && Number.isFinite(y) && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)?.id ?? null;
}
export function initInlineAnnotationActions(): void {
  const scroll = qs('#scroller'); let down: {x:number;y:number} | null = null;
  scroll.addEventListener('pointerdown', e => { down={x:e.clientX,y:e.clientY}; });
  const openAt = (event: MouseEvent, contextMenu: boolean) => {
    if (document.body.classList.contains('ml-region-selecting')) return;
    if (!contextMenu && (!down || Math.hypot(event.clientX-down.x,event.clientY-down.y)>5 || window.getSelection()?.toString().trim())) return;
    const page=(event.target as Element).closest<HTMLElement>('.ml-page'); if (!page) return;
    const rects=Array.from(page.querySelectorAll<HTMLElement>('.ml-hl[data-annotation-id]')).map(el=>({id:el.dataset.annotationId!,...rectData(el.getBoundingClientRect())}));
    const id=annotationHit(rects,event.clientX,event.clientY); if(!id)return;
    event.preventDefault();event.stopPropagation();showInlineAnnotationMenu(id,event.clientX,event.clientY);
  };
  scroll.addEventListener('click',event=>openAt(event,false));
  scroll.addEventListener('contextmenu',event=>openAt(event,true));
  scroll.addEventListener('scroll',closeInlineAnnotationMenu,{passive:true});
  window.addEventListener('resize',closeInlineAnnotationMenu);
  document.addEventListener('pointerdown',event=>{if(inlineMenu&&!inlineMenu.contains(event.target as Node))closeInlineAnnotationMenu();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeInlineAnnotationMenu();});
}
function rectData(rect:DOMRect){return{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom};}
function showInlineAnnotationMenu(id:string,x:number,y:number):void {
  closeInlineAnnotationMenu();const record=activeAnnotation(id),docId=state.docId,viewer=state.viewer;
  const menu=h('div',{class:'yd-annotation-menu',role:'dialog','aria-label':'编辑正文标注',tabIndex:-1});inlineMenu=menu;
  const error=h('p',{role:'status',class:'ml-muted'});
  const execute=async(action:()=>Promise<void>)=>{if(state.docId!==docId||state.viewer!==viewer){closeInlineAnnotationMenu();return;}const buttons=menu.querySelectorAll<HTMLButtonElement>('button');buttons.forEach(b=>b.disabled=true);try{await action();closeInlineAnnotationMenu();}catch(e){error.textContent=e instanceof Error?e.message:String(e);buttons.forEach(b=>b.disabled=false);}};
  const remove=h('button',{class:'yd-annotation-remove'},record.kind==='underline'?'删除下划线':record.kind==='note'?'删除这条批注':'删除高亮');
  remove.onclick=()=>void execute(()=>deleteAnnotation(id));
  const colors=h('div',{class:'yd-annotation-colors'});
  for(const color of [1,2,3] as const){const b=h('button',{'aria-label':`改为颜色${color}`,style:`background:var(--ml-hl${color});width:20px;height:20px;padding:0`});b.onclick=()=>void execute(()=>recolorAnnotation(id,color));colors.append(b);}
  const detail=h('button',{},'在侧栏编辑');detail.onclick=()=>{if(state.docId!==docId||state.viewer!==viewer)return;qs('#sidebar').hidden=false;document.querySelector<HTMLButtonElement>('[data-tab="marks"]')?.click();closeInlineAnnotationMenu();};
  menu.append(h('small',{},'这条标注'),h('div',{class:'yd-annotation-actions'},colors,detail,remove),error);menu.addEventListener('pointerdown',e=>e.stopPropagation());document.body.append(menu);
  const r=menu.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(x,innerWidth-r.width-8))}px`;menu.style.top=`${Math.max(8,Math.min(y+10,innerHeight-r.height-8))}px`;menu.focus({preventScroll:true});
}
