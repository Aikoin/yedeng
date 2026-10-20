import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OutlineEntry } from '../pdf/loader';
import { locateSearchHitInLayer, searchPages, type SearchHit, type SearchPage } from '../pdf/search';
import { h, qs } from '../shared/dom';
import { sendMessage } from '../shared/messaging';
import { state } from './state';

let indexedPages: SearchPage[] = [], totalPages = 0, labels: string[] | null = null;
let activeHit = -1, hits: SearchHit[] = [], searchVersion = 0;
let outlineItems: OutlineEntry[] = [];
const history: { pageIndex: number; ratio: number }[] = [];
let previousFocus: HTMLElement | null = null;

export function initReaderShell(): void {
  if (window.innerWidth <= 1100) qs('#btn-outline').setAttribute('aria-expanded', 'false');
  qs('#btn-library').addEventListener('click', () => void sendMessage({ type: 'open-library' }));
  qs('#btn-outline').addEventListener('click', () => {
    const outline = qs('#outline');
    if (window.innerWidth <= 1100) {
      document.body.classList.toggle('ml-outline-open');
      qs('#btn-outline').setAttribute('aria-expanded', String(document.body.classList.contains('ml-outline-open')));
    } else {
      outline.hidden = !outline.hidden;
      qs('#btn-outline').setAttribute('aria-expanded', String(!outline.hidden));
    }
  });
  qs('#btn-focus').addEventListener('click', () => {
    const focus = document.body.classList.toggle('ml-focus');
    qs('#btn-focus').textContent = focus ? '退出专注' : '专注阅读';
    qs('#btn-focus').setAttribute('aria-pressed', String(focus));
  });
  qs('#btn-search').addEventListener('click', openSearch);
  qs('#search-close').addEventListener('click', closeSearch);
  qs('#search-input').addEventListener('input', updateSearch);
  qs('#search-input').addEventListener('keydown', (event) => {
    const key = event as KeyboardEvent;
    if (key.key === 'Enter' && !key.isComposing) { key.preventDefault(); void moveHit(key.shiftKey ? -1 : 1); }
  });
  qs('#search-prev').addEventListener('click', () => void moveHit(-1));
  qs('#search-next').addEventListener('click', () => void moveHit(1));
  qs('#btn-page-prev').addEventListener('click', () => navigateTo((state.viewer?.currentPageIndex() ?? 0) - 1));
  qs('#btn-page-next').addEventListener('click', () => navigateTo((state.viewer?.currentPageIndex() ?? 0) + 1));
  const submitPage = () => {
    const input = qs<HTMLInputElement>('#page-number');
    const page=Number(input.value)-1;
    if(page!==state.viewer?.currentPageIndex())navigateTo(page);
  };
  qs('#page-number').addEventListener('change',submitPage);
  qs('#page-number').addEventListener('keydown',event=>{if((event as KeyboardEvent).key==='Enter'){event.preventDefault();submitPage();(event.target as HTMLInputElement).blur();}});
  qs('#btn-return-position').addEventListener('click', () => {
    const back = history.pop(), viewer = state.viewer;
    if (!back || !viewer) return;
    const page = viewer.getPageElement(back.pageIndex);
    if (page) {
      const scroll = qs('#scroller');
      scroll.scrollTo({ top: page.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop + back.ratio * page.clientHeight, behavior: 'instant' });
    }
    qs<HTMLButtonElement>('#btn-return-position').disabled = history.length === 0;
    updateReaderPage(back.pageIndex);
  });
  document.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault(); openSearch();
    } else if (event.key === 'Escape' && !qs('#search-panel').hidden) {
      event.preventDefault(); event.stopImmediatePropagation(); closeSearch();
    }
  }, { capture: true });
}

