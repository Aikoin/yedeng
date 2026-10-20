import { looksLikeFormula } from '../pdf/mathSelection';
/** 划词工具条 + AI 结果卡片：阅读器里最高频的交互（选中 → 翻译/解释/高亮/笔记/追问） */
import { normalizeBoxes, type Box } from '../pdf/anchor';
import type { PdfQuad } from '../pdf/geometry';
import { pageIndexFromNode, selectedTextRects, snapshotSelection, selectionSessionMatches, type SelectionSession, type SelectionSnapshot } from '../pdf/selectionModel';
import { h, qs } from '../shared/dom';
import { t } from '../shared/i18n';
import { toast, toastError } from '../shared/toast';
import { runSelectionRequest } from './requestWorkspace';
import { startRegionSelection } from './evidenceWorkspace';
import { addAnnotation, deleteAnnotation, renderAnnotationLists, updateAnnotationNote } from './annotations';
import { state } from './state';


let toolbar: HTMLElement | null = null;
let pending: SelectionSnapshot | null = null;
let pendingSession: SelectionSession | null = null;
let lastMouse = { x: 0, y: 0 };

/** Frozen value; consumers must bind it to their document session before preparing a request. */
export function getSelectionSnapshot(): SelectionSnapshot | null {
  return isPendingCurrent() ? pending : null;
}

function isPendingCurrent(): boolean {
  if (!pending) return false;
  if (selectionSessionMatches(pendingSession, { docId: state.docId, viewer: state.viewer })) return true;
  clearSelectionSnapshot();
  return false;
}

function bindSelection(value: SelectionSnapshot): SelectionSnapshot {
  pendingSession = { docId: state.docId, viewer: state.viewer };
  return snapshotSelection({ ...value, docId: state.docId });
}

export function clearSelectionSnapshot(): void {
  pending = null;
  pendingSession = null;
  hideToolbar();
  document.querySelectorAll('.ml-result').forEach((card) => card.remove());
}

export function initSelectionTools(): void {
  const scroller = qs('#scroller');
  scroller.addEventListener('mouseup', () => {
    const receivedAt = performance.now();
    window.setTimeout(() => handleSelection(receivedAt), 0);
  });
  scroller.addEventListener('mousemove', (event) => {
    lastMouse = { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };
  });
  document.addEventListener('keyup', (event) => {
    if (event.shiftKey || event.key.startsWith('Arrow')) window.setTimeout(handleSelection, 0);
  });
  document.addEventListener('mousedown', (event) => {
    const target = event.target as HTMLElement;
    if (toolbar?.contains(target) || target.closest('.ml-result')) return;
    hideToolbar();
    pending = null;
  });
  // scroll 事件不冒泡，所以内层滚动容器要单独监听
  scroller.addEventListener('scroll', () => hideToolbar(), { passive: true });
  window.addEventListener('resize', () => hideToolbar());
}

