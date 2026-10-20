/**
 * 阅读器渲染层：逐页懒渲染 canvas + pdf.js 官方文本层（可划词）。
 * 关键：pdf.js 的 TextLayer 用 --total-scale-factor 做 CSS 缩放，
 * 因此每页把该变量设成当前 scale，并让 TextLayer 自己算尺寸。
 */
import { AnnotationLayer, TextLayer, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import { h } from '../shared/dom';
import { pdfRenderScheduler } from './renderScheduler';
import { log } from '../shared/logger';
import { clientRectToPdfQuad, pdfQuadToClientRect, type ClientBox, type PdfQuad } from './geometry';

/** 100% 缩放 = 96dpi，与 pdf.js 浏览器阅读器一致（72dpi 的 4/3） */
export const DEFAULT_SCALE = 96 / 72;
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 4;

interface PageEntry {
  index: number;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  textLayerDiv: HTMLElement;
  linkLayerDiv: HTMLElement;
  annoLayer: HTMLElement;
  /** 未缩放（72dpi）尺寸 */
  width: number;
  height: number;
  rendered: boolean;
  generation: number;
  status: HTMLElement;
  textLayer: TextLayer | null;
  renderTask: RenderTask | null;
  page: PDFPageProxy | null;
}

export interface PdfViewerOptions {
  container: HTMLElement;
  /** The scroll host stays intact; pages are children of this styled content host. */
  pagesContainer: HTMLElement;
  /** Diagnostic raster output ratio; undefined follows native DPR (capped at 2). Not device emulation. */
  outputScale?: 1 | 2;
  onPageChange?: (pageIndex: number) => void;
  onPageRendered?: (pageIndex: number) => void;
}

/** pdf.js AnnotationLayer 只需要用到这几个成员，这里给一个最小可用实现 */
interface PdfLinkServiceLike {
  eventBus: {
    on(name: string, fn: (data: unknown) => void): void;
    off(name: string, fn: (data: unknown) => void): void;
    dispatch(name: string, data?: unknown): void;
  };
  pagesCount: number;
  page: number;
  rotation: number;
  isInPresentationMode: boolean;
  externalLinkEnabled: boolean;
  addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean): void;
  getDestinationHash(dest: unknown): string;
  getAnchorUrl(hash: string): string;
  goToDestination(dest: unknown): void;
  executeNamedAction(action: string): void;
  executeSetOCGState(state: unknown): void;
}

export class PdfViewer {
  private container: HTMLElement;
  private pagesContainer: HTMLElement;
  private opts: PdfViewerOptions;
  private doc: PDFDocumentProxy | null = null;
  private entries: PageEntry[] = [];
  private observer: IntersectionObserver | null = null;
  private scale = DEFAULT_SCALE;
  private lastPage = 0;
  private destroyed = false;
  private renderQueue = new Set<number>();
  private renderPromises = new Map<number, Promise<void>>();
  private queued = false;
  /** 缩放版本号：用于丢弃过期渲染结果 */
  private version = 0;

  constructor(options: PdfViewerOptions) {
    this.container = options.container;
    this.pagesContainer = options.pagesContainer;
    this.opts = options;
    this.container.addEventListener('scroll', this.onScroll, { passive: true });
  }

