import { describe, expect, it } from 'vitest';
import { referenceTransition, ReferenceLimitError } from '../src/evidence/referenceModel';
import { immutableEvidence, reorderEvidence, type EvidenceAttachment } from '../src/evidence/types';
import { inlinePngBlob } from '../src/evidence/repository';

describe('three reference cards', () => {
  it('requires an explicit replacement for a fourth pin, with cancellation leaving the input unchanged', () => {
    const before = { pinnedAssetIds: ['a','b','c'], activeAssetId: 'b' };
    expect(() => referenceTransition(before, {type:'pin',assetId:'d'})).toThrow(ReferenceLimitError);
    expect(before).toEqual({ pinnedAssetIds: ['a','b','c'], activeAssetId: 'b' });
    expect(referenceTransition(before,{type:'pin',assetId:'d',replaceId:'b'})).toEqual({pinnedAssetIds:['a','d','c'],activeAssetId:'d'});
  });
  it('focuses repeated pins without adding duplicates and only expands one', () => {
    expect(referenceTransition({pinnedAssetIds:['a','b'],activeAssetId:'a'},{type:'pin',assetId:'b'})).toEqual({pinnedAssetIds:['a','b'],activeAssetId:'b'});
  });
  it('distinguishes close from unpin without deleting the underlying assets', () => {
    const before={pinnedAssetIds:['a','b'],activeAssetId:'a'};
    expect(referenceTransition(before,{type:'close'})).toEqual({pinnedAssetIds:['a','b'],activeAssetId:null});
    expect(referenceTransition(before,{type:'unpin',assetId:'a'})).toEqual({pinnedAssetIds:['b'],activeAssetId:null});
  });
});
describe('prepared evidence is an immutable material snapshot', () => {
  it('does not change after the draft is reordered, removed or source geometry is edited', () => {
    const draft:EvidenceAttachment[]=[{id:'a',docId:'doc',kind:'text',label:'Definition',pageIndices:[0],text:'α means rate',sourceQuads:[{pageIndex:0,quads:[[{x:1,y:2},{x:3,y:2},{x:3,y:1},{x:1,y:1}]]}]},{id:'b',docId:'doc',kind:'image',label:'Figure',pageIndices:[1],image:'data:image/png;base64,YQ=='}];
    const snapshot=immutableEvidence(draft);
    const sorted=reorderEvidence(draft,0,1);sorted.splice(0,1);draft[0].text='changed';draft[0].pageIndices[0]=9;
    expect(snapshot[0].text).toBe('α means rate');expect(snapshot[0].pageIndices).toEqual([0]);expect(snapshot).toHaveLength(2);
    expect(Object.isFrozen(snapshot[0].sourceQuads?.[0].quads[0][0])).toBe(true);
  });
  it('refuses invalid reorder indices instead of dropping evidence',()=>{expect(()=>reorderEvidence(['a','b'],0,5)).toThrow();});
  it('stores decoded local PNG bytes and rejects a remote URL',async()=>{
    const blob=inlinePngBlob('data:image/png;base64,YWJj');expect(await blob.text()).toBe('abc');expect(blob.type).toBe('image/png');
    expect(()=>inlinePngBlob('https://example.org/paper.png')).toThrow('本地');
  });
});
