import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../src/viewer/markdown';
class TestNode {
  children: TestNode[] = []; attributes: Record<string,string> = {}; events: Record<string,(event:unknown)=>void> = {};
  innerHTML = ''; className = ''; style: {textAlign?:string} = {};
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

const tags=(root:TestNode,tag:string)=>nodes(root).filter(n=>n.nodeName===tag);
describe('complete answer rendering regression',()=>{
  it('handles soft-wrapped quotations and nested inline emphasis without marker residue',()=>{
    const root=render('> first line\ncontinued **bold *italic***\n\nOutside');
    expect(tags(root,'blockquote')[0].textContent).toBe('first line continued bold italic');
    expect(tags(root,'em')).toHaveLength(1);expect(root.children.at(-1)?.textContent).toBe('Outside');
  });

  it('renders the reported quotation and preserves a clickable, verified source',()=>{
    const click=vi.fn(), root=render('> “unlike text LLMs or half-duplex systems, full-duplex models continuously generate tokens frame by frame,\n> even while listening.” **[E1]**',{evidenceSources:[{id:'E1',pageIndices:[0]}],onEvidenceCite:click});
    expect(tags(root,'blockquote')).toHaveLength(1);expect(root.textContent).not.toContain('>');
    const button=tags(root,'button')[0];expect(button.textContent).toBe('原文 · 第 1 页');button.events.click({stopPropagation(){}});expect(click).toHaveBeenCalledWith('E1');
  });
  it('keeps nested quotes, table and subsequent prose in the right containers',()=>{
    const root=render('> outer\n>\n> > inner\n>\n> A|B\n> ---|---\n> a|b\n\nAfter');
    expect(tags(root,'blockquote')).toHaveLength(2);expect(tags(root,'table')).toHaveLength(1);expect(root.children.at(-1)?.textContent).toBe('After');
  });
  it('preserves ordered numbering, nested lists and paragraph order',()=>{
    const root=render('Before\n3. first\n   - child\n   - next\n4. second\n\nAfter');
    expect(root.children.map(n=>n.nodeName)).toEqual(['p','ol','p']);expect(tags(root,'ol')[0].attributes.start).toBe('3');expect(tags(root,'ul')).toHaveLength(1);expect(tags(root,'li')).toHaveLength(4);
  });
  it('renders task lists read-only, rules and six heading levels',()=>{
    const root=render('- [x] done\n- [ ] todo\n\n---\n###### detail\n\nTitle\n===');
    expect(tags(root,'input')).toHaveLength(2);expect(tags(root,'input')[0].attributes.disabled).toBe('true');expect(tags(root,'hr')).toHaveLength(1);expect(tags(root,'h6')).toHaveLength(1);expect(tags(root,'h3')).toHaveLength(1);
  });
  it('supports emphasis variants, strikethrough, escaped punctuation and explicit line breaks',()=>{
    const root=render('***both*** __bold__ _italic_ ~~removed~~ variable_name\n\nline  \nnext');
    expect(tags(root,'strong')).toHaveLength(2);expect(tags(root,'em')).toHaveLength(2);expect(tags(root,'del')).toHaveLength(1);expect(tags(root,'br')).toHaveLength(1);expect(root.textContent).toContain('variable_name');
    expect(tags(render(String.raw`\*literal\* and \[E1]`,{evidenceIds:['E1'],onEvidenceCite:()=>{}}),'button')).toHaveLength(0);
  });
  it('keeps code literal with tilde fences, longer fences and multi-backtick spans',()=>{
    const root=render('~~~~js\n> literal\n```\n[E1]\n~~~~\n\n``a`|b``');
    expect(tags(root,'pre')).toHaveLength(1);expect(tags(root,'blockquote')).toHaveLength(0);expect(tags(root,'code').map(n=>n.textContent)).toEqual(['> literal\n```\n[E1]','a`|b']);
  });
  it('handles dollar and slash math, one-line display math, incomplete math and currency',()=>{
    const root=render(String.raw`$x^2$ and \(y\)

$$x+y$$

\[
x^2
\]

$20 and $30`);
    expect(nodes(root).filter(n=>n.className==='yd-inline-math')).toHaveLength(2);expect(nodes(root).filter(n=>n.className==='yd-answer-math')).toHaveLength(2);expect(root.textContent).toContain('$20 and $30');
    expect(render('$$\nx+y').textContent).toContain('x+y');
  });
  it('does not load remote images, execute HTML or promote unsafe links and unknown citations',()=>{
    const root=render('> <script>alert(1)</script> [bad](javascript:evil) ![plot](https://example.com/a.png) [E99]',{evidenceSources:[],onEvidenceCite:()=>{}});
    expect(tags(root,'script')).toHaveLength(0);expect(tags(root,'img')).toHaveLength(0);expect(tags(root,'button')).toHaveLength(0);expect(tags(root,'a')).toHaveLength(1);expect(root.textContent).toContain('来源未核实');
  });
  it('renders mixed saved answers identically on repeat and handles unfinished fences without losing text',()=>{
    const text='## Answer\n\n> quote [E1]\n\n1. **step**\n2. result\n\nA|B\n---|---\nx|y\n\n~~~\nunfinished';
    expect(render(text).textContent).toBe(render(text).textContent);expect(render(text).textContent).toContain('unfinished');
    expect(tags(render(text),'table')).toHaveLength(1);expect(tags(render(text),'ol')).toHaveLength(1);
  });
});
