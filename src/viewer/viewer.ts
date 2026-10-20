import {initAssistantNavigation,resetAssistantNavigation} from './assistantNavigation';
import {initNotebook,refreshNotebook} from './notebook';
import './readerExperience.css';
import{savePdfLocally,pdfRetentionStatus}from'../storage/documents';
import{exportPortableDocument}from'../storage/portableExport';
/** 阅读器入口：装配所有模块，管理加载流程、快捷键与持久化。 */
import { loadDocument, fetchPdfBytes, readDocInfo, renderThumbnail } from '../pdf/loader';
import { extractDocument, buildChunks, extractPageText } from '../pdf/extract';
import { DEFAULT_SCALE, PdfViewer } from '../pdf/renderer';
import { h, qs, clear } from '../shared/dom';
import { applyI18n, setLang, t } from '../shared/i18n';
import { idbGet, idbPatchReadingState, idbPatchDocRecord, type DocRecord, type ReadingStateRecord } from '../shared/idb';
import { documentFingerprint } from '../shared/hash';
import { sendMessage } from '../shared/messaging';
import { loadSettings, type Settings } from '../shared/settings';
import { toast, toastError } from '../shared/toast';
import { initAiPanels, onTextExtracted, renderModelSelect, resetAiPanels } from './aiActions';
import { initInlineAnnotationActions, closeInlineAnnotationMenu, loadAnnotations, renderPageAnnotations, reanchorAnnotations, exportAnnotations } from './annotations';
import { initSelectionTools, clearSelectionSnapshot, highlightFromShortcut, underlineFromShortcut, noteFromShortcut, quickAction } from './selection';
import { jumpToPage, state } from './state';
import { initReaderShell, resetReaderShell, setReaderDocument, setReaderSearchPages, setInferredOutline, updateReaderPage, highlightSearchHit } from './readerShell';
import { initEvidenceWorkspace, loadEvidenceWorkspace, resetEvidenceWorkspace } from './evidenceWorkspace';
import { initRequestWorkspace, resetRequestWorkspace, loadRequestWorkspace } from './requestWorkspace';
import { initFormulaWorkspace, resetFormulaWorkspace, loadFormulaWorkspace } from './formulaWorkspace';
import './g2-workspace.css';
import './interactionV2.css';
import { findStoredPdfForUrl } from '../evidence/offlinePdf';
import type { PDFDocumentProxy } from 'pdfjs-dist';

/** 少于这个大小就把 PDF 副本存进 IndexedDB，方便从文献库离线重开 */
const STORE_BLOB_LIMIT = 30 * 1024 * 1024;

const scroller = qs('#scroller');
const pagesHost = qs('#pages');
const placeholder = qs('#placeholder');
const fileInput = qs<HTMLInputElement>('#file-input');
let openGeneration = 0;
function beginOpen(): number { resetAssistantNavigation(); closeInlineAnnotationMenu(); resetAiPanels(); resetFormulaWorkspace(); resetRequestWorkspace(); resetEvidenceWorkspace(); clearSelectionSnapshot(); state.selection = null; return ++openGeneration; }

async function boot(): Promise<void> {
  state.settings = await loadSettings();
  applySettings(state.settings);
  applyI18n();
  initAiPanels();
  initSelectionTools();
  initInlineAnnotationActions();
  initEvidenceWorkspace(qs('#evidence-workspace'));
  initRequestWorkspace(qs('#request-workspace'));
  initFormulaWorkspace(qs('#formula-workspace'));
  initTopbar();
  if (window.innerWidth <= 800) { qs('#sidebar').hidden = true; qs('#btn-sidebar').setAttribute('aria-expanded', 'false'); }
  initAssistantNavigation();
  initNotebook();
  initReaderShell();
  initShortcuts();
  initDropZone();
  chrome.runtime.onMessage.addListener((message: { type?: string }) => {
    if (message?.type === 'settings-changed') {
      void loadSettings().then((settings) => {
        state.settings = settings;
        applySettings(settings);
        renderModelSelect();
      });
    }
  });

  const params = new URLSearchParams(location.search);
  const src = params.get('src') ?? '';
  const docParam = params.get('doc') ?? '';
  if (src) {
    state.srcUrl = src;
    await openFromUrl(src);
    return;
  }
  if (docParam) {
    await openFromStoredBlob(docParam);
    return;
  }
  renderEmptyState();
}

