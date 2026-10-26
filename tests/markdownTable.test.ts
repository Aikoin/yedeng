import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMarkdownTable, splitTableRow } from '../src/viewer/markdownTable';
import { renderMarkdown } from '../src/viewer/markdown';

class TestNode {
  children: TestNode[] = []; attributes: Record<string,string> = {}; events: Record<string,(event:unknown)=>void> = {};
  className = ''; style: {textAlign?:string} = {};
  constructor(public nodeName:string,public data='') {}
  appendChild(node:TestNode) { this.children.push(node); return node; }
  setAttribute(key:string,value:string) { this.attributes[key]=value; }
  addEventListener(key:string,callback:(event:unknown)=>void) { this.events[key]=callback; }
  get textContent():string { return this.data+this.children.map(node=>node.textContent).join(''); }
}
const nodes=(root:TestNode):TestNode[]=>[root,...root.children.flatMap(nodes)];
function render(text:string,options:Parameters<typeof renderMarkdown>[1]={}):TestNode {
  vi.stubGlobal('document',{createElement:(tag:string)=>new TestNode(tag),createTextNode:(text:string)=>new TestNode('#text',text),createDocumentFragment:()=>new TestNode('#fragment')});
  return renderMarkdown(text,options) as unknown as TestNode;
}
afterEach(()=>vi.unstubAllGlobals());
const comparison=`### 和传统轮次式系统的区别

| | 轮次式（半双工/turn-based） | 全双工 |
|---|---|---|
| 交互节奏 | 你说完 → 我再说 | 你说话时我也在出声 |
| 能否插话/被打断 | 基本不能 | 可以 |
| 能否回“嗯”“对” | 不能 | 能 |
| 能否处理重叠语音 | 不能 | 能 |`;

describe('safe Markdown comparison tables',()=>{
  it('renders the reported Chinese comparison with an empty corner header as an actual table',()=>{
    const root=render(comparison),all=nodes(root);
    expect(all.filter(node=>node.nodeName==='table')).toHaveLength(1);
    expect(all.filter(node=>node.nodeName==='th').map(node=>node.textContent)).toEqual(['','轮次式（半双工/turn-based）','全双工']);
    expect(all.filter(node=>node.nodeName==='td')).toHaveLength(12);
    expect(root.textContent).toContain('你说话时我也在出声');expect(root.textContent).not.toContain('|---|');
    const wrapper=all.find(node=>node.className==='yd-markdown-table-scroll')!;
    expect(wrapper.attributes.role).toBe('region');expect(wrapper.attributes['aria-label']).toContain('横向滚动');
  });
  it('supports omitted outside pipes and column alignment',()=>{
    const root=render('Item | Middle | Amount\n:--- | :---: | ---:\nA | B | 12');
    expect(nodes(root).filter(n=>n.nodeName==='th').map(n=>n.style.textAlign)).toEqual(['left','center','right']);
    expect(nodes(root).filter(n=>n.nodeName==='td').map(n=>n.textContent)).toEqual(['A','B','12']);
  });
  it('keeps escaped pipes, inline code and conditional-probability notation inside their cells',()=>{
    expect(splitTableRow('| A\\|B | `x|y` | \\(p(x|y)\\) |')).toEqual(['A|B','`x|y`','\\(p(x|y)\\)']);
    expect(splitTableRow('| ``a`|b`` | value |')).toEqual(['``a`|b``','value']);
    expect(splitTableRow('| unmatched ` | normal |')).toEqual(['unmatched `','normal']);
  });
  it('pads missing cells, tolerates extra cells and ends at ordinary prose',()=>{
    const table=parseMarkdownTable(['A|B','---|---','one','after'],0)!;
    expect(table.rows).toEqual([]);expect(table.end).toBe(2);
    const uneven=parseMarkdownTable(['A|B','---|---','| left |','one|two|extra','','after'],0)!;
    expect(uneven.rows).toEqual([['left',''],['one','two']]);expect(uneven.end).toBe(4);
  });
  it('uses the same safe inline formatting and real source mapping inside cells',()=>{
    const click=vi.fn(),root=render('| 术语 | 证据 |\n|---|---|\n| **并行**与`token` | [E2] [E99] |',{
      evidenceSources:[{id:'E2',pageIndices:[3]}],onEvidenceCite:click,
    });
    expect(nodes(root).find(n=>n.nodeName==='strong')?.textContent).toBe('并行');
    expect(nodes(root).find(n=>n.nodeName==='code')?.textContent).toBe('token');
    const buttons=nodes(root).filter(n=>n.nodeName==='button');expect(buttons.map(n=>n.textContent)).toEqual(['原文 · 第 4 页']);
    buttons[0].events.click({stopPropagation(){}});expect(click).toHaveBeenCalledWith('E2');expect(root.textContent).toContain('来源未核实');
  });
  it('does not execute raw HTML or unsafe links in table cells',()=>{
    const root=render('| A | B |\n|---|---|\n| <img src=x onerror=alert(1)> | [bad](javascript:evil) |');
    expect(nodes(root).some(n=>['img','script','a'].includes(n.nodeName))).toBe(false);
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');expect(root.textContent).toContain('bad');
  });
  it('does not turn code fences, incomplete streamed separators or ordinary pipes into tables',()=>{
    for(const text of ['```text\nA|B\n---|---\nx|y\n```','A|B\n---|','This sentence contains | a pipe.','A|B\n---|---|---\nx|y']) {
      expect(nodes(render(text)).filter(n=>n.nodeName==='table')).toHaveLength(0);
    }
  });
  it('keeps surrounding paragraphs, consecutive tables and a following heading separate',()=>{
    const root=render('Before.\n\nA|B\n---|---\nx|y\n\nC|D\n---|---\nz|w\n### After | heading\nAfter.');
    expect(nodes(root).filter(n=>n.nodeName==='table')).toHaveLength(2);
    expect(root.children.map(n=>n.nodeName)).toEqual(['p','div','div','h5','p']);
    expect(root.textContent).toContain('After | heading');
  });
});
