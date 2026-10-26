import { describe, expect, it, vi } from 'vitest';
import { prepareRequest } from '../src/ai/preparedRequest';
import { sendPreparedTransport, preparedBody } from '../src/ai/openai';
async function request(stream=true) {return prepareRequest({type:'document_action',action:'explain',docId:'d',sessionGeneration:1,policyVersion:1,providerId:'p',providerRevision:1,endpoint:'https://example.test/exact',model:'m',messages:[{role:'system',content:'Visible system'},{role:'user',content:[{type:'text',text:'Visible selected text'},{type:'image_url',image_url:{url:'data:image/png;base64,YWJj',detail:'high'}}]}],parameters:{temperature:0,maxTokens:20,stream}});}
function sse(parts:string[],open=false){return new Response(new ReadableStream({start(c){for(const part of parts)c.enqueue(new TextEncoder().encode(part));if(!open)c.close();}}),{headers:{'Content-Type':'text/event-stream'}});}
describe('exact prepared transport (synthetic HTTP responses)',()=>{
 it('posts exactly the preview body once, with credential only in the header and redirects rejected',async()=>{
  const draft=await request(false),mock=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:1}}),{headers:{'Content-Type':'application/json'}}));
  const result=await sendPreparedTransport(draft,{apiKey:'synthetic-fixture-key',signal:new AbortController().signal,fetchImplementation:mock});
  expect(result).toEqual({text:'done',usage:{promptTokens:4,completionTokens:1}});expect(mock).toHaveBeenCalledOnce();
  const [url,init]=mock.mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe(draft.endpoint);expect(init.redirect).toBe('error');expect(String(init.body)).toBe(JSON.stringify(preparedBody(draft)));expect(String(init.body)).not.toContain('test-secret');
 });
 it('decodes split SSE events and finishes on DONE even when the service does not close the socket',async()=>{
  const d=await request(),deltas:string[]=[];
  const mock=vi.fn(async()=>sse(['data: {"choices":[{"delta":{"con','tent":"first"}}]}\r\n\r\n','data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":1}}\n\n','data: [DONE]\n\n'],true));
  const answer=await sendPreparedTransport(d,{apiKey:'fake',signal:new AbortController().signal,fetchImplementation:mock,onDelta:value=>deltas.push(value)});
  expect(deltas).toEqual(['first']);expect(answer.text).toBe('first');expect(answer.usage.promptTokens).toBe(9);expect(mock).toHaveBeenCalledOnce();
 });
 it('does not label a truncated stream as complete or silently issue a second HTTP call',async()=>{
  const d=await request(),mock=vi.fn(async()=>sse(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']));
  await expect(sendPreparedTransport(d,{apiKey:'fake',signal:new AbortController().signal,fetchImplementation:mock})).rejects.toThrow('中断');expect(mock).toHaveBeenCalledOnce();
 });
 it('rejects length-limited output while preserving delivered deltas',async()=>{
  const d=await request(),parts:string[]=[];
  const mock=vi.fn(async()=>sse(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n','data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n']));
  await expect(sendPreparedTransport(d,{apiKey:'fake',signal:new AbortController().signal,fetchImplementation:mock,onDelta:value=>parts.push(value)})).rejects.toMatchObject({name:'AiOutputLimitError',partialText:'partial',maxTokens:20});expect(parts).toEqual(['partial']);
 });
 it('status errors do not echo untrusted provider body or retry',async()=>{
  const d=await request(),mock=vi.fn(async()=>new Response('KEY-secret + private paper text',{status:429}));
  try{await sendPreparedTransport(d,{apiKey:'fake',signal:new AbortController().signal,fetchImplementation:mock});throw new Error('expected rejection');}catch(error){expect(String(error)).toContain('429');expect(String(error)).not.toContain('KEY-secret');expect(String(error)).not.toContain('private paper');}expect(mock).toHaveBeenCalledOnce();
 });
});

it('sends visible thinking only when it is part of the prepared official request',async()=>{
  const original=await request(false);
  const draft=await prepareRequest({...original,endpoint:'https://api.deepseek.com/chat/completions',model:'deepseek-flash',parameters:{stream:false,thinking:'disabled'}});
  const mock=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}]}),{headers:{'Content-Type':'application/json'}}));
  await sendPreparedTransport(draft,{apiKey:'fake',signal:new AbortController().signal,fetchImplementation:mock});
  const body=JSON.parse(String((mock.mock.calls[0] as unknown as [string,RequestInit])[1].body));
  expect(body).toEqual(preparedBody(draft));expect(body.thinking).toEqual({type:'disabled'});
  expect(preparedBody(original)).not.toHaveProperty('thinking');expect(mock).toHaveBeenCalledOnce();
});

it('reports empty length-limited JSON honestly, without claiming text was retained',async()=>{
 const d=await request(false),mock=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:''},finish_reason:'length'}]}),{headers:{'Content-Type':'application/json'}}));
 await expect(sendPreparedTransport(d,{apiKey:'fake',signal:new AbortController().signal,fetchImplementation:mock})).rejects.toMatchObject({name:'AiOutputLimitError',partialText:'',maxTokens:20,message:expect.stringContaining('尚未返回')});expect(mock).toHaveBeenCalledOnce();
});