/** 从文献库打开：优先用本地留存的 PDF 副本，读不到就回退到原 URL */
async function openFromStoredBlob(docId: string): Promise<void> {
  const generation = beginOpen();
  const record = await idbGet('docs', docId);
  const stored = await idbGet('blobs', docId);
  if (generation !== openGeneration) return;
  if (stored) {
    if (stored.docId !== docId || await documentFingerprint(stored.bytes, '', stored.bytes.byteLength) !== docId) {
      if (generation !== openGeneration) return;
      renderLoadError(new Error('本地 PDF 与文献指纹不一致，已停止恢复'), record?.url ?? '');
      return;
    }
    if (generation !== openGeneration) return;
    state.srcUrl = record?.url ?? '';
    await openBytes(stored.bytes.slice(0), record?.url ?? '', record?.fileName, generation);
    return;
  }
  if (record?.url) {
    state.srcUrl = record.url;
    await openFromUrl(record.url);
    return;
  }
  renderLoadError(new Error('本地没有留存这份 PDF 的副本'), record?.url ?? '');
}

function applySettings(settings: Settings): void {
  setLang(settings.ui.lang);
  document.documentElement.dataset.theme = settings.ui.theme;
  document.documentElement.style.setProperty('--ml-sidebar-w', `${settings.ui.sidebarWidth}px`);
  document.body.style.fontSize = `${settings.ui.fontSize}px`;
}

/* ---------------- 顶栏 ---------------- */

function initTopbar(): void {
  qs('#btn-sidebar-close').addEventListener('click', () => { qs('#sidebar').hidden = true; qs('#btn-sidebar').setAttribute('aria-expanded', 'false'); qs('#btn-sidebar').focus(); });
  qs('#btn-zoom-in').addEventListener('click', () => zoomBy(0.15));
  qs('#btn-zoom-out').addEventListener('click', () => zoomBy(-0.15));
  qs('#btn-zoom-label').addEventListener('click', () => setZoom(1));
  qs('#btn-fit-width').addEventListener('click', () => fitWidth());
  qs('#btn-sidebar').addEventListener('click', () => {
    const sidebar = qs('#sidebar');
    sidebar.hidden = !sidebar.hidden;
    qs('#btn-sidebar').setAttribute('aria-expanded', String(!sidebar.hidden));
  });
  qs('#btn-settings').addEventListener('click', () => void sendMessage({ type: 'open-options' }));
  qs('#btn-back').addEventListener('click', () => {
    if (history.length > 1) history.back();
    else if (state.srcUrl) location.href = state.srcUrl;
  });
  qs('#btn-native').addEventListener('click', () => openNative());
  qs('#btn-add-library').addEventListener('click', () => void toggleLibrary());
  qs('#btn-export-reading').addEventListener('click',()=>{if(!state.docId)return;const id=state.docId,dialog=h('dialog',{class:'yd-object-dialog','aria-label':'导出笔记'});const status=h('p',{role:'status'});const reading=h('button',{class:'yd-primary'},'Markdown 与原图');reading.onclick=()=>{reading.disabled=true;void exportPortableDocument(id).then(()=>status.textContent='已生成阅读包，请查看下载。').catch(error=>status.textContent=String(error)).finally(()=>reading.disabled=false);};const raw=h('button',{class:'ghost'},'标注备份（JSON）');raw.onclick=()=>{if(state.docId!==id)return;exportAnnotations();};const close=h('button',{'aria-label':'关闭导出'},'×');close.onclick=()=>{dialog.close();dialog.remove();};dialog.append(h('header',{},h('h2',{},'导出笔记'),close),h('p',{},'阅读包包含可读笔记、公式与图片及来源页码。'),reading,raw,status);document.body.append(dialog);dialog.addEventListener('cancel',()=>dialog.remove());dialog.showModal();});
  qs('#btn-save-pdf').addEventListener('click',()=>{const doc=state.doc,id=state.docId,button=qs<HTMLButtonElement>('#btn-save-pdf');if(!doc)return;button.disabled=true;void doc.getData().then(async data=>{if(state.doc!==doc)throw new Error('文献已切换，请在当前文献重试');await savePdfLocally(id,data.slice().buffer);await updateRetentionStatus(doc,id);}).catch(toastError).finally(()=>{button.disabled=false;});});
  qs('#btn-theme').addEventListener('click', () => {
    const order: Settings['ui']['theme'][] = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(state.settings.ui.theme) + 1) % order.length];
    state.settings.ui.theme = next;
    document.documentElement.dataset.theme = next;
    void import('../shared/settings').then(({ saveSettings }) => saveSettings(state.settings));
  });
  qs('#btn-open-local').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void openFromFile(file);
  });

  scroller.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(event.deltaY > 0 ? -0.1 : 0.1);
    },
    { passive: false }
  );
}