function handleSelection(receivedAt?: number): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    pending = null;
    hideToolbar();
    return;
  }
  const range = selection.getRangeAt(0);
  const scroller = qs('#scroller');
  if (!scroller.contains(range.startContainer) || !scroller.contains(range.endContainer)) {
    pending = null;
    hideToolbar();
    return;
  }
  const text = selection.toString().replace(/\s+/g, ' ').trim();
  if (text.length < 1) {
    pending = null;
    hideToolbar();
    return;
  }
  const pageIndex = pageIndexFromNode(range.startContainer);
  if (pageIndex < 0) {
    pending = null;
    hideToolbar();
    return;
  }
  const boxes = selectedTextRects(range, scroller);
  if (!boxes.length) { pending = null; hideToolbar(); return; }
  const pageRects = state.viewer?.getAllPageBoxes() ?? [];
  const pageBoxes = normalizeBoxes(boxes, pageRects);
  const firstRect = boxes[0] ?? { left: lastMouse.x, top: lastMouse.y, width: 0, height: 0 };
  const pdfRegions = pageBoxes.map((page) => {
    const pageBox = pageRects.find((p) => p.pageIndex === page.pageIndex)?.box;
    const quads = pageBox ? page.rects.map((rect) => state.viewer?.selectionQuad(page.pageIndex, {
      left: pageBox.left + rect.x * pageBox.width,
      top: pageBox.top + rect.y * pageBox.height,
      width: rect.w * pageBox.width,
      height: rect.h * pageBox.height,
    })).filter((quad): quad is PdfQuad => quad !== null && quad !== undefined) : [];
    return { pageIndex: page.pageIndex, quads };
  });
  pending = bindSelection({ text, pageIndex, pageBoxes, firstRect, pdfRegions });
  showToolbar(firstRect);
  if(looksLikeFormula(text)){
    selection.removeAllRanges();
    for(const region of pageBoxes){const pageBox=pageRects.find(p=>p.pageIndex===region.pageIndex)?.box;if(!pageBox)continue;
      const left=Math.min(...region.rects.map(r=>r.x)),top=Math.min(...region.rects.map(r=>r.y)),right=Math.max(...region.rects.map(r=>r.x+r.w)),bottom=Math.max(...region.rects.map(r=>r.y+r.h));
      const outline=h('div',{class:'yd-math-selection',style:{left:`${pageBox.left+left*pageBox.width-3}px`,top:`${pageBox.top+top*pageBox.height-3}px`,width:`${(right-left)*pageBox.width+6}px`,height:`${(bottom-top)*pageBox.height+6}px`}});document.body.append(outline);
    }
  }
  if (toolbar && receivedAt !== undefined) {
    // Includes the asynchronous mouseup scheduling delay; metadata only, no selected source text.
    toolbar.dataset.readyMs = String(Math.max(0, performance.now() - receivedAt));
  }
}

function showToolbar(rect: Box): void {
  hideToolbar();
  const bar = h('div', { class: 'ml-toolbar' });
  const action = (label: string, title: string, fn: () => void) => {
    const button = h('button', { title }, label);
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      hideToolbar();
      fn();
    });
    return button;
  };

  if(looksLikeFormula(pending?.text??''))bar.append(action('框选公式','框住完整公式后讲解或复制',()=>startRegionSelection('formula-new')),action('复制原文','复制PDF原始文字',()=>void doCopy()),action('记笔记','记笔记',()=>void doNote().catch(toastError)));
  else bar.append(action('解释','解释选中内容',()=>void doExplain().catch(toastError)),action('翻译','翻译选中内容',()=>void doTranslate().catch(toastError)),action('高亮','高亮选中内容',()=>void doHighlight(state.lastColor).catch(toastError)),action('记笔记','记笔记',()=>void doNote().catch(toastError)));
  bar.style.top = `${Math.max(8,rect.top-48)}px`;

  document.body.appendChild(bar);
  const bounds=bar.getBoundingClientRect();bar.style.left=`${Math.max(8,Math.min(window.innerWidth-bounds.width-8,rect.left+rect.width/2-bounds.width/2))}px`;
  toolbar = bar;
}


function hideToolbar(): void {
  document.querySelectorAll('.yd-math-selection').forEach(e=>e.remove());
  toolbar?.remove();
  toolbar = null;
}

async function doHighlight(color: 1 | 2 | 3): Promise<void> {
  if (!isPendingCurrent()) return;
  if (!pending) return;
  const { pageBoxes, text } = pending;
  const annotation = await addAnnotation('highlight', pageBoxes, text, color, undefined, pending);
  if (!annotation) return;
  state.lastColor = color;
  toast('已高亮', 'success', 1200);
}

async function doUnderline(): Promise<void> {
  if (!isPendingCurrent()) return;
  if (!pending) return;
  const annotation = await addAnnotation('underline', pending.pageBoxes, pending.text, state.lastColor, undefined, pending);
  if (annotation) toast('已添加下划线', 'success', 1200);
}
export async function underlineFromShortcut(): Promise<void> {
  if (!isPendingCurrent()) return;
  if (!pending) { toast('先选中一段文字再划线', 'info', 1600); return; }
  await doUnderline();
}

