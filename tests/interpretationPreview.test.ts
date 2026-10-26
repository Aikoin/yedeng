import {expect,it} from 'vitest';
import {legacySelectionPreview} from '../src/viewer/interpretationPreview';
import type {PageText} from '../src/pdf/extract';
const page:PageText={pageIndex:0,width:600,height:800,text:'',paragraphs:[],lines:[{pageIndex:0,x:20,xEnd:200,y:100,h:10,text:'Selected line'},{pageIndex:0,x:20,xEnd:200,y:80,h:10,text:'Unrelated line'},{pageIndex:0,x:300,xEnd:500,y:100,h:10,text:'Other column'}]};
it('recovers only source-overlapping lines, not other columns or nearby lines',()=>{
 expect(legacySelectionPreview({id:'s',label:'source',pageIndices:[0],sourceQuads:[{pageIndex:0,quads:[[{x:25,y:100},{x:180,y:100},{x:180,y:110},{x:25,y:110}]]}]},[page])).toBe('Selected line');
});
it('does not invent a sentence when legacy geometry or extracted text is missing',()=>{
 expect(legacySelectionPreview(undefined,[page])).toBe('');expect(legacySelectionPreview({id:'s',label:'source',pageIndices:[0]},[page])).toBe('');
});
