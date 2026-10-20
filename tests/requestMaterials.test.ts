import { describe, expect, it } from 'vitest';
import { evidenceMessageContent, labelRequestEvidence } from '../src/ai/requestMaterials';
import type { EvidenceAttachment } from '../src/evidence/types';
const source = (id: string): EvidenceAttachment => ({ id,docId:'doc',kind:'text',label:id,pageIndices:[0],text:id,sourceQuads:[{pageIndex:0,quads:[[{x:1,y:2},{x:3,y:2},{x:3,y:4},{x:1,y:4}]]}] });
describe('request material source identity',()=>{
  it('labels the actual order, retaining stable identity and exact geometry',()=>{
    const primary=source('primary'), other=source('other');
    const first=labelRequestEvidence('doc',[primary,other]);
    expect(first.map(item=>item.label)).toEqual(['E1 · primary','E2 · other']);
    const next=labelRequestEvidence('doc',[other,primary]);
    expect(next[0].id).toBe(first[1].id);
    expect(next[0].label).toBe('E1 · other');
    expect(first[0].sourceQuads).toEqual(primary.sourceQuads);
    expect(Object.isFrozen(first[0].sourceQuads![0].quads[0][0])).toBe(true);
    expect(first.map(item=>item.label)).toEqual(['E1 · primary','E2 · other']);
  });
  it('removing optional context does not leave payload numbering gaps',()=>{
    const result=labelRequestEvidence('doc',[source('selected'),{...source('image'),kind:'image',image:'data:image/png;base64,YQ=='}]);
    expect(result.map(item=>item.label)).toEqual(['E1 · selected','E2 · image']);
    expect(result[1].image).toBe('data:image/png;base64,YQ==');
  });
  it('rejects cross-document evidence before it can enter a request',()=>{
    expect(()=>labelRequestEvidence('doc',[source('selected'),{...source('foreign'),docId:'other'}])).toThrow('其他文献');
  });
});

it('local identity and quads do not change actual model materials or cache-body semantics',()=>{
 const first=source('random-a'),second={...first,id:'random-b',sourceQuads:[]};
 const a=evidenceMessageContent(labelRequestEvidence('doc',[first]));
 const b=evidenceMessageContent(labelRequestEvidence('doc',[second]));
 expect(JSON.stringify(a)).toBe(JSON.stringify(b));expect(JSON.stringify(a)).not.toContain('random-b');
});