function zoomBy(delta: number): void {
  setZoom((state.viewer?.zoom ?? 1) + delta);
}

function setZoom(zoom: number, persist = true): void {
  state.viewer?.setZoom(zoom);
  updateZoomLabel();
  if (persist && state.viewer) void saveReadingState(state.viewer.currentPageIndex()).catch(error => toastError(error, '阅读缩放未能保存'));
}

function fitWidth(): void {
  if (!state.viewer || !state.doc) return;
  const entry = state.viewer.getPageEntry(0);
  if (!entry) return;
  const available = scroller.clientWidth - 40;
  setZoom(available / (entry.width / (state.viewer.zoom || 1)));
}

function updateZoomLabel(): void {
  const zoom = state.viewer?.zoom ?? 1;
  qs('#btn-zoom-label').textContent = `${Math.round(zoom * 100)}%`;
}

function openNative(): void {
  if (!state.srcUrl) {
    toast('当前是本地文件，已用浏览器默认方式打开', 'info');
    return;
  }
  void sendMessage({ type: 'allow-native', url: state.srcUrl }).then(() => {
    location.href = state.srcUrl;
  });
}

/* ---------------- 侧边栏页签 ---------------- */

/* ---------------- 快捷键 ---------------- */

function initShortcuts(): void {
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    const inField =
      /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;

    if (event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      qs<HTMLButtonElement>('[data-tab="chat"]').click();
      qs('#sidebar').hidden = false;
      event.preventDefault();
      qs<HTMLTextAreaElement>('#chat-input').focus();
      return;
    }
    if (inField) return;

    const meta = event.metaKey || event.ctrlKey;
    if (meta && (event.key === '=' || event.key === '+')) {
      event.preventDefault();
      zoomBy(0.15);
      return;
    }
    if (meta && event.key === '-') {
      event.preventDefault();
      zoomBy(-0.15);
      return;
    }

    switch (event.key) {
      case 'e':
      case 'E':
        void quickAction('explain');
        break;
      case 't':
      case 'T':
        void quickAction('translate');
        break;
      case '1':
      case '2':
      case '3':
        void highlightFromShortcut(Number(event.key) as 1 | 2 | 3).catch((err) => toastError(err));
        break;
      case 'h':
      case 'H':
        void highlightFromShortcut().catch((err) => toastError(err));
        break;
      case 'u':
      case 'U':
        event.preventDefault();
        void underlineFromShortcut().catch((err) => toastError(err));
        break;
      case 'n':
      case 'N':
        void noteFromShortcut().catch((err) => toastError(err));
        break;
      case 'ArrowLeft':
      case 'PageUp':
        state.viewer?.scrollToPage(Math.max(0, (state.viewer?.currentPageIndex() ?? 0) - 1));
        break;
      case 'ArrowRight':
      case 'PageDown':
        state.viewer?.scrollToPage(Math.min((state.viewer?.numPages ?? 1) - 1, (state.viewer?.currentPageIndex() ?? 0) + 1));
        break;
      case '0':
        fitWidth();
        break;
      case 'Escape':
        document.querySelectorAll('.ml-result, .ml-toolbar').forEach((el) => el.remove());
        break;
      default:
        break;
    }
  });
}