  private onScroll = (): void => {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      const page = this.currentPageIndex();
      if (page !== this.lastPage) {
        this.lastPage = page;
        this.opts.onPageChange?.(page);
      }
    });
  };

  get docProxy(): PDFDocumentProxy | null {
    return this.doc;
  }

  get zoom(): number {
    return this.scale / DEFAULT_SCALE;
  }

  get numPages(): number {
    return this.entries.length;
  }

  async load(doc: PDFDocumentProxy): Promise<void> {
    this.doc = doc;
    this.entries = [];
    this.pagesContainer.replaceChildren();

    // 先用第一页的尺寸把所有页面壳建出来（秒开），随后再异步修正真实尺寸
    const firstPage = await doc.getPage(1);
    const base = firstPage.getViewport({ scale: 1 });

    const total = doc.numPages;
    for (let i = 0; i < total; i++) {
      const el = h('div', { class: 'ml-page', dataset: { page: String(i) } });
      const canvas = h('canvas', { class: 'ml-canvas',style:{visibility:'hidden'} });
      const status=h('div',{class:'ml-page-render-status',role:'status'},'页面加载中…');
      canvas.width=1;canvas.height=1;
      const textLayerDiv = h('div', { class: 'textLayer ml-text-layer' });
      const linkLayerDiv = h('div', { class: 'annotationLayer ml-link-layer' });
      const annoLayer = h('div', { class: 'ml-anno-layer' });
      el.append(canvas, textLayerDiv, linkLayerDiv, annoLayer,status);

      const entry: PageEntry = {
        index: i,
        el,
        canvas,
        textLayerDiv,
        linkLayerDiv,
        annoLayer,
        width: base.width,
        height: base.height,
        rendered: false,
        generation:0,status,
        textLayer: null,
        renderTask: null,
        page: null,
      };
      this.entries.push(entry);
      this.pagesContainer.appendChild(el);
      this.applySize(entry);
    }

    this.observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (record.isIntersecting) {
            const index = Number((record.target as HTMLElement).dataset.page);
            if (!Number.isNaN(index)) void this.render(index);
          }
        }
        this.unloadFarPages();
      },
      { root: this.container, rootMargin: '600px 0px' }
    );
    for (const entry of this.entries) this.observer.observe(entry.el);
    void this.render(this.currentPageIndex());
    void this.refinePageSizes();
  }

  /** 逐页读取真实尺寸（大多数论文所有页同尺寸，这里只在需要时修正） */
  private async refinePageSizes(): Promise<void> {
    if (!this.doc) return;
    for (const entry of this.entries) {
      if (this.destroyed || !this.doc) return;
      try {
        const page = await this.doc.getPage(entry.index + 1);
        if (this.destroyed) return;
        const viewport = page.getViewport({ scale: 1 });
        // getPage returns a shared proxy also used by extraction/capture/thumbnail.
        // Metadata probing does not own its lifetime; let document teardown release it.
        if (Math.abs(viewport.width - entry.width) < 0.5 && Math.abs(viewport.height - entry.height) < 0.5) {
          continue;
        }
        entry.width = viewport.width;
        entry.height = viewport.height;
        this.invalidatePage(entry);
        this.applySize(entry);
      } catch {
        /* 单页尺寸读取失败不影响整体 */
      }
    }
  }

  private applySize(entry: PageEntry): void {
    const width = entry.width * this.scale;
    const height = entry.height * this.scale;
    entry.el.style.width = `${width}px`;
    entry.el.style.height = `${height}px`;
    entry.textLayerDiv.style.setProperty('--total-scale-factor', String(this.scale));
    entry.linkLayerDiv.style.setProperty('--total-scale-factor', String(this.scale));
  }

  private viewportFor(entry: PageEntry): { width: number; height: number } {
    return { width: entry.width * this.scale, height: entry.height * this.scale };
  }

  private render(index: number): Promise<void> {
    const existing = this.renderPromises.get(index);
    if (existing) return existing;
    const promise = this.renderPage(index).finally(() => this.renderPromises.delete(index));
    this.renderPromises.set(index, promise);
    return promise;
  }

  private async renderPage(index: number): Promise<void> {
    const entry = this.entries[index];
    if (!entry || this.destroyed) return;
    if (entry.rendered || this.renderQueue.has(index)) return;
    if (!this.doc) return;
    this.renderQueue.add(index);
    const version = this.version, generation=entry.generation;
    const current=()=>!this.destroyed&&version===this.version&&generation===entry.generation;
    const check=()=>{if(!current())throw Object.assign(new Error('Render superseded'),{name:'RenderingCancelledException'});};
    let release: (() => void) | undefined;
    try {
      const page = entry.page ?? (await this.doc.getPage(index + 1));
      check();entry.page = page;
      release = await pdfRenderScheduler.acquire(page);
      check();
      entry.status.hidden=false;entry.status.textContent='页面加载中…';
      const viewport = page.getViewport({ scale: this.scale });
      const base = page.getViewport({ scale: 1 });
      entry.width = base.width;
      entry.height = base.height;
      this.applySize(entry);
      const requestedDpr = this.opts.outputScale ?? Math.min(window.devicePixelRatio || 1, 2);
      const dpr=Math.min(requestedDpr,Math.sqrt(8_000_000/(viewport.width*viewport.height)),16384/Math.max(viewport.width,viewport.height));

      entry.canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      entry.canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      entry.canvas.style.width = `${viewport.width}px`;
      entry.canvas.style.height = `${viewport.height}px`;

      const ctx = entry.canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('无法获取 canvas 2d 上下文');
      ctx.fillStyle='#ffffff';ctx.fillRect(0,0,entry.canvas.width,entry.canvas.height);
      entry.renderTask?.cancel();
      entry.renderTask = page.render({
        canvas: entry.canvas,
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        background: getComputedStyle(document.body).getPropertyValue('--ml-canvas-bg').trim() || '#ffffff',
      });
      await entry.renderTask.promise;check();
      entry.canvas.style.visibility='visible';entry.status.hidden=true;

      // 文本层：本地已渲染过就 update，避免重新拉取 textContent
      const textContent = await page.getTextContent({ includeMarkedContent: true });check();
      entry.textLayerDiv.replaceChildren();
      entry.textLayerDiv.style.setProperty('--total-scale-factor', String(this.scale));
      const textLayer = new TextLayer({
        textContentSource: textContent,
        container: entry.textLayerDiv,
        viewport,
      });
      entry.textLayer=textLayer;
      await textLayer.render();check();
      // TextLayer lays out in unrotated page coordinates. The full upstream viewer CSS
      // supplies these rotations; our focused reader applies the same rule explicitly.
      const rotations: Record<number, string> = {
        0: 'none', 90: 'rotate(90deg) translateY(-100%)',
        180: 'rotate(180deg) translate(-100%, -100%)', 270: 'rotate(270deg) translateX(-100%)',
      };
      entry.textLayerDiv.style.transform = rotations[viewport.rotation] ?? 'none';
      entry.textLayer = textLayer;

      await this.renderLinks(entry, page, viewport);check();

      entry.rendered = true;
      this.opts.onPageRendered?.(index);
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name !== 'RenderingCancelledException'&&current()) {
        log.warn('渲染页面失败', index, err);this.invalidatePage(entry);
        const retry=h('button',{type:'button'},'重新加载此页');retry.onclick=()=>void this.render(index);
        entry.status.replaceChildren(h('span',{},'这一页加载失败'),retry);entry.status.hidden=false;
      }
    } finally {
      release?.();
      this.renderQueue.delete(index);
      if (!current() && !this.destroyed && Math.abs(index-this.currentPageIndex())<=2 && entry.status.textContent==='页面加载中…') window.setTimeout(() => void this.render(index), 0);
    }
  }

  /** 渲染 PDF 内的链接注释：外链新标签打开，内部引用（如 [12]）在阅读器内跳页 */
  private async renderLinks(
    entry: PageEntry,
    page: PDFPageProxy,
    viewport: ReturnType<PDFPageProxy['getViewport']>
  ): Promise<void> {
    entry.linkLayerDiv.replaceChildren();
    try {
      const annotations = await page.getAnnotations({ intent: 'display' });
      const links = annotations.filter(
        (a: { subtype?: string; url?: string; dest?: unknown }) => a.subtype === 'Link' && (a.url || a.dest)
      );
      if (links.length === 0) return;
      const linkService = this.makeLinkService(entry.index);
      const layer = new AnnotationLayer({
        div: entry.linkLayerDiv as HTMLDivElement,
        page,
        viewport,
        linkService: linkService as unknown as never,
        accessibilityManager: null,
        annotationCanvasMap: null,
        annotationEditorUIManager: null,
        structTreeLayer: null,
        commentManager: null,
        annotationStorage: null,
      });
      await layer.render({
        viewport,
        div: entry.linkLayerDiv as HTMLDivElement,
        annotations: links,
        page,
        linkService: linkService as unknown as never,
        renderForms: false,
        imageResourcesPath: chrome.runtime.getURL('pdfjs/images/'),
      });
    } catch (err) {
      log.debug('链接层渲染失败', err);
    }
  }

  private makeLinkService(pageIndex: number): PdfLinkServiceLike {
    const listeners = new Map<string, Set<(data: unknown) => void>>();
    return {
      eventBus: {
        on(name: string, fn: (data: unknown) => void) {
          const set = listeners.get(name) ?? new Set();
          set.add(fn);
          listeners.set(name, set);
        },
        off(name: string, fn: (data: unknown) => void) {
          listeners.get(name)?.delete(fn);
        },
        dispatch(name: string, data?: unknown) {
          listeners.get(name)?.forEach((fn) => fn(data));
        },
      },
      pagesCount: this.doc?.numPages ?? 0,
      page: pageIndex + 1,
      rotation: 0,
      isInPresentationMode: false,
      externalLinkEnabled: true,
      addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow = false) {
        try{const target=new URL(url);if(!['https:','http:'].includes(target.protocol)||target.username||target.password)return;}catch{return;}
        link.href = url;
        link.rel = 'noopener noreferrer';
        if (newWindow) link.target = '_blank';
      },
      getDestinationHash() {
        return '#';
      },
      getAnchorUrl() {
        return '#';
      },
      goToDestination: (dest: unknown) => {
        void this.jumpToDestination(dest);
      },
      executeNamedAction() {
        /* 阅读器不支持命名动作 */
      },
      executeSetOCGState() {
        /* 不支持图层开关 */
      },
    };
  }

  private async jumpToDestination(dest: unknown): Promise<void> {
    if (!this.doc) return;
    try {
      let target = dest;
      if (typeof target === 'string') target = await this.doc.getDestination(target);
      if (!Array.isArray(target) || target.length === 0) return;
      const ref = target[0];
      const pageIndex = typeof ref === 'number' ? ref : await this.doc.getPageIndex(ref as never);
      this.scrollToPage(pageIndex, true);
    } catch (err) {
      log.debug('跳转内部链接失败', err);
    }
  }

  /** Invalidate before clearing the raster; late async work can no longer publish it. */
  private invalidatePage(entry:PageEntry):void {
    entry.generation++;entry.rendered=false;entry.renderTask?.cancel();entry.renderTask=null;
    entry.textLayer?.cancel();entry.textLayer=null;entry.textLayerDiv.replaceChildren();entry.linkLayerDiv.replaceChildren();
    entry.canvas.style.visibility='hidden';entry.canvas.width=1;entry.canvas.height=1;
    entry.status.textContent='页面加载中…';entry.status.hidden=false;
  }
  private unloadFarPages(): void {
    const current=this.currentPageIndex();
    for(const entry of this.entries){
      if(Math.abs(entry.index-current)<=4||(entry.canvas.width<=1&&!entry.renderTask&&!entry.textLayer&&!this.renderQueue.has(entry.index)))continue;
      this.invalidatePage(entry);
      if(entry.page)pdfRenderScheduler.cleanup(entry.page);entry.page=null;
    }
  }

  private pageTop(entry: PageEntry): number {
    return entry.el.getBoundingClientRect().top - this.container.getBoundingClientRect().top
      - this.container.clientTop + this.container.scrollTop;
  }

  currentPageIndex(): number {
    const top=this.container.scrollTop,bottom=top+this.container.clientHeight;
    let best=0,visible=-1;
    for(const entry of this.entries){
      const start=this.pageTop(entry),height=entry.height*this.scale;
      const overlap=Math.max(0,Math.min(bottom,start+height)-Math.max(top,start));
      if(overlap>visible){best=entry.index;visible=overlap;}
    }
    return best;
  }

  scrollToPage(index: number, flash = false): void {
    const entry = this.entries[Math.min(Math.max(0, index), this.entries.length - 1)];
    if (!entry) return;
    this.container.scrollTo({ top: this.pageTop(entry) - 8, behavior: 'instant' });
    void this.render(entry.index);
    if (flash) {
      entry.el.classList.remove('ml-page--flash');
      void entry.el.offsetWidth;
      entry.el.classList.add('ml-page--flash');
    }
  }

  setZoom(zoom: number): void {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const scale = next * DEFAULT_SCALE;
    if (Math.abs(scale - this.scale) < 0.001) return;

    const anchor = this.captureAnchor();
    this.scale = scale;
    this.version += 1;

    for (const entry of this.entries) {
      this.applySize(entry);
      this.invalidatePage(entry);
    }
    this.restoreAnchor(anchor);
    this.renderVisibleNow();
  }

  private captureAnchor(): { pageIndex: number; ratio: number } {
    const pageIndex = this.currentPageIndex();
    const entry = this.entries[pageIndex];
    if (!entry) return { pageIndex: 0, ratio: 0 };
    const height = entry.el.offsetHeight || 1;
    const ratio = (this.container.scrollTop - this.pageTop(entry)) / height;
    return { pageIndex, ratio: Math.min(1, Math.max(-1, ratio)) };
  }

  private restoreAnchor(anchor: { pageIndex: number; ratio: number }): void {
    const entry = this.entries[anchor.pageIndex];
    if (!entry) return;
    this.container.scrollTo({top:this.pageTop(entry)+anchor.ratio*(entry.el.offsetHeight||0),behavior:'instant'});
  }

  /** 立即渲染当前视口附近的所有页面（缩放后调用，不等 IntersectionObserver） */
  renderVisibleNow(): void {
    const current = this.currentPageIndex();
    for (const entry of this.entries) {
      if (Math.abs(entry.index - current) <= 2) void this.render(entry.index);
    }
  }

  async ensurePageRendered(index: number): Promise<void> {
    // A zoom can cancel an in-flight render; await the replacement rather than a stale promise.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.render(index);
      if (this.entries[index]?.rendered) return;
      if (this.destroyed || !this.entries[index]) break;
    }
    throw new Error('页面尚未渲染完成，请重试');
  }

  getPageElement(index: number): HTMLElement | null {
    return this.entries[index]?.el ?? null;
  }

  getPageEntry(index: number): { index: number; width: number; height: number } | null {
    const entry = this.entries[index];
    if (!entry) return null;
    const size = this.viewportFor(entry);
    return { index: entry.index, width: size.width, height: size.height };
  }

  /** Geometry is available for currently rendered pages; no canvas/DPR arithmetic required. */
  selectionQuad(pageIndex: number, rect: ClientBox): PdfQuad | null {
    const entry = this.entries[pageIndex];
    if (!entry?.page) return null;
    return clientRectToPdfQuad(rect, entry.el.getBoundingClientRect(), entry.page.getViewport({ scale: this.scale }));
  }

  annotationRect(pageIndex: number, quad: PdfQuad): ClientBox | null {
    const entry = this.entries[pageIndex];
    if (!entry?.page) return null;
    return pdfQuadToClientRect(quad, entry.el.getBoundingClientRect(), entry.page.getViewport({ scale: this.scale }));
  }

  getAllPageBoxes(): { pageIndex: number; box: { left: number; top: number; width: number; height: number } }[] {
    return this.entries.map((entry) => {
      const rect = entry.el.getBoundingClientRect();
      return {
        pageIndex: entry.index,
        box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      };
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.observer?.disconnect();
    this.container.removeEventListener('scroll', this.onScroll);
    for (const entry of this.entries) {
      this.invalidatePage(entry);
      if (entry.page) pdfRenderScheduler.cleanup(entry.page);
      entry.canvas.width=1;entry.canvas.height=1;
      entry.textLayerDiv.replaceChildren();entry.linkLayerDiv.replaceChildren();
    }
    this.entries = [];
    this.doc = null;
  }
}