function openSearch(): void {
  if (qs('#search-panel').hidden) previousFocus = document.activeElement as HTMLElement | null;
  qs('#search-panel').hidden = false;
  const input = qs<HTMLInputElement>('#search-input'); input.focus(); input.select();
}
function closeSearch(): void {
  qs('#search-panel').hidden = true;
  document.querySelectorAll('.ml-search-hit').forEach((el) => el.remove());
  (previousFocus?.isConnected ? previousFocus : qs('#scroller')).focus();
}
function rememberPosition(): void {
  const viewer = state.viewer;
  if (!viewer) return;
  const pageIndex = viewer.currentPageIndex(), page = viewer.getPageElement(pageIndex), scroll = qs('#scroller');
  history.push({ pageIndex, ratio: page ? Math.max(0, (scroll.getBoundingClientRect().top - page.getBoundingClientRect().top) / page.clientHeight) : 0 });
  if (history.length > 50) history.shift();
  qs<HTMLButtonElement>('#btn-return-position').disabled = false;
}
function navigateTo(index: number): void {
  if (!state.viewer || !Number.isFinite(index)) return;
  const target = Math.min(Math.max(0, Math.floor(index)), state.viewer.numPages - 1);
  rememberPosition(); state.viewer.scrollToPage(target, true); updateReaderPage(target);
  if (window.innerWidth <= 1100) { document.body.classList.remove('ml-outline-open'); qs('#btn-outline').setAttribute('aria-expanded','false'); }
}