/* ---------------- 拖拽打开本地 PDF ---------------- */

function initDropZone(): void {
  let depth = 0;
  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    depth++;
    document.body.classList.add('ml-drop-active');
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) document.body.classList.remove('ml-drop-active');
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    document.body.classList.remove('ml-drop-active');
    const file = Array.from(event.dataTransfer?.files ?? []).find(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );
    if (file) void openFromFile(file);
  });
}

/* ---------------- 空态 ---------------- */

function renderEmptyState(): void {
  pagesHost.replaceChildren();
  clear(placeholder);
  placeholder.appendChild(
    h(
      'div',
      { class: 'ml-card ml-placeholder' },
      h('h2', {}, '页灯 YEDENG'),
      h('p', { class: 'ml-muted' }, '把 PDF 拖进这个窗口，或点击下面的按钮选择本地文件。'),
      h(
        'div',
        { class: 'ml-row', style: 'justify-content:center;gap:8px;margin:14px 0' },
        h('button', { class: 'primary', on: { click: () => fileInput.click() } }, '打开本地 PDF'),
        h('button', { on: { click: () => void sendMessage({ type: 'open-options' }) } }, 'AI 设置'),
        h('button', { on: { click: () => void sendMessage({ type: 'open-library' }) } }, '文献库')
      ),
      h(
        'p',
        { class: 'ml-muted' },
        '想直接接管网页里的 PDF？在 chrome://extensions 里为 页灯 YEDENG 打开"允许访问文件网址"，' +
          '之后点任意 PDF 链接就会自动用本阅读器打开。'
      )
    )
  );
}

/* ---------------- 打开文档 ---------------- */

async function openFromUrl(url: string): Promise<void> {
  const generation = beginOpen();
  const bar = qs('#loadbar');
  qs('#doc-title').textContent = '下载中…';
  try {
    url = new URL(url, location.href).href;
    state.srcUrl = url;
    const bytes = await fetchPdfBytes(url, ({ loaded, total }) => {
      if (generation !== openGeneration) return;
      bar.style.width = total > 0 ? `${Math.min(100, (loaded / total) * 100)}%` : '60%';
    });
    if (generation !== openGeneration) return;
    bar.style.width = '100%';
    await openBytes(bytes, url, undefined, generation);
  } catch (err) {
    if (generation !== openGeneration) return;
    bar.style.width = '0%';
    try {
      const stored = await findStoredPdfForUrl(url);
      if (generation !== openGeneration) return;
      if (stored) {
        await openBytes(stored.bytes, stored.record.url ?? url, stored.record.fileName, generation);
        if (generation !== openGeneration) return;
        const status = qs('#local-copy-status');
        status.textContent = '当前地址下载失败，已打开经过文献指纹核验的本地留存。';
        status.hidden = false;
        return;
      }
    } catch (localError) {
      if (generation !== openGeneration) return;
      renderLoadError(localError, url);
      return;
    }
    renderLoadError(err, url);
  }
}

async function openFromFile(file: File): Promise<void> {
  const generation = beginOpen();
  state.srcUrl = '';
  qs('#doc-title').textContent = file.name;
  try {
    const bytes = await file.arrayBuffer();
    if (generation !== openGeneration) return;
    await openBytes(bytes, '', file.name, generation);
  } catch (err) {
    if (generation !== openGeneration) return;
    renderLoadError(err, '');
  }
}

