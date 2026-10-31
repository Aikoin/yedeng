import { describe, expect, it, vi } from 'vitest';
import { createRequestDispatcher, PROBE_FIXTURES, type DispatcherDependencies, type RuntimeState, type RequestScope } from '../src/ai/dispatcher';
import type { sendPreparedTransport } from '../src/ai/openai';
import { authorizeExplicitSend, type PreparedRequest } from '../src/ai/preparedRequest';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import { preparedBody } from '../src/ai/openai';
import { prepareDocumentContext } from '../src/ai/documentContext';
import type { DocText } from '../src/pdf/extract';
function harness(overrides:Partial<DispatcherDependencies>={}) {
  const settings=structuredClone(DEFAULT_SETTINGS);
  settings.providers=[{id:'p',name:'Synthetic test',kind:'openai',baseUrl:'https://example.test/v1',apiKey:'fake-only',models:['m'],defaultModel:'m',temperature:.1,maxTokens:128,imageInput:'declared'}];
  const runtime:RuntimeState={context:{providerId:'p',providerRevision:0,endpoint:'https://example.test/v1/chat/completions',model:'m',document:{docId:'d',sessionGeneration:1,policyVersion:1,policy:'allowed_to_configured_provider'}},
    privateFingerprint:'private-config-v1',apiKey:'fake-only',settings,providerName:'Synthetic test',timeZone:'UTC',imageInput:'declared'};
  let session={docId:'d',sessionGeneration:1 as number|null};
  const reserve=vi.fn(async()=>({id:'attempt',dayKey:'2026-10-19',taskId:'task',docId:'d',attemptedAt:1}));
  const transport=vi.fn(async(_request:PreparedRequest,_options:Parameters<typeof sendPreparedTransport>[1])=>({text:'synthetic reply',usage:{promptTokens:10,completionTokens:2}}));
  const readResult=vi.fn(async():Promise<string|null>=>null),writeResult=vi.fn(async()=>{});
  const dispatcher=createRequestDispatcher({readRuntime:async()=>runtime,currentSession:()=>session,reserve,readResult,writeResult,transport,...overrides});
  const scope:RequestScope={type:'document_action',feature:'explain',action:'explain',docId:'d',sessionGeneration:1};
  const prepare=()=>dispatcher.prepare(scope,[{role:'system',content:'Visible instruction'},{role:'user',content:'Selected text only'}]);
  return {dispatcher,runtime,reserve,transport,readResult,writeResult,prepare,scope,setSession:(value:typeof session)=>{session=value;}};
}
describe('production prepared dispatcher (synthetic transport, no real API)',()=>{
  it('sends complete short-paper evidence once and respects configured chat output/thinking defaults',async()=>{
    const h=harness();h.runtime.settings.providers[0].maxTokens=4096;
    h.runtime.context.endpoint='https://api.deepseek.com/chat/completions';h.runtime.context.model='deepseek-v4-pro';
    const texts=['Synthetic introduction','Synthetic middle','Full-duplex models simultaneously listen and speak.'];
    const doc:DocText={pages:texts.map((text,pageIndex)=>({pageIndex,text,width:600,height:800,lines:[],paragraphs:[]})),sections:[],hasText:true,documentText:texts.join('\n'),headText:'',tailText:''};
    const context=prepareDocumentContext({action:'chat',title:'Synthetic paper',doc,totalPages:3,question:'啥是全双工模型'});
    const scope={...h.scope,feature:'chat' as const,action:'document_chat',resultSources:context.sources};
    const prepared=await h.dispatcher.prepare(scope,context.messages,{temperature:.2});
    await h.dispatcher.send(prepared,authorizeExplicitSend(prepared.request));
    expect(h.transport).toHaveBeenCalledOnce();expect(h.reserve).toHaveBeenCalledOnce();
    expect(h.transport.mock.calls[0][0].parameters?.maxTokens).toBe(4096);
    expect(h.transport.mock.calls[0][0].parameters).not.toHaveProperty('thinking');
    expect(JSON.stringify(h.transport.mock.calls[0][0].messages)).toContain(texts[2]);
    const changed=prepareDocumentContext({action:'chat',title:'Synthetic paper',doc:{...doc,pages:doc.pages.map((p,i)=>i===2?{...p,text:'Changed source definition.'}:p)},totalPages:3,question:'啥是全双工模型'});
    const updated=await h.dispatcher.prepare({...scope,resultSources:changed.sources},changed.messages,{temperature:.2});
    expect(updated.cacheKey).not.toBe(prepared.cacheKey);
  });
  it('explicit zero removes legacy output defaults from the final HTTP payload',async()=>{
    const h=harness();h.runtime.settings.providers[0].maxTokens=2048;
    const draft=await h.dispatcher.prepare({...h.scope,feature:'chat',action:'document_chat'},[{role:'user',content:'Explain'}],{maxTokens:0});
    expect(draft.request.parameters).not.toHaveProperty('maxTokens');
    expect(preparedBody(draft.request)).not.toHaveProperty('max_tokens');
    await h.dispatcher.send(draft,authorizeExplicitSend(draft.request));
    expect(preparedBody(h.transport.mock.calls[0][0])).not.toHaveProperty('max_tokens');
  });
  it('freezes exact visible material and duplicate clicks create one attempt/send',async()=>{
    const h=harness(),draft=await h.prepare();
    const results=await Promise.allSettled([h.dispatcher.send(draft,authorizeExplicitSend(draft.request)),h.dispatcher.send(draft,authorizeExplicitSend(draft.request))]);
    expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);expect(h.reserve).toHaveBeenCalledOnce();expect(h.transport).toHaveBeenCalledOnce();
    expect(h.transport.mock.calls[0][0].messages).toEqual(draft.request.messages);expect(Object.isFrozen(draft.request.messages)).toBe(true);
  });
  it('cache hits consume no attempt and do not invoke transport',async()=>{
    const h=harness();h.readResult.mockResolvedValue('saved reply');const d=await h.prepare();
    expect(await h.dispatcher.send(d,authorizeExplicitSend(d.request))).toMatchObject({text:'saved reply',fromCache:true});
    expect(h.reserve).not.toHaveBeenCalled();expect(h.transport).not.toHaveBeenCalled();
  });
  for(const change of ['deny','policyVersion','keyFingerprint','providerRevision','session'] as const){
    it(`rejects changed ${change} before cache or send`,async()=>{
      const h=harness(),d=await h.prepare();h.readResult.mockResolvedValue('must not present stale result as new');
      if(change==='deny')h.runtime.context.document!.policy='deny_all_ai';
      if(change==='policyVersion')h.runtime.context.document!.policyVersion++;
      if(change==='keyFingerprint')h.runtime.privateFingerprint='changed-secret-private-hash';
      if(change==='providerRevision')h.runtime.privateFingerprint='revision-also-in-private-hash';
      if(change==='session')h.setSession({docId:'d',sessionGeneration:2});
      await expect(h.dispatcher.send(d,authorizeExplicitSend(d.request))).rejects.toThrow();
      expect(h.readResult).not.toHaveBeenCalled();expect(h.reserve).not.toHaveBeenCalled();expect(h.transport).not.toHaveBeenCalled();
    });
  }
  it('preparation is allowed under default deny but dispatch is not',async()=>{
    const h=harness();delete h.runtime.context.document!.policy;const d=await h.prepare();
    expect(d.policy).toBe('deny_all_ai');await expect(h.dispatcher.send(d,authorizeExplicitSend(d.request))).rejects.toThrow();expect(h.reserve).not.toHaveBeenCalled();
  });
  it('rechecks policy after the quota reservation',async()=>{
    const h=harness(),d=await h.prepare();h.reserve.mockImplementation(async()=>{h.runtime.context.document!.policy='deny_all_ai';return{id:'reserved',dayKey:'day',taskId:'t',docId:'d',attemptedAt:1};});
    await expect(h.dispatcher.send(d,authorizeExplicitSend(d.request))).rejects.toThrow();expect(h.reserve).toHaveBeenCalledOnce();expect(h.transport).not.toHaveBeenCalled();
  });
  it('unknown image capability is rejected at final boundary, not only in UI',async()=>{
    const h=harness();h.runtime.imageInput='unknown';const d=await h.dispatcher.prepare(h.scope,[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,YWJj'}}]}]);
    await expect(h.dispatcher.send(d,authorizeExplicitSend(d.request))).rejects.toThrow('图像');expect(h.reserve).not.toHaveBeenCalled();
  });
  it('failures/cancellation never cache partial output or retry',async()=>{
    const h=harness();h.transport.mockRejectedValue(new Error('synthetic network failure'));const d=await h.prepare();
    await expect(h.dispatcher.send(d,authorizeExplicitSend(d.request))).rejects.toThrow('synthetic');expect(h.transport).toHaveBeenCalledOnce();expect(h.writeResult).not.toHaveBeenCalled();
    const h2=harness(),controller=new AbortController();h2.reserve.mockImplementation(async()=>{controller.abort();return{id:'r',dayKey:'day',taskId:'t',docId:'d',attemptedAt:1};});
    const d2=await h2.prepare();await expect(h2.dispatcher.send(d2,authorizeExplicitSend(d2.request),{signal:controller.signal})).rejects.toThrow();expect(h2.transport).not.toHaveBeenCalled();
  });
  it('validates global synthetic fixtures and does not accept document snippets as probes',async()=>{
    const h=harness();const scope:RequestScope={...h.scope,type:'global_probe',docId:null,sessionGeneration:null,fixtureId:'text-ping-v1'};
    await expect(h.dispatcher.prepare(scope,[{role:'user',content:'private document'}])).rejects.toThrow('固定合成');
    const d=await h.dispatcher.prepare(scope,PROBE_FIXTURES['text-ping-v1']);
    expect((await h.dispatcher.send(d,authorizeExplicitSend(d.request))).text).toBe('synthetic reply');
  });
  it('keeps a completed network response visible when local cache write fails',async()=>{
    const h=harness();h.writeResult.mockRejectedValue(new Error('quota'));const d=await h.prepare();
    const r=await h.dispatcher.send(d,authorizeExplicitSend(d.request));expect(r.storageWarning).toContain('保存未完成');expect(h.transport).toHaveBeenCalledOnce();
  });
});

it('official DeepSeek Pro rejects images despite a declared provider, before cache/reserve/transport',async()=>{
 const h=harness();h.runtime.context.endpoint='https://api.deepseek.com/chat/completions';h.runtime.context.model='deepseek-v4-pro';h.runtime.imageInput='declared';h.readResult.mockResolvedValue('must not reuse');
 const d=await h.dispatcher.prepare(h.scope,[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,YWJj'}}]}]);
 expect(d.imageBlockReason).toContain('不支持图像');
 await expect(h.dispatcher.send(d,authorizeExplicitSend(d.request))).rejects.toThrow('显式选择');
 expect(h.reserve).not.toHaveBeenCalled();expect(h.readResult).not.toHaveBeenCalled();expect(h.transport).not.toHaveBeenCalled();
});

it('reads saved results under deny without token, quota or transport while rejecting another session',async()=>{
 const h=harness();h.runtime.context.document!.policy='deny_all_ai';h.readResult.mockResolvedValue('local saved answer');const d=await h.prepare();
 expect(await h.dispatcher.readSaved(d)).toBe('local saved answer');
 expect(h.reserve).not.toHaveBeenCalled();expect(h.transport).not.toHaveBeenCalled();expect(h.writeResult).not.toHaveBeenCalled();
 h.setSession({docId:'d',sessionGeneration:2});
 await expect(h.dispatcher.readSaved(d)).rejects.toThrow('会话');expect(h.readResult).toHaveBeenCalledOnce();
});
it('reports missing saved material without a network fallback',async()=>{
 const h=harness(),d=await h.prepare();expect(await h.dispatcher.readSaved(d)).toBeNull();expect(h.reserve).not.toHaveBeenCalled();expect(h.transport).not.toHaveBeenCalled();
});

it('derives modality from messages, overriding an incorrect UI scope',async()=>{
 let seen='';const h=harness();const dispatcher=createRequestDispatcher({readRuntime:async scope=>{seen=scope.inputModality??'';return h.runtime;},currentSession:()=>({docId:'d',sessionGeneration:1}),reserve:h.reserve,readResult:h.readResult,writeResult:h.writeResult,transport:h.transport});
 const d=await dispatcher.prepare({...h.scope,inputModality:'text'},[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,YQ=='}}]}]);
 expect(seen).toBe('image');expect(d.inputModality).toBe('image');await dispatcher.send(d,authorizeExplicitSend(d.request));expect(h.transport).toHaveBeenCalledOnce();
});
it('uses durable ownership across separate dispatcher instances, not just a local in-flight map',async()=>{
 let owner:string|null=null;let release!:(value:{text:string;usage:{}})=>void;
 const claim:NonNullable<DispatcherDependencies['claim']>=async input=>{if(owner)throw new Error('already active');owner=input.leaseOwner;return{state:'claimed',record:{id:'execution',docId:'d',status:'running',snapshotHash:input.snapshotHash,updatedAt:1}};};
 const finish:NonNullable<DispatcherDependencies['finish']>=async input=>{expect(input.leaseOwner).toBe(owner);owner=null;};
 const transport=vi.fn(()=>new Promise<{text:string;usage:{}}>(resolve=>{release=resolve;}));
 const a=harness({claim,finish,transport}),b=harness({claim,finish,transport});const ad=await a.prepare(),bd=await b.prepare();
 const first=a.dispatcher.send(ad,authorizeExplicitSend(ad.request));await vi.waitFor(()=>expect(transport).toHaveBeenCalledOnce());
 await expect(b.dispatcher.send(bd,authorizeExplicitSend(bd.request))).rejects.toThrow('already active');expect(b.reserve).not.toHaveBeenCalled();
 release({text:'one answer',usage:{}});await first;expect(transport).toHaveBeenCalledOnce();expect(a.reserve).toHaveBeenCalledOnce();
});
it('a restarted interrupted execution needs an explicit retry; it never auto-resumes transport',async()=>{
 const claim:NonNullable<DispatcherDependencies['claim']>=vi.fn(async input=>({state:input.explicitRetry?'claimed' as const:'interrupted' as const,record:{id:'execution',docId:'d',status:'interrupted' as const,snapshotHash:input.snapshotHash,updatedAt:1}}));
 const h=harness({claim,finish:async()=>{}}),d=await h.prepare();await expect(h.dispatcher.send(d,authorizeExplicitSend(d.request))).rejects.toThrow('明确重试');expect(h.reserve).not.toHaveBeenCalled();expect(h.transport).not.toHaveBeenCalled();
 const retry=await h.prepare();await h.dispatcher.send(retry,authorizeExplicitSend(retry.request),{force:true});expect(h.reserve).toHaveBeenCalledOnce();expect(h.transport).toHaveBeenCalledOnce();
});
it('a durable completed execution restores locally after restart without another attempt',async()=>{
 const claim:NonNullable<DispatcherDependencies['claim']>=async input=>({state:'completed',record:{id:'execution',docId:'d',status:'completed',snapshotHash:input.snapshotHash,updatedAt:1,resultText:'durable answer'}});
 const h=harness({claim}),d=await h.prepare();expect(await h.dispatcher.send(d,authorizeExplicitSend(d.request))).toMatchObject({text:'durable answer',fromCache:true});expect(h.reserve).not.toHaveBeenCalled();expect(h.transport).not.toHaveBeenCalled();
});

it('manual interrupted recovery claims once, while a saved answer stays free to read',async()=>{
 const claim:NonNullable<DispatcherDependencies['claim']>=vi.fn(async input=>({state:input.retryInterrupted?'claimed' as const:'interrupted' as const,record:{id:'execution',docId:'d',status:'interrupted' as const,snapshotHash:input.snapshotHash,updatedAt:1}}));
 const h=harness({claim}),draft=await h.prepare();await h.dispatcher.send(draft,authorizeExplicitSend(draft.request),{retryInterrupted:true});
 expect(claim).toHaveBeenCalledWith(expect.objectContaining({retryInterrupted:true,explicitRetry:false}));expect(h.transport).toHaveBeenCalledOnce();
 h.readResult.mockResolvedValue('cached answer');const next=await h.prepare();await expect(h.dispatcher.send(next,authorizeExplicitSend(next.request),{retryInterrupted:true})).resolves.toMatchObject({text:'cached answer',fromCache:true});expect(h.transport).toHaveBeenCalledOnce();expect(claim).toHaveBeenCalledOnce();
});

it('does not cache or persist a length-limited reply as a completed answer',async()=>{
 const {AiOutputLimitError}=await import('../src/ai/types');const saveCompleted=vi.fn(),h=harness({saveCompleted});h.transport.mockRejectedValueOnce(new AiOutputLimitError('partial',2048));const draft=await h.prepare();
 await expect(h.dispatcher.send(draft,authorizeExplicitSend(draft.request))).rejects.toMatchObject({partialText:'partial',maxTokens:2048});expect(h.writeResult).not.toHaveBeenCalled();expect(saveCompleted).not.toHaveBeenCalled();expect(h.transport).toHaveBeenCalledOnce();
});
