import { describe, expect, it, vi } from 'vitest';
import { authorizeExplicitSend, dispatchPrepared, normalizeRequestEndpoint, prepareRequest,
  type DispatchContext, type PreparedInput, type RequestMessages } from '../src/ai/preparedRequest';
function input(): PreparedInput {
  return { type: 'document_action', action: 'explain', docId: 'paper-1', sessionGeneration: 2, policyVersion: 3,
    providerId: 'personal', providerRevision: 4, endpoint: 'https://EXAMPLE.com:443/v1/chat/completions', model: 'vision',
    messages: [{ role: 'system', content: 'Explain only supplied evidence.' }, { role: 'user', content: [
      { type: 'text', text: 'Eq 1' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj', detail: 'high' } },
      { type: 'text', text: 'Assumption 2' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,ZGVm' } },
    ] }], parameters: { temperature: 0 } };
}
function context(): DispatchContext {
  return { providerId: 'personal', providerRevision: 4, endpoint: 'https://example.com/v1/chat/completions', model: 'vision',
    document: { docId: 'paper-1', sessionGeneration: 2, policyVersion: 3, policy: 'allowed_to_configured_provider' } };
}
describe('prepared dispatch primitive (no real network)', () => {
  it('copies/freezes exact ordered text and images and hashes their material', async () => {
    const source = input(), prepared = await prepareRequest(source);
    source.messages[0].content = 'changed';
    expect(prepared.messages[0].content).toBe('Explain only supplied evidence.');
    expect(Object.isFrozen(prepared.messages[1].content)).toBe(true);
    expect(() => { (prepared.messages[1].content as unknown[]).push('extra'); }).toThrow();
    expect(prepared.endpoint).toBe('https://example.com/v1/chat/completions');
    const changed = input(); changed.messages.reverse();
    expect((await prepareRequest(changed)).snapshotHash).not.toBe(prepared.snapshotHash);
  });
  it('sends exactly once under concurrent duplicate clicks, with redirect:error', async () => {
    const prepared = await prepareRequest(input()), token = authorizeExplicitSend(prepared);
    const send = vi.fn(async () => 'ok'), reserve = vi.fn(async () => 'attempt-1');
    const deps = { getCurrentContext: context, reserveAttempt: reserve, actualSend: send };
    const results = await Promise.allSettled([dispatchPrepared(prepared, token, deps), dispatchPrepared(prepared, token, deps)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(send).toHaveBeenCalledOnce(); expect(reserve).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(prepared, { attemptId: 'attempt-1', redirect: 'error', signal: undefined });
  });
  for (const changed of ['deny', 'missingPolicy', 'docId', 'session', 'policyVersion', 'providerRevision', 'endpoint', 'model'] as const) {
    it(`rejects stale/disallowed context: ${changed}`, async () => {
      const prepared = await prepareRequest(input()), now = context();
      if (changed === 'deny') now.document!.policy = 'deny_all_ai';
      if (changed === 'missingPolicy') delete now.document!.policy;
      if (changed === 'docId') now.document!.docId = 'another-paper';
      if (changed === 'session') now.document!.sessionGeneration++;
      if (changed === 'policyVersion') now.document!.policyVersion++;
      if (changed === 'providerRevision') now.providerRevision++;
      if (changed === 'endpoint') now.endpoint = 'https://other.example/v1';
      if (changed === 'model') now.model = 'another-model';
      const send = vi.fn(), reserve = vi.fn();
      await expect(dispatchPrepared(prepared, authorizeExplicitSend(prepared), { getCurrentContext: () => now, actualSend: send, reserveAttempt: reserve })).rejects.toThrow();
      expect(send).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    });
  }
  it('rechecks policy after asynchronous reservation, before any send', async () => {
    const prepared = await prepareRequest(input()), now = context(), send = vi.fn();
    await expect(dispatchPrepared(prepared, authorizeExplicitSend(prepared), {
      getCurrentContext: () => now, actualSend: send,
      reserveAttempt: async () => { now.document!.policy = 'deny_all_ai'; return 'reserved'; },
    })).rejects.toThrow(); expect(send).not.toHaveBeenCalled();
  });
  it('never retries failed sends or cancelled reservations', async () => {
    const prepared = await prepareRequest(input()), controller = new AbortController();
    const send = vi.fn(async () => { throw new Error('network failed'); });
    await expect(dispatchPrepared(prepared, authorizeExplicitSend(prepared), { getCurrentContext: context, actualSend: send, reserveAttempt: async () => 'a' })).rejects.toThrow('network failed');
    expect(send).toHaveBeenCalledOnce();
    const cancelledSend = vi.fn();
    await expect(dispatchPrepared(prepared, authorizeExplicitSend(prepared), { getCurrentContext: context, actualSend: cancelledSend,
      reserveAttempt: async () => { controller.abort(); return 'b'; } }, controller.signal)).rejects.toThrow('已取消');
    expect(cancelledSend).not.toHaveBeenCalled();
  });
  it('allows only the fixed synthetic fixture for independent global probes', async () => {
    const fixture: RequestMessages = [{ role: 'user', content: 'synthetic ping' }];
    const raw = { ...input(), type: 'global_probe' as const, docId: null, sessionGeneration: null, policyVersion: null, fixtureId: 'ping', messages: fixture };
    const prepared = await prepareRequest(raw), send = vi.fn(async () => 'pong');
    await expect(dispatchPrepared(prepared, authorizeExplicitSend(prepared), { getCurrentContext: context, actualSend: send, reserveAttempt: async () => 'test', probeFixtures: { ping: fixture } })).resolves.toBe('pong');
    const paperProbe = await prepareRequest({ ...raw, messages: input().messages });
    await expect(dispatchPrepared(paperProbe, authorizeExplicitSend(paperProbe), { getCurrentContext: context, actualSend: send, reserveAttempt: async () => 'test', probeFixtures: { ping: fixture } })).rejects.toThrow('固定合成');
    await expect(prepareRequest({ ...raw, docId: 'paper-1' })).rejects.toThrow('不能绑定文献');
  });
  it('rejects credential/query/hash/unsafe endpoint and remote image fetches', async () => {
    for (const address of ['https://user:pass@example.com/v1', 'https://example.com/v1?key=x', 'https://example.com/v1#x', 'http://192.168.1.1/v1', '/relative']) {
      expect(() => normalizeRequestEndpoint(address)).toThrow();
    }
    expect(normalizeRequestEndpoint('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080/v1');
    const remote = input(); remote.messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://remote.example/figure.png' } }] }];
    await expect(prepareRequest(remote)).rejects.toThrow('内联数据');
  });
  it('rejects forged/mismatched authority and an already cancelled send before reserving', async () => {
    const prepared = await prepareRequest(input()), other = await prepareRequest(input());
    const send = vi.fn(), reserve = vi.fn(async () => 'a');
    const deps = { getCurrentContext: context, actualSend: send, reserveAttempt: reserve };
    await expect(dispatchPrepared(other, authorizeExplicitSend(prepared), deps)).rejects.toThrow('授权');
    await expect(dispatchPrepared(prepared, {} as ReturnType<typeof authorizeExplicitSend>, deps)).rejects.toThrow('授权');
    const controller = new AbortController(); controller.abort();
    await expect(dispatchPrepared(prepared, authorizeExplicitSend(prepared), deps, controller.signal)).rejects.toThrow('已取消');
    expect(reserve).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

});

it('thinking is immutable, changes the snapshot hash, and is restricted to the official supported models',async()=>{
  const base={...input(),endpoint:'https://api.deepseek.com/chat/completions',model:'deepseek-v4-pro'};
  const off=await prepareRequest({...base,parameters:{thinking:'disabled'}});
  expect(off.parameters?.thinking).toBe('disabled');expect(Object.isFrozen(off.parameters)).toBe(true);
  expect((await prepareRequest({...base,parameters:{thinking:'enabled'}})).snapshotHash).not.toBe(off.snapshotHash);
  expect((await prepareRequest(base)).parameters).not.toHaveProperty('thinking');
  for(const change of [{endpoint:'https://api.deepseek.com.evil.test/chat/completions'},{endpoint:'https://gateway.test/chat/completions'},{model:'other'}])
    await expect(prepareRequest({...base,...change,parameters:{thinking:'disabled'}})).rejects.toThrow('不支持');
  await expect(prepareRequest({...base,parameters:{thinking:'invalid' as 'disabled'}})).rejects.toThrow();
});
