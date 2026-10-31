import { expect, it } from 'vitest';
import { appendChatTurn, appendChatQuestion } from '../src/shared/documentChat';
it('preserves concurrent turns and makes persisting a completed turn idempotent',()=>{
 const source={id:'E1',label:'page',pageIndices:[3],text:'evidence',truncated:false};
 const first={id:'a',question:'Q1',answer:'A1',at:1,sources:[source]};
 const second={id:'b',question:'Q2',answer:'A2',at:2,sources:[source]};
 const result=appendChatTurn(appendChatTurn([],first),second);
 expect(result.map(m=>m.content)).toEqual(['Q1','A1','Q2','A2']);
 expect(appendChatTurn(result,first)).toBe(result);
 source.pageIndices[0]=999;expect(result[1].sources![0].pageIndices).toEqual([3]);
});

it('completes a journaled question without duplication and preserves interleaved turns',()=>{
 const question={id:'pending',question:'Q',at:1};const pending=appendChatQuestion([],question);
 expect(appendChatQuestion(pending,question)).toBe(pending);
 const interleaved=appendChatTurn(pending,{id:'other',question:'Other',answer:'Other answer',at:2,sources:[]});
 const complete=appendChatTurn(interleaved,{...question,answer:'Answer',sources:[]});
 expect(complete.map(m=>m.content)).toEqual(['Q','Answer','Other','Other answer']);
 expect(appendChatTurn(complete,{...question,answer:'duplicate',sources:[]})).toBe(complete);
});