function renderLoadError(err: unknown, url: string): void {
  clear(placeholder);
  const message = err instanceof Error ? err.message : String(err);
  placeholder.appendChild(
    h(
      'div',
      { class: 'ml-card ml-placeholder' },
      h('h2', {}, t('loadFailed')),
      h('p', { class: 'ml-muted' }, message),
      h('p', { class: 'ml-muted' }, t('loadFailedHint')),
      h(
        'div',
        { class: 'ml-row', style: 'justify-content:center;gap:8px;margin:12px 0' },
        h('button', { class: 'primary', on: { click: () => fileInput.click() } }, '打开本地 PDF'),
        h('button', { on: { click: () => void openFromUrl(url) } }, t('retry')),
        h('button', { on: { click: openNative } }, t('openNative'))
      )
    )
  );
}

async function openBytes(bytes: ArrayBuffer, url: string, fileName: string | undefined, generation: number): Promise<void> {
  if (generation !== openGeneration) return;
  qs('#local-copy-status').hidden = true;
  qs('#btn-save-pdf').hidden = true;
  const sizeBytes = bytes.byteLength;
  clearSelectionSnapshot();
  clear(placeholder);
  resetReaderShell();

  // 同一标签页里换开另一份 PDF：先把上一份彻底拆掉，避免重复监听与内存泄漏
  state.viewer?.destroy();
  state.viewer = null;
  state.docText = null;
  state.chunks = [];
  state.index = null;
  state.annotations = [];
  state.selection = null;
  const previousDoc = state.doc;
  state.doc = null;
  await previousDoc?.destroy().catch(() => undefined);
  if (generation !== openGeneration) return;

  const fingerprint = await documentFingerprint(bytes, url, bytes.byteLength);
  if (generation !== openGeneration) return;
  state.docId = fingerprint;

  // Preserve bytes before worker transfer; commit only after a valid record exists.
  const automaticCopy=bytes.byteLength<=STORE_BLOB_LIMIT?bytes.slice(0):null;

  let passwordCancelled = false;
  const passwordHandler = (submit: (password: string) => void, wrong: boolean) => {
    void requestPdfPassword(wrong).then(password => {
      if (generation !== openGeneration) { void task.destroy(); return; }
      if (password !== null) submit(password);
      else { passwordCancelled = true; void task.destroy(); }
    });
  };
  const task = loadDocument(bytes, { onPassword: passwordHandler });
  const doc = await task.promise.catch(error => { if (passwordCancelled) throw new Error('已取消密码输入，可重新打开 PDF 或选择其他文献。'); throw error; });
  if (generation !== openGeneration) { await doc.destroy(); return; }
  state.doc = doc;

  const viewer = new PdfViewer({
    container: scroller,
    pagesContainer: qs('#pages'),
    onPageChange: (pageIndex) => {
      updateReaderPage(pageIndex);
      void saveReadingState(pageIndex);
    },
    onPageRendered: (pageIndex) => { renderPageAnnotations(pageIndex); highlightSearchHit(); },
  });
  state.viewer = viewer;
  await viewer.load(doc);
  if (generation !== openGeneration) return;
  updateZoomLabel();
  updateReaderPage(0);

  await restoreReadingState();

  // 元信息 + 入库
  const firstPageText = await extractFirstPageText(doc);
  const info = await readDocInfo(doc, firstPageText);
  if (state.doc !== doc || generation !== openGeneration) return;
  state.info = info;
  await setReaderDocument(doc, state.info.outline);
  setReaderSearchPages([{ pageIndex: 0, text: firstPageText }], doc.numPages);
  document.title = state.info.title;
  qs('#doc-title').textContent = state.info.title;
  qs('#doc-title').title = state.info.title;
  qs('#doc-meta').textContent = [
    state.info.authors,
    `${doc.numPages} ${t('pages')}`,
    url ? new URL(url, location.href).host || '本地来源' : fileName ?? '本地文件',
  ]
    .filter(Boolean)
    .join(' · ');

  if (generation !== openGeneration) return;
  await upsertDocRecord(url, fileName, sizeBytes);
  if (generation !== openGeneration) return;
  if(automaticCopy)await savePdfLocally(fingerprint,automaticCopy).catch(()=>toast('PDF 本地留存失败，请保留原文件','error'));
  await updateRetentionStatus(doc,fingerprint);
  if (generation !== openGeneration) return;
  await loadAnnotations();
  if (generation !== openGeneration) return;
  await loadEvidenceWorkspace();
  if (generation !== openGeneration) return;
  await loadRequestWorkspace(state.docId);
  if (generation !== openGeneration) return;
  await loadFormulaWorkspace(state.docId);
  await refreshNotebook();
  if (generation !== openGeneration) return;
  void persistThumbnail(doc, fingerprint);

  // 后台抽取全文 → 打开 AI 能力
  void extractInBackground(doc);
}

