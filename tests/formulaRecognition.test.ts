import {describe,expect,it} from 'vitest';
import {formulaMessages,parseFormulaCandidate,type FormulaRecognitionInput} from '../src/ai/formulaRecognition';
const input:FormulaRecognitionInput={docId:'d',sessionGeneration:1,sourceRevision:'r1',images:[{id:'local-a',label:'公式上半',image:'data:image/png;base64,YQ==',pageIndex:0},{id:'local-b',label:'公式下半',image:'data:image/png;base64,Yg==',pageIndex:1}],context:'x is a scalar',latex:'x^2'};
describe('formula preparation materials',()=>{
 it('retains whole ordered source images and explicit context without sending local identifiers',()=>{
 const messages=formulaMessages({...input,evidence:[{id:'local-c',docId:'d',kind:'text',label:'定义',pageIndices:[2],text:'[E1] is literal source text'}]});
 const blocks=messages[1].content as Array<{type:string;text?:string;image_url?:{url:string}}>;
 expect(blocks.filter(b=>b.type==='image_url').map(b=>b.image_url!.url)).toEqual(input.images.map(i=>i.image));
 expect(JSON.stringify(messages)).not.toContain('local-a');expect(JSON.stringify(messages)).not.toContain('r1');
 expect(blocks.some(b=>b.text?.startsWith('[E3]'))).toBe(true);expect(blocks.some(b=>b.text==='[E1] is literal source text')).toBe(true);
 expect(blocks.some(b=>b.text?.includes('x is a scalar'))).toBe(true);
 });
 it('rejects incomplete or cross-document materials instead of silently dropping them',()=>{
 expect(()=>formulaMessages({...input,images:[]})).toThrow();expect(()=>formulaMessages({...input,evidence:[{id:'x',docId:'foreign',kind:'text',label:'foreign',pageIndices:[],text:'bad'}]})).toThrow('其他文献');
 });
 it('parses candidates without evaluating macros or inventing a valid result on malformed output',()=>{
 expect(parseFormulaCandidate('{"latex":"\\\\input{private}","warnings":["unclear"]}')).toEqual({latex:'\\input{private}',warnings:['unclear'],status:'candidate_needs_review'});
 expect(parseFormulaCandidate('not json')).toBeNull();expect(parseFormulaCandidate('{"latex":""}')).toBeNull();expect(parseFormulaCandidate('```json\n{"latex":"x^2","warnings":[]}\n```')).toEqual({latex:'x^2',warnings:[],status:'candidate_needs_review'});
 });
});
