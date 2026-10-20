import { renderFormula } from '../formula/render';
/** 极简 Markdown 渲染（安全：先构造 DOM，不用 innerHTML），并把 [p.3] 变成可点击引用。 */
import { h } from '../shared/dom';

const CITATION = /\[p\.(\d+)(?:\s*§\s*([^\]]+))?\]|\[(E\d+)\]/g;
const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\\\([\s\S]*?\\\))/g;

function mathNode(latex:string,display:boolean):HTMLElement {
 const node=h(display?'div':'span',{class:display?'yd-answer-math':'yd-inline-math'});const result=renderFormula(latex,display);
 if(result.status==='rendered')node.innerHTML=result.html;else node.textContent=latex;return node;
}

export interface RenderOptions {
  onCite?: (pageIndex: number) => void;
  onEvidenceCite?: (id: string) => void;
  evidenceIds?: readonly string[];
  evidenceSources?: readonly { id: string; pageIndices: readonly number[]; label?: string }[];
  validPageIndices?: readonly number[];
}

function renderInline(text: string, options: RenderOptions): DocumentFragment {
  const frag = document.createDocumentFragment();
  const parts = text.split(INLINE).filter((p) => p !== '');
  for (const part of parts) {
    if(part.startsWith('\\(')&&part.endsWith('\\)')){frag.appendChild(mathNode(part.slice(2,-2),false));continue;}
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      frag.appendChild(h('strong', {}, part.slice(2, -2)));
      continue;
    }
    if (/^\*[^*]+\*$/.test(part)) {
      frag.appendChild(h('em', {}, part.slice(1, -1)));
      continue;
    }
    if (/^`[^`]+`$/.test(part)) {
      frag.appendChild(h('code', {}, part.slice(1, -1)));
      continue;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = safeHref(link[2]);
      if (href) {
        frag.appendChild(
          h('a', { href, target: '_blank', rel: 'noreferrer noopener' }, link[1])
        );
      } else {
        frag.appendChild(document.createTextNode(link[1]));
      }
      continue;
    }
    appendWithCitations(frag, part, options);
  }
  return frag;
}

function appendWithCitations(target: Node, text: string, options: RenderOptions): void {
  let lastIndex = 0;
  CITATION.lastIndex = 0;
  for (const match of text.matchAll(CITATION)) {
    const index = match.index ?? 0;
    if (index > lastIndex) target.appendChild(document.createTextNode(text.slice(lastIndex, index)));
    if (match[3]) {
      const id = match[3];
      const source=options.evidenceSources?.find(source=>source.id===id);
      const pages=source?.pageIndices.filter(page=>Number.isSafeInteger(page)&&page>=0)??[];
      const valid=options.evidenceSources ? pages.length>0 : !!options.evidenceIds?.includes(id);
      const label=pages.length ? `原文 · 第 ${pages.map(page=>page+1).join('、')} 页` : '原文证据';
      if (options.onEvidenceCite && valid) target.appendChild(h('button', { class:'ml-cite', type:'button', title:`查看原文证据${pages.length?'（PDF页码）':''}，不是公式编号`, on:{click:(event:Event)=>{event.stopPropagation();options.onEvidenceCite?.(id);}} }, label));
      else if(options.onEvidenceCite || options.evidenceSources || options.evidenceIds) target.appendChild(h('span',{class:'yd-cite-unverified',title:`${id} 没有可核验的来源记录，无法跳转`},'来源未核实'));
      else target.appendChild(document.createTextNode(match[0]));
      lastIndex = index + match[0].length;
      continue;
    }
    const pageNumber = Number(match[1]);
    const section = match[2];
    if (!options.onCite || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || (options.validPageIndices && !options.validPageIndices.includes(pageNumber - 1))) {
      target.appendChild(document.createTextNode(match[0]));
      lastIndex = index + match[0].length;
      continue;
    }
    target.appendChild(
      h(
        'button',
        {
          class: 'ml-cite',
          type: 'button',
          title: `跳转到第 ${pageNumber} 页`,
          on: {
            click: (event: Event) => {
              event.stopPropagation();
              options.onCite?.(pageNumber - 1);
            },
          },
        },
        section ? `p.${pageNumber} §${section}` : `p.${pageNumber}`
      )
    );
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) target.appendChild(document.createTextNode(text.slice(lastIndex)));
}

function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

export function renderMarkdown(text: string, options: RenderOptions = {}): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.split('\n');
  let paragraph: string[] = [];
  let list: HTMLElement | null = null;
  let codeBlock: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const p = h('p');
    p.appendChild(renderInline(paragraph.join(' '), options));
    frag.appendChild(p);
    paragraph = [];
  };
  const flushList = () => {
    if (list) frag.appendChild(list);
    list = null;
  };

  let mathBlock:string[]|null=null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if(!codeBlock){
      if(mathBlock){if(line.trim()==='\\]'||line.trim()==='$$'){frag.appendChild(mathNode(mathBlock.join('\n'),true));mathBlock=null;}else mathBlock.push(rawLine);continue;}
      if(line.trim()==='\\['||line.trim()==='$$'){flushParagraph();flushList();mathBlock=[];continue;}
    }
    if (/^\s*```/.test(line)) {
      if (codeBlock) {
        frag.appendChild(h('pre', {}, h('code', {}, codeBlock.join('\n'))));
        codeBlock = null;
      } else {
        flushParagraph();
        flushList();
        codeBlock = [];
      }
      continue;
    }
    if (codeBlock) {
      codeBlock.push(rawLine);
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(4, heading[1].length + 2);
      const el = h(`h${level}` as 'h3');
      el.style.margin = '8px 0 4px';
      el.appendChild(renderInline(heading[2], options));
      frag.appendChild(el);
      continue;
    }
    const listItem = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (listItem) {
      flushParagraph();
      if (!list) list = h('ul');
      const li = h('li');
      li.appendChild(renderInline(listItem[1], options));
      list.appendChild(li);
      continue;
    }
    paragraph.push(line);
  }

  if(mathBlock)frag.appendChild(h('pre',{},mathBlock.join('\n')));
  if (codeBlock) frag.appendChild(h('pre', {}, h('code', {}, codeBlock.join('\n'))));
  flushParagraph();
  flushList();
  return frag;
}