async function extractFirstPageText(doc: PDFDocumentProxy): Promise<string> {
  const page = await extractPageText(doc, 0);
  return page.text;
}

async function extractInBackground(doc: PDFDocumentProxy): Promise<void> {
  const body = qs('#summary-body');
  body.replaceChildren(h('span', { class: 'ml-spinner' }), h('span', { class: 'ml-muted' }, ` ${t('extracting')}`));
  try {
    const docText = await extractDocument(doc, state.info.outline, (done, total) => {
      if (state.doc !== doc) return;
      if (done % 3 === 0 || done === total) {
        qs('#doc-meta').textContent = `${qs('#doc-meta').textContent?.split(' · 解析')[0] ?? ''} · 解析 ${done}/${total}`;
      }
    });
    if (state.doc !== doc) return;
    state.docText = docText;
    setReaderSearchPages(docText.pages, doc.numPages);
    setInferredOutline(docText.sections.map((section) => ({ title: section.title, pageIndex: section.pageIndex, level: section.level })));
    state.chunks = buildChunks(docText);
    if (!docText.hasText) {
      toast(t('noTextLayer'), 'error', 6000);
    }
    onTextExtracted();
    await reanchorAnnotations();
    if (state.doc !== doc) return;
    const meta = qs('#doc-meta');
    meta.textContent = meta.textContent?.split(' · 解析')[0] ?? '';
  } catch (err) {
    if (state.doc !== doc) return;
    toastError(err, '解析论文文本失败');
  }
}

/* ---------------- 文档记录与阅读位置 ---------------- */

async function upsertDocRecord(url: string, fileName: string | undefined, sizeBytes: number): Promise<void> {
  const { doc, docId, info } = state;
  if (!doc) return;
  const existing = await idbGet('docs', docId);
  const stored = await idbGet('blobs', docId);
  if (state.doc !== doc) return;
  const record: DocRecord = {
    docId,
    url,
    fileName,
    title: info.title,
    authors: info.authors,
    numPages: doc.numPages,
    sizeBytes,
    addedAt: existing?.addedAt ?? Date.now(),
    lastOpenedAt: Date.now(),
    folderId: existing?.folderId ?? null,
    favorite: existing?.favorite ?? false,
    thumb: existing?.thumb,
    stored: Boolean(stored),
  };
  await idbPatchDocRecord(docId, { url, fileName, title: info.title, authors: info.authors, numPages: doc.numPages, sizeBytes, lastOpenedAt: record.lastOpenedAt, stored: Boolean(stored) }, record);
  updateLibraryButton();
}

function updateLibraryButton(): void {
  const {docId, viewer} = state;
  void idbGet('docs', docId).then((record) => {
    if (state.docId !== docId || state.viewer !== viewer) return;
    const button = qs('#btn-add-library');
    button.textContent = record?.favorite ? '已在文献库' : t('addToLibrary');
    button.classList.toggle('primary', Boolean(record?.favorite));
  });
}

