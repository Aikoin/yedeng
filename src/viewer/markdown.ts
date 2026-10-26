import { renderFormula } from '../formula/render';
/** Safe answer Markdown: text DOM nodes, verified source buttons, trusted local KaTeX only. */
import { h } from '../shared/dom';
import { parseMarkdownTable, type MarkdownTable } from './markdownTable';

const CITATION = /\[p\.(\d+)(?:\s*§\s*([^\]]+))?\]|\[(E\d+)\]/g;


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

function renderInline(text: string, options: RenderOptions, depth = 0): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (depth > 24) { appendWithCitations(frag, text, options); return frag; }
  let plain = '';
  const flush = () => { appendWithCitations(frag, plain, options); plain = ''; };
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i);
    const math = rest.match(/^\\\(([\s\S]*?)\\\)/) || rest.match(/^\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/);
    if (math) { flush(); frag.appendChild(mathNode(math[1], false)); i += math[0].length; continue; }
    if (rest[0] === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(rest[1] || '')) {
      // Escaped source syntax must stay literal rather than turn into a citation button.
      flush(); frag.appendChild(document.createTextNode(rest[1])); i += 2; continue;
    }
    if (rest[0] === '\n') { flush(); frag.appendChild(h('br')); i++; continue; }
    const ticks = rest.match(/^`+/)?.[0];
    if (ticks) {
      const end = rest.indexOf(ticks, ticks.length);
      if (end >= 0) { flush(); frag.appendChild(h('code', {}, rest.slice(ticks.length, end).replace(/\n/g, ' '))); i += end + ticks.length; continue; }
    }
    const link = rest.match(/^(!?)\[([^\]]+)\]\(\s*(https?:\/\/[^\s]+|[^\s)]+?)(?:\s+"[^"]*")?\s*\)/);
    if (link) {
      flush(); const href = safeHref(link[3]);
      // Remote images are links, never fetched automatically from model output.
      if (href) frag.appendChild(h('a', { href, target: '_blank', rel: 'noreferrer noopener' }, link[1] ? `图片：${link[2] || '查看图片'}` : link[2]));
      else frag.appendChild(document.createTextNode(link[2]));
      i += link[0].length; continue;
    }
    const autoLink = rest.match(/^<(https?:\/\/[^\s<>]+)>/);
    if (autoLink) { flush(); frag.appendChild(h('a', {href:autoLink[1],target:'_blank',rel:'noreferrer noopener'},autoLink[1])); i += autoLink[0].length; continue; }
    let formatted = false;
    for (const [marker, tag] of [['***','strong'],['___','strong'],['**','strong'],['__','strong'],['~~','del'],['*','em'],['_','em']] as const) {
      if (!rest.startsWith(marker) || /\s/.test(rest[marker.length] || ' ') || (marker.includes('_') && /[\p{L}\p{N}]/u.test(text[i-1] || ''))) continue;
      let end = rest.indexOf(marker, marker.length);
      while (end > 0 && rest[end-1] === '\\') end = rest.indexOf(marker, end + marker.length);
      // In **bold *italic*** the final star closes the inner emphasis first.
      if (marker.length === 2 && (marker === '**' || marker === '__') && rest[end + 2] === marker[0]) {
        const inner = rest.slice(2,end);
        if ((inner.split(marker[0]).length - 1) % 2 === 1) end++;
      }
      if (end <= marker.length || /\s/.test(rest[end-1])) continue;
      flush(); const node = h(tag);
      if (marker.length === 3) node.appendChild(h('em', {}, renderInline(rest.slice(marker.length,end),options,depth+1)));
      else node.appendChild(renderInline(rest.slice(marker.length,end),options,depth+1));
      frag.appendChild(node); i += end + marker.length; formatted = true; break;
    }
    if (!formatted) { plain += text[i]; i++; }
  }
  flush(); return frag;
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

function renderTable(value: MarkdownTable, options: RenderOptions): HTMLElement {
  const table = h('table', { class: 'yd-markdown-table' });
  const row = (cells: string[], header: boolean) => {
    const tr = h('tr');
    cells.forEach((text, i) => {
      const cell = header ? h('th', { scope: 'col' }) : h('td');
      cell.style.textAlign = value.alignments[i];
      cell.appendChild(renderInline(text, options)); tr.appendChild(cell);
    });
    return tr;
  };
  table.appendChild(h('thead', {}, row(value.headers, true)));
  const body = h('tbody'); for (const cells of value.rows) body.appendChild(row(cells, false));
  table.appendChild(body);
  return h('div', { class: 'yd-markdown-table-scroll', role: 'region', 'aria-label': '回答中的表格，可横向滚动', tabIndex: 0 }, table);
}

export function renderMarkdown(text: string, options: RenderOptions = {}): DocumentFragment {
  return renderBlocks(text.replace(/\r\n?/g, '\n').split('\n'), options);
}

const listPattern = /^( *)([-+*•]|\d+[.)])\s+(.*)$/;
const rulePattern = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
function startsBlock(lines: readonly string[], i: number): boolean {
  return /^ {0,3}(?:>|#{1,6}\s|`{3,}|~{3,}|\\\[|\$\$)/.test(lines[i]) ||
    listPattern.test(lines[i]) || rulePattern.test(lines[i]) || !!parseMarkdownTable(lines, i);
}
function renderBlocks(lines: readonly string[], options: RenderOptions, depth = 0): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (depth > 24) { frag.appendChild(h('p', {}, lines.join('\n'))); return frag; }
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})([^`]*?)\s*$/);
    if (fence) {
      const content: string[] = []; i++;
      const close = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
      while (i < lines.length && !close.test(lines[i])) content.push(lines[i++]);
      if (i < lines.length) i++;
      frag.appendChild(h('pre', {class:'yd-markdown-code'}, h('code', {}, content.join('\n')))); continue;
    }
    const math = line.trim().match(/^(\\\[|\$\$)(.*)$/);
    if (math) {
      const close = math[1] === '$$' ? '$$' : '\\]', content: string[] = [];
      let rest = math[2], closed = false; i++;
      while (true) {
        const end = rest.indexOf(close);
        if (end >= 0) { content.push(rest.slice(0,end)); closed = true; const tail=rest.slice(end+close.length).trim();
          frag.appendChild(mathNode(content.join('\n').trim(),true));
          if(tail) frag.appendChild(h('p',{},renderInline(tail,options))); break; }
        content.push(rest); if(i>=lines.length) break; rest=lines[i++];
      }
      if(!closed) frag.appendChild(h('pre', {class:'yd-markdown-code'}, math[1]+content.join('\n')));
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        if (/^ {0,3}>/.test(lines[i])) { quoted.push(lines[i++].replace(/^ {0,3}> ?/, '')); continue; }
        // A soft-wrapped quote paragraph may omit the repeated > marker.
        if (quoted.at(-1)?.trim() && lines[i].trim() && !startsBlock(lines,i)) { quoted.push(lines[i++]); continue; }
        break;
      }
      frag.appendChild(h('blockquote', {class:'yd-markdown-quote'}, renderBlocks(quoted,options,depth+1))); continue;
    }
    if (rulePattern.test(line)) { frag.appendChild(h('hr',{class:'yd-markdown-rule'})); i++; continue; }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/);
    if (heading) {
      const node = h(`h${Math.min(6,heading[1].length+2)}` as 'h3',{class:'yd-markdown-heading'});
      node.appendChild(renderInline(heading[2],options)); frag.appendChild(node); i++; continue;
    }
    const item = line.match(listPattern);
    if (item) {
      const ordered = /^\d/.test(item[2]), indent = item[1].length;
      const list = ordered ? h('ol',{class:'yd-markdown-list',start:parseInt(item[2],10)}) : h('ul',{class:'yd-markdown-list'});
      while (i < lines.length) {
        const current = lines[i].match(listPattern);
        if (!current || current[1].length !== indent || /^\d/.test(current[2]) !== ordered) break;
        const body = [current[3]], bodyIndent = lines[i].length-current[3].length; i++;
        while (i < lines.length) {
          if (!lines[i].trim()) {
            let next=i+1; while(next<lines.length&&!lines[next].trim())next++;
            if(next<lines.length&&/^\s+/.test(lines[next])&&lines[next].match(/^ */)![0].length>=bodyIndent){body.push('');i++;continue;}
            break;
          }
          const spaces = lines[i].match(/^ */)![0].length;
          if (spaces >= bodyIndent) { body.push(lines[i++].slice(bodyIndent)); continue; }
          if (startsBlock(lines,i)) break;
          body.push(lines[i++]);
        }
        const li=h('li');
        const task=body[0].match(/^\[([ xX])\]\s+(.*)$/);
        if(task){li.className='yd-markdown-task';body[0]=task[2];li.appendChild(h('input',{type:'checkbox',checked:task[1].toLowerCase()==='x',disabled:true,'aria-label':task[1]===' '?'未完成':'已完成'}));}
        li.appendChild(renderBlocks(body,options,depth+1)); list.appendChild(li);
        while(i<lines.length&&!lines[i].trim())i++;
      }
      frag.appendChild(list); continue;
    }
    const table = parseMarkdownTable(lines,i);
    if (table) { frag.appendChild(renderTable(table,options)); i=table.end; continue; }
    if(i+1<lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i+1])) {
      frag.appendChild(h(lines[i+1].trim()[0]==='='?'h3':'h4',{class:'yd-markdown-heading'},renderInline(line,options))); i+=2; continue;
    }
    const paragraph:string[]=[line];i++;
    while(i<lines.length&&lines[i].trim()&&!startsBlock(lines,i))paragraph.push(lines[i++]);
    let text='';
    paragraph.forEach((part,index)=>{const hard=/ {2,}$|\\$/.test(part);text+=part.replace(/ {2,}$|\\$/,'')+(index<paragraph.length-1?(hard?'\n':' '):'');});
    frag.appendChild(h('p',{},renderInline(text,options)));
  }
  return frag;
}