async function doNote(): Promise<void> {
  if (!isPendingCurrent()) return;
  if (!pending) return;
  const { pageBoxes, text } = pending;
  const session = pendingSession;
  const annotation = await addAnnotation('note', pageBoxes, text, state.lastColor, '', pending);
  if (!annotation || !selectionSessionMatches(session, { docId: state.docId, viewer: state.viewer })) return;
  openNoteCard(annotation.id, text);
}

function doCopy(): void {
  if (!isPendingCurrent()) return;
  if (!pending) return;
  void navigator.clipboard.writeText(pending.text).then(
    () => toast(t('copied'), 'success', 1200),
    () => toastError(new Error('复制失败'))
  );
}


async function doTranslate(): Promise<void> {
  if (!isPendingCurrent() || !pending) return;
  await runSelectionRequest(pending, 'translate');
}

async function doExplain(): Promise<void> {
  if (!isPendingCurrent() || !pending) return;
  await runSelectionRequest(pending, 'explain');
}

/** G1 local-only preparation. Source is inserted as text, never interpreted as HTML/Markdown. */
function openNoteCard(annotationId: string, quote: string): void {
  const card = h('div', { class: 'ml-result' });
  card.style.left = `${Math.max(16, lastMouse.x - 190)}px`;
  card.style.top = `${Math.max(60, lastMouse.y + 18)}px`;
  const editor = h('textarea', {
    class: 'ml-note-editor',
    placeholder: t('notePlaceholder'),
  }) as HTMLTextAreaElement;
  const body = h(
    'div',
    { class: 'ml-result__body' },
    h('div', { class: 'ml-muted' }, quote.slice(0, 120)),
    editor
  );
  const close = () => card.remove();
  const remove = () => {
    void deleteAnnotation(annotationId).then(() => card.remove()).catch(toastError);
  };
  const head = h(
    'div',
    { class: 'ml-result__head' },
    h('span', {}, '笔记'),
    h(
      'span',
      { class: 'ml-result__actions' },
      h('button', { class: 'ghost', on: { click: remove } }, t('delete')),
      h('button', { class: 'ghost', on: { click: close } }, '✕')
    )
  );
  const foot = h(
    'div',
    { class: 'ml-result__foot' },
    h(
      'button',
      {
        class: 'primary',
        on: {
          click: () => {
            void updateAnnotationNote(annotationId, editor.value).then(() => {
              renderAnnotationLists();
              toast(t('saved'), 'success', 1200);
              close();
            }).catch(toastError);
          },
        },
      },
      t('save')
    )
  );
  card.append(head, body, foot);
  document.body.appendChild(card);
  editor.focus();
}

/** 供快捷键使用：没有选区时，取光标所在段落 */
export function paragraphUnderCursor(): { text: string; pageIndex: number } | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const range = doc.caretRangeFromPoint?.(lastMouse.x, lastMouse.y);
  if (!range) return null;
  const pageIndex = pageIndexFromNode(range.startContainer);
  if (pageIndex < 0) return null;
  const snippet = (range.startContainer.textContent ?? '').trim();
  if (!snippet) return null;
  return { text: snippet, pageIndex };
}

/** 快捷键入口：翻译/解释当前选区或光标段落 */
export async function quickAction(kind: 'translate' | 'explain'): Promise<void> {
  if (pending && !isPendingCurrent()) return;
  if (!pending) {
    const para = paragraphUnderCursor();
    if (!para) {
      toast('先选中一段文字再试', 'info', 1600);
      return;
    }
    pending = bindSelection({
      text: para.text,
      pageIndex: para.pageIndex,
      pageBoxes: [],
      firstRect: { left: lastMouse.x, top: lastMouse.y, width: 0, height: 0 },
    });
  }
  if (kind === 'translate') await doTranslate();
  else await doExplain();
}

export async function highlightFromShortcut(color?: 1 | 2 | 3): Promise<void> {
  if (!isPendingCurrent()) return;
  if (!pending) {
    toast('先选中一段文字再高亮', 'info', 1600);
    return;
  }
  await doHighlight(color ?? state.lastColor);
}

export async function noteFromShortcut(): Promise<void> {
  if (!isPendingCurrent()) return;
  if (!pending) {
    toast('先选中一段文字再记笔记', 'info', 1600);
    return;
  }
  await doNote();
}

