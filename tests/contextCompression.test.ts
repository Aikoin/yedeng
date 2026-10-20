import { describe, expect, it } from 'vitest';
import { compressSelectionContext, formatSelectionContext } from '../src/ai/contextCompression';
import type { PageText } from '../src/pdf/extract';
import type { PdfQuad } from '../src/pdf/geometry';
const para=(text:string,y:number)=>({text,pageIndex:0,x:0,xEnd:400,yTop:y,yBottom:y-20,lines:[]});
const page:PageText={pageIndex:0,width:400,height:800,text:'',lines:[],paragraphs:[para('Assume x > 0 and n = 2.',700),para('Same repeated sentence.',650),para('Boundary condition: y ≠ 0.',600),para('Same repeated sentence.',550),para('The second occurrence uses β = 5.',500)]};
const quad=(y:number):PdfQuad=>[{x:0,y},{x:100,y},{x:100,y:y-10},{x:0,y:y-10}];
describe('local extractive selection context',()=>{
 it('uses geometry to locate the second repeated sentence and preserves nearby conditions',()=>{
  const c=compressSelectionContext({selectedText:'Same repeated sentence.',regions:[{pageIndex:0,quads:[quad(548)]}],pages:[page]});
  expect(c.excerpts.some(e=>e.text.includes('β = 5'))).toBe(true);expect(c.excerpts.some(e=>e.text.includes('n = 2'))).toBe(false);
 });
 it('does not guess the first duplicate without coordinates',()=>{
  const c=compressSelectionContext({selectedText:'Same repeated sentence.',regions:[{pageIndex:0,quads:[]}],pages:[page]});
  expect(c.excerpts).toHaveLength(0);expect(c.notes.join()).toContain('有歧义');
 });
 it('keeps original selection byte-for-byte and excludes an oversized paragraph instead of clipping mathematics',()=>{
  const selection=' n = 2\n and x > 0 ';
  const c=compressSelectionContext({selectedText:selection,regions:[{pageIndex:0,quads:[quad(698)]}],pages:[page],maxContextChars:10});
  expect(c.selection).toBe(selection);expect(c.contextChars).toBe(0);expect(c.notes.join()).toContain('未裁断');
 });
 it('uses both selected pages before neighbors and never reads other pages',()=>{
  const p2={...page,pageIndex:1,paragraphs:[para('SECOND PAGE assumption λ > 1',700)]};
  const irrelevant={...page,pageIndex:9,paragraphs:[para('SECRET FULL PAPER FALLBACK',700)]};
  const c=compressSelectionContext({selectedText:'cross page',regions:[{pageIndex:0,quads:[quad(698)]},{pageIndex:1,quads:[quad(698)]}],pages:[page,p2,irrelevant]});
  expect(c.excerpts.slice(0,2).map(e=>e.pageIndex)).toEqual([0,1]);expect(formatSelectionContext(c)).not.toContain('SECRET');
 });
 it('reports missing text and rejects oversized selection instead of silently losing text',()=>{
  expect(compressSelectionContext({selectedText:'ok',regions:[{pageIndex:6,quads:[]}],pages:[]}).notes.join()).toContain('尚未提取');
  expect(()=>compressSelectionContext({selectedText:'x'.repeat(16001),regions:[],pages:[]})).toThrow('不会自动截断');
 });
});
