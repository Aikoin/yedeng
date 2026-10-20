import {describe,expect,it} from 'vitest';
import {projectFormula,validateFormulaSegments,type FormulaHead,type FormulaSourceRevision,type FormulaExplanation,type FormulaSegmentRef} from '../src/formula/model';
const segment:FormulaSegmentRef={assetId:'a',assetVersion:1,segmentId:'s',pageIndex:0,quad:[{x:1,y:3},{x:2,y:3},{x:2,y:1},{x:1,y:1}],cropBlob:new Blob(['png'],{type:'image/png'}),hash:'abc',width:10,height:20,order:0,rotation:0};
const source:FormulaSourceRevision={id:'rev1',assetId:'f',formulaId:'f',docId:'doc',kind:'source',latex:'x+1',revision:1,segments:[segment],checkedByUser:false,createdAt:1};
const head:FormulaHead={id:'f',assetId:'f',formulaId:'f',docId:'doc',kind:'head',latex:'x+2',sourceRevisionId:'rev2',revision:2,checkedByUser:false,checkedAt:null,createdAt:1};
const explanation:FormulaExplanation={id:'e',assetId:'f',formulaId:'f',docId:'doc',kind:'explanation',latex:'x+1',text:'Old explanation',sourceRevisionId:'rev1',accepted:true,stale:false,checkedByUser:false,createdAt:2};
describe('formula revision projection',()=>{
 it('marks old accepted explanations stale after changing source, without inheriting formula approval',()=>{const current={...source,id:'rev2',revision:2,latex:'x+2'};const view=projectFormula(head,[source,current,explanation,head]);expect(view.explanations[0]).toMatchObject({accepted:true,stale:true,sourceRevisionId:'rev1'});expect(view.checkedByUser).toBe(false);expect(explanation.stale).toBe(false);});
 it('refuses a missing head revision rather than showing another revision as current',()=>{expect(()=>projectFormula(head,[source])).toThrow('修订缺失');});
 it('rejects invalid or too many image segments and accepts ordered multi-page source snapshots',()=>{expect(()=>validateFormulaSegments([segment,{...segment,segmentId:'s2',pageIndex:4,order:1}])).not.toThrow();expect(()=>validateFormulaSegments(Array.from({length:9},()=>segment))).toThrow('1至8');expect(()=>validateFormulaSegments([{...segment,quad:[{x:NaN,y:0},{x:1,y:1},{x:2,y:2},{x:3,y:3}]}])).toThrow('可靠原图');});
});
it('projects legacy heads without deletion metadata and preserves complete sources across soft deletion',()=>{
 const current={...source,id:'rev2',revision:2,latex:'x+2'};const rows=[source,current,explanation,head];
 const legacy=projectFormula(head,rows);expect(legacy.deletedAt).toBeUndefined();
 const removed=projectFormula({...head,deletedAt:123,revision:3},rows);expect(removed.deletedAt).toBe(123);expect(removed.history).toEqual(legacy.history);expect(removed.explanations).toEqual(legacy.explanations);expect(removed.segments).toEqual(legacy.segments);
 const restored=projectFormula({...head,deletedAt:null,revision:4},rows);expect(restored.deletedAt).toBeNull();expect(restored.latex).toBe('x+2');expect(restored.explanations[0].stale).toBe(true);
});
