import { describe, expect, it } from 'vitest';
import { formulaSegmentAppend, formulaSegmentOrder, formulaSegmentRemove, formulaSegmentReplace, formulaCandidateApplicable } from '../src/viewer/formulaWorkspace';
import type { FormulaSegmentRef } from '../src/formula/model';
function segment(id:string,pageIndex:number):FormulaSegmentRef{return {assetId:`asset-${id}`,assetVersion:3,segmentId:id,pageIndex,quad:[{x:11,y:18},{x:31,y:18},{x:31,y:9},{x:11,y:9}],cropBlob:new Blob([id],{type:'image/png'}),hash:`hash-${id}`,width:20,height:9,order:0,rotation:90};}
describe('formula workspace fragment editing preserves authoritative evidence',()=>{
 it('reorders cross-page fragments by explicit user order without changing source coordinates or identity',()=>{
  const fragments=[segment('first',4),segment('second',0),segment('third',8)];
  const result=formulaSegmentOrder(fragments,2,0);
  expect(result.map(item=>item.pageIndex)).toEqual([8,4,0]);
  expect(result.map(item=>item.order)).toEqual([0,1,2]);
  expect(result[0]).toMatchObject({assetId:'asset-third',assetVersion:3,segmentId:'third',rotation:90,quad:fragments[2].quad});
  expect(fragments.map(item=>item.segmentId)).toEqual(['first','second','third']);
  result[0].quad[0].x=900;expect(fragments[2].quad[0].x).toBe(11);
 });
 it('rejects overflow without dropping the ninth input or changing the existing list',()=>{
  const original=Array.from({length:8},(_,i)=>segment(String(i),i));
  expect(()=>formulaSegmentAppend(original,segment('ninth',9))).toThrow(/最多8/);
  expect(original).toHaveLength(8);
  const appended=formulaSegmentAppend(original.slice(0,7),segment('eighth',12));
  expect(appended).toHaveLength(8);expect(appended[7].pageIndex).toBe(12);
 });
 it('replaces only the explicitly chosen fragment, retaining other page and version references',async()=>{
  const first=segment('first',2),second=segment('second',6),replacement=segment('replacement',9);
  const result=formulaSegmentReplace([first,second],0,replacement);
  expect(result.map(item=>item.segmentId)).toEqual(['replacement','second']);
  expect(result[1]).toMatchObject({...second,order:1});
  expect(await result[0].cropBlob.text()).toBe('replacement');
  expect(first.segmentId).toBe('first');
 });
 it('does not permit empty formula evidence or implicit removal of an invalid index',()=>{
  expect(()=>formulaSegmentRemove([segment('only',0)],0)).toThrow(/至少保留/);
  const result=formulaSegmentRemove([segment('a',0),segment('b',2)],0);
  expect(result).toHaveLength(1);expect(result[0].segmentId).toBe('b');expect(result[0].order).toBe(0);
  expect(()=>formulaSegmentRemove(result,-1)).toThrow(/不存在/);
  expect(()=>formulaSegmentOrder(result,0,9)).toThrow(/无效/);
  expect(()=>formulaSegmentReplace(result,1,segment('x',1))).toThrow(/不存在/);
 });
 it('blocks applying candidates while there are unsaved edits or an in-flight request',()=>{
  expect(formulaCandidateApplicable(true,false)).toBe(false);
  expect(formulaCandidateApplicable(false,true)).toBe(false);
  expect(formulaCandidateApplicable(true,true)).toBe(false);
  expect(formulaCandidateApplicable(false,false)).toBe(true);
 });
});