export async function setReaderDocument(doc: PDFDocumentProxy, outline: OutlineEntry[]): Promise<void> {
  resetReaderShell();
  totalPages = doc.numPages; outlineItems = outline;
  renderOutline(outline, outline.length > 0 ? '原生目录' : '页码导航');
  updateReaderPage(0);
  const pageLabels = await doc.getPageLabels().catch(() => null);
  if (state.doc !== doc) return;
  labels = pageLabels; updateReaderPage(state.viewer?.currentPageIndex() ?? 0);
}
export function resetReaderShell(): void {
  indexedPages = []; hits = []; activeHit = -1; totalPages = 0; labels = null;
  history.length = 0; outlineItems = []; searchVersion++;
  qs<HTMLButtonElement>('#btn-return-position').disabled = true;
  qs('#outline-list').replaceChildren(h('p', { class: 'ml-muted' }, '正在读取文档目录…'));
  updateSearch();
}
export function setReaderSearchPages(pages: SearchPage[], total: number): void {
  indexedPages = pages.map((p) => ({ pageIndex: p.pageIndex, text: p.text })); totalPages = total;
  updateSearch();
}
export function setInferredOutline(sections: OutlineEntry[]): void {
  if (outlineItems.length > 0) return;
  renderOutline(sections, '推断目录');
}
function renderOutline(outline: OutlineEntry[], kind: string): void {
  const items = outline.length ? outline : Array.from({ length: totalPages }, (_, i) => ({ title: `第 ${i + 1} 页`, pageIndex: i, level: 0 }));
  qs('#outline-kind').textContent = kind;
  const host = qs('#outline-list'); host.replaceChildren();
  for (const item of items) {
    const button = h('button', { class: 'ghost', title: item.title, dataset: { outlinePage: String(item.pageIndex) } }, h('span', {}, item.title), h('small', {}, String(item.pageIndex + 1)));
    button.style.paddingLeft = `${10 + Math.min(item.level, 3) * 12}px`;
    button.addEventListener('click', () => navigateTo(item.pageIndex)); host.append(button);
  }
}
export function updateReaderPage(index: number): void {
  const pageInput=qs<HTMLInputElement>('#page-number');
  if(document.activeElement!==pageInput)pageInput.value = String(index + 1);
  qs<HTMLInputElement>('#page-number').max = String(totalPages || 1);
  const label = labels?.[index];
  qs('#page-indicator').textContent = `/ ${totalPages}${label && label !== String(index + 1) ? ` · 页标 ${label}` : ''}`;
  qs('#reading-progress').textContent = totalPages ? `PDF ${index + 1} / ${totalPages}` : '尚未打开文献';
  qs<HTMLProgressElement>('#reading-progress-bar').value = totalPages ? (index + 1) / totalPages * 100 : 0;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-outline-page]'));
  const active = buttons.filter((b) => Number(b.dataset.outlinePage) <= index).at(-1);
  for (const button of buttons) button.classList.toggle('is-active', button === active);
}
function updateSearch(): void {
  const query = qs<HTMLInputElement>('#search-input').value;
  hits = searchPages(indexedPages, query); activeHit = -1; searchVersion++;
  document.querySelectorAll('.ml-search-hit').forEach((el) => el.remove());
  const emptyPages = indexedPages.filter((p) => !p.text.trim()).length;
  qs('#search-coverage').textContent = `已索引 ${indexedPages.length}/${totalPages} 页${emptyPages ? ` · ${emptyPages} 页无可用文字` : ''} · 仅搜索已提取文字，不含公式语义${indexedPages.length < totalPages ? '；尚未索引页结果未知' : ''}`;
  qs('#search-count').textContent = query.trim() ? `${hits.length >= 1000 ? '1000+' : hits.length} 处` : '本地 · 无需 AI';
  const host = qs('#search-results'); host.replaceChildren();
  hits.slice(0, 100).forEach((hit, i) => {
    const button = h('button', {}, h('small', {}, `PDF ${hit.pageIndex + 1}`), hit.excerpt);
    button.addEventListener('click', () => void showHit(i)); host.append(button);
  });
  qs<HTMLButtonElement>('#search-prev').disabled = hits.length === 0;
  qs<HTMLButtonElement>('#search-next').disabled = hits.length === 0;
}
async function moveHit(direction: number): Promise<void> {
  if (!hits.length) return;
  await showHit(activeHit < 0 ? direction > 0 ? 0 : hits.length - 1 : (activeHit + direction + hits.length) % hits.length);
}
async function showHit(index: number): Promise<void> {
  const hit = hits[index], viewer = state.viewer, version = ++searchVersion;
  if (!hit || !viewer) return;
  activeHit = index; navigateTo(hit.pageIndex);
  qs('#search-count').textContent = `${index + 1} / ${hits.length >= 1000 ? '1000+' : hits.length}`;
  Array.from(qs('#search-results').children).forEach((el, i) => el.classList.toggle('is-active', i === index));
  try {
    await viewer.ensurePageRendered(hit.pageIndex);
    if (version !== searchVersion || viewer !== state.viewer) return;
    highlightSearchHit(true);
  } catch { qs('#search-coverage').textContent += ' · 当前页定位失败，可重试'; }
}
export function highlightSearchHit(scroll = false): void {
  document.querySelectorAll('.ml-search-hit').forEach((el) => el.remove());
  if (qs('#search-panel').hidden) return;
  const hit = hits[activeHit], page = hit && state.viewer?.getPageElement(hit.pageIndex);
  if (!page) return;
  const nodes: { node: Text; start: number; end: number }[] = [];
  const walker = document.createTreeWalker(page.querySelector('.textLayer') ?? page, NodeFilter.SHOW_TEXT);
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = text.length; text += node.textContent ?? '';
    nodes.push({ node: node as Text, start, end: text.length }); text += ' ';
  }
  const source = indexedPages.find(item => item.pageIndex === hit.pageIndex)?.text ?? '';
  const match = locateSearchHitInLayer(source, hit, text, qs<HTMLInputElement>('#search-input').value);
  if (!match) { qs('#search-coverage').textContent += ' · 已定位页面，文本层无法精确匹配'; return; }
  const start = nodes.find((n) => n.start <= match.start && n.end > match.start);
  const end = nodes.find((n) => n.start < match.end && n.end >= match.end);
  if (!start || !end) return;
  const range = document.createRange(); range.setStart(start.node, match.start - start.start); range.setEnd(end.node, match.end - end.start);
  const pageRect = page.getBoundingClientRect();
  for (const rect of Array.from(range.getClientRects())) {
    const mark = h('div', { class: 'ml-search-hit' });
    Object.assign(mark.style, { left: `${rect.left - pageRect.left}px`, top: `${rect.top - pageRect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }); page.append(mark);
  }
  const first = page.querySelector('.ml-search-hit');
  if (first && scroll) first.scrollIntoView({ block: 'center', behavior: 'instant' });
}
