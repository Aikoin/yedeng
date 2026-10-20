import { afterEach, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../src/viewer/markdown';
class TestNode {
 children:TestNode[]=[];attributes:Record<string,string>={};events:Record<string,(event:unknown)=>void>={};className='';style={};
 constructor(public nodeName:string,public data=''){}
 appendChild(node:TestNode){this.children.push(node);return node;}
 setAttribute(k:string,v:string){this.attributes[k]=v;}
 addEventListener(k:string,fn:(e:unknown)=>void){this.events[k]=fn;}
 get textContent():string{return this.data+this.children.map(c=>c.textContent).join('');}
}
const descendants=(node:TestNode):TestNode[]=>[node,...node.children.flatMap(descendants)];
afterEach(()=>vi.unstubAllGlobals());
it('renders only supplied page/evidence citations as navigation and leaves invented references literal',()=>{
 vi.stubGlobal('document',{createElement:(tag:string)=>new TestNode(tag),createDocumentFragment:()=>new TestNode('#fragment'),createTextNode:(text:string)=>new TestNode('#text',text)});
 const onCite=vi.fn(),onEvidenceCite=vi.fn();
 const root=renderMarkdown('Valid [p.2] [E1]; invalid [p.999] [p.0] [E99].',{onCite,onEvidenceCite,validPageIndices:[1],evidenceIds:['E1']})as unknown as TestNode;
 const buttons=descendants(root).filter(n=>n.nodeName==='button');expect(buttons.map(n=>n.textContent)).toEqual(['p.2','原文证据']);
 expect(root.textContent).toContain('[p.999]');expect(root.textContent).toContain('[p.0]');expect(root.textContent).toContain('来源未核实');
 buttons.forEach(button=>button.events.click({stopPropagation(){}}));expect(onCite).toHaveBeenCalledWith(1);expect(onEvidenceCite).toHaveBeenCalledWith('E1');
});
it('does not manufacture page buttons when the caller supplied no navigation callback',()=>{
 vi.stubGlobal('document',{createElement:(tag:string)=>new TestNode(tag),createDocumentFragment:()=>new TestNode('#fragment'),createTextNode:(text:string)=>new TestNode('#text',text)});
 const root=renderMarkdown('Unverified output [p.2] [E1]')as unknown as TestNode;
 expect(descendants(root).filter(n=>n.nodeName==='button')).toHaveLength(0);expect(root.textContent).toContain('[p.2]');
});

it('uses the exact answer source mapping for page labels, never E9 as equation 9 or a guessed current request',()=>{
 vi.stubGlobal('document',{createElement:(tag:string)=>new TestNode(tag),createDocumentFragment:()=>new TestNode('#fragment'),createTextNode:(text:string)=>new TestNode('#text',text)});
 const click=vi.fn();const root=renderMarkdown('Valid [E9]; invented [E7].',{evidenceSources:[{id:'E9',pageIndices:[18]}],onEvidenceCite:click})as unknown as TestNode;
 const buttons=descendants(root).filter(n=>n.nodeName==='button');expect(buttons.map(n=>n.textContent)).toEqual(['原文 · 第 19 页']);expect(root.textContent).toContain('来源未核实');
 buttons[0].events.click({stopPropagation(){}});expect(click).toHaveBeenCalledWith('E9');
});
it('does not enable an evidence jump from an ID alone unless an explicit allowlist is present',()=>{
 vi.stubGlobal('document',{createElement:(tag:string)=>new TestNode(tag),createDocumentFragment:()=>new TestNode('#fragment'),createTextNode:(text:string)=>new TestNode('#text',text)});
 const root=renderMarkdown('[E1]',{onEvidenceCite:vi.fn()})as unknown as TestNode;expect(descendants(root).filter(n=>n.nodeName==='button')).toHaveLength(0);
});