async function toggleLibrary(): Promise<void> {
  const { docId, viewer } = state;
  const record = await idbGet('docs', docId);
  if (!record) return;
  const saved = await idbPatchDocRecord(docId, { favorite: !record.favorite });
  if (state.docId !== docId || state.viewer !== viewer) return;
  record.favorite = saved.favorite;
  updateLibraryButton();
  toast(record.favorite ? '已加入文献库' : '已从收藏移除', 'success', 1500);
}

async function persistThumbnail(doc: PDFDocumentProxy, docId: string): Promise<void> {
  try {
    const thumb = await renderThumbnail(doc, 1, 240);
    const record = await idbGet('docs', docId);
    if (!record || !thumb) return;
    await idbPatchDocRecord(docId, { thumb });
  } catch {
    /* 缩略图失败不影响使用 */
  }
}

async function saveReadingState(pageIndex: number): Promise<void> {
  if (!state.docId) return;
  const record: ReadingStateRecord = {
    docId: state.docId,
    lastPage: pageIndex,
    zoom: state.viewer?.zoom ?? 1,
    updatedAt: Date.now(),
  };
  await idbPatchReadingState(record.docId, { lastPage: record.lastPage, zoom: record.zoom });
}

async function restoreReadingState(): Promise<void> {
  const {docId, viewer} = state;
  const record = await idbGet('readingState', docId);
  if (!record || state.docId !== docId || state.viewer !== viewer) return;
  if (record.zoom && Math.abs(record.zoom - 1) > 0.01) setZoom(record.zoom, false);
  if (record.lastPage > 0) {
    // 等页面尺寸稳定后再跳，否则 offsetTop 还没算好
    window.setTimeout(() => { if (state.docId === docId && state.viewer === viewer) jumpToPage(record.lastPage); }, 120);
  }
}

// 调试/自测挂钩：scripts/smoke-test.mjs 会读取它来断言渲染与文本抽取结果
(window as unknown as { __ml?: unknown }).__ml = {
  state,
  get viewer() {
    return state.viewer;
  },
};

void boot().catch((err) => {
  toastError(err, '阅读器启动失败');
  renderLoadError(err, state.srcUrl);
});

export { DEFAULT_SCALE };

/** Native prompts can be suppressed by embedded browsers; keep the PDF unlock flow accessible. */
function requestPdfPassword(wrong: boolean): Promise<string | null> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'pdf-password-dialog';
    dialog.setAttribute('aria-label', '打开加密 PDF');
    const form = document.createElement('form'); form.method = 'dialog';
    const title = document.createElement('h2'); title.textContent = '打开加密 PDF';
    const label = document.createElement('label'); label.textContent = wrong ? '密码不对，请重新输入' : '这份 PDF 需要密码';
    const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'off'; input.setAttribute('aria-label', 'PDF 密码');
    const actions = document.createElement('div'); actions.className = 'pdf-password-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消打开';
    const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.textContent = '打开文献';
    let finished = false;
    const finish = (value: string | null) => { if (finished) return; finished = true; input.value = ''; dialog.remove(); resolve(value); };
    cancel.onclick = () => finish(null);
    dialog.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
    form.onsubmit = e => { e.preventDefault(); finish(input.value); };
    label.append(input); actions.append(cancel, confirm); form.append(title, label, actions); dialog.append(form); document.body.append(dialog); dialog.showModal(); input.focus();
  });
}

async function updateRetentionStatus(doc:PDFDocumentProxy,id:string):Promise<void>{const status=await pdfRetentionStatus(id);if(state.doc!==doc||state.docId!==id)return;const label=qs('#local-copy-status');label.hidden=false;label.textContent=status==='stored'?'PDF 已留存 · 可离线重开':status==='corrupt'?'PDF 校验失败 · 请重新保存':'仅记录来源 · PDF 未留存';qs('#btn-save-pdf').hidden=status==='stored';}
