/** Production send boundary. Every network attempt consumes an explicit immutable draft. */
import { dispatchPrepared, prepareRequest, type ExplicitSendToken, type PreparedInput, type PreparedRequest, type DispatchContext, type RequestMessages } from './preparedRequest';
import { preparedBody, sendPreparedTransport, type PreparedTransportResult } from './openai';
import { imageInputBlockReason } from './modelCapabilities';
import {copyResultSources,saveCompletedResult,type ResultSourceReference} from '../shared/savedResults';
import { claimExecution,finishExecution,renewExecution,type ExecutionToken } from '../shared/executionClaims';
import { createAttemptLedger } from './attemptLedger';
import { loadSettings, resolveMaterialRoute, type InputModality, type FeatureKey, type ProviderConfig, type Settings } from '../shared/settings';
import { idbGet, idbPut, openDb, type RequestLedgerRecord } from '../shared/idb';
import { makeCacheKey, readCache, writeCache } from './cache';

export interface RequestScope {
  feature: FeatureKey;
  action: string;
  type: 'document_action' | 'global_probe';
  docId: string | null;
  sessionGeneration: number | null;
  /** Only the settings-page connection test uses an unsaved explicitly selected profile. */
  probeProvider?: ProviderConfig;
  probeModel?: string;
  fixtureId?: string;
  /** Derived inside prepare from actual ordered messages, never trusted from UI. */
  inputModality?: InputModality;
  sourceRevision?:string;
  resultSources?:readonly ResultSourceReference[];
}
export interface RuntimeState {
  context: DispatchContext;
  privateFingerprint: string;
  apiKey: string;
  settings: Settings;
  providerName: string;
  timeZone: string;
  imageInput?: 'unknown' | 'declared' | 'verified';
  imageRouteError?: string;
}
export interface PreparedDocument {
  request: PreparedRequest;
  targetName: string;
  imageBlockReason: string | null;
  inputModality: InputModality;
  imageInput?: 'unknown' | 'declared' | 'verified';
  policy: 'deny_all_ai' | 'allowed_to_configured_provider';
  cacheKey: string;
}
export interface DispatchResult extends PreparedTransportResult {
  fromCache: boolean;
  attemptId?: string;
  storageWarning?: string;
}
export const PROBE_FIXTURES: Readonly<Record<string, RequestMessages>> = Object.freeze({
  'text-ping-v1': [{ role: 'system', content: 'This is a synthetic connection test. Reply only: 连接成功' }, { role: 'user', content: 'synthetic ping' }],
});
export interface DispatcherDependencies {
  readRuntime(scope: RequestScope): Promise<RuntimeState>;
  currentSession(): { docId: string; sessionGeneration: number | null };
  reserve(input: { taskId: string; docId: string | null; timeZone: string; limit: number | null }): Promise<RequestLedgerRecord>;
  readResult(runtime: RuntimeState, key: string): Promise<string | null>;
  writeResult(runtime: RuntimeState, key: string, text: string): Promise<void>;
  saveTask?(request: PreparedRequest, status: string): Promise<void>;
  saveAttempt?(record: RequestLedgerRecord, status: string, request: PreparedRequest, usage?: PreparedTransportResult['usage']): Promise<void>;
  transport?: typeof sendPreparedTransport;
  claim?: typeof claimExecution;
  finish?: typeof finishExecution;
  renew?: typeof renewExecution;
  saveCompleted?:(scope:RequestScope,request:PreparedRequest,cacheKey:string,text:string)=>Promise<void>;
}
function sameSession(scope: RequestScope, current: { docId: string; sessionGeneration: number | null }): boolean {
  return scope.type === 'global_probe' || (scope.docId === current.docId && scope.sessionGeneration === current.sessionGeneration && scope.sessionGeneration !== null);
}
export function createRequestDispatcher(deps: DispatcherDependencies) {
  const bindings = new WeakMap<PreparedRequest, { fingerprint: string; scope: RequestScope; cacheKey: string }>();
  const used = new WeakSet<PreparedRequest>();
  const leaseOwner=crypto.randomUUID();
  const active = new Map<string, AbortController>();
  let epoch = 0;
  const invalidationListeners = new Set<(reason: string) => void>();
  function invalidate(reason = '文献或配置已变化，请重新准备') {
    epoch++;
    for (const controller of active.values()) controller.abort();
    invalidationListeners.forEach(listener => listener(reason));
  }
  function currentContext(runtime: RuntimeState, scope: RequestScope): DispatchContext {
    const context = runtime.context;
    if (!sameSession(scope, deps.currentSession())) throw new Error('已切换文献；旧请求不会发送');
    return context;
  }
  async function prepare(scope: RequestScope, messages: RequestMessages, parameters?: PreparedInput['parameters']): Promise<PreparedDocument> {
    if (scope.type === 'global_probe' && (!scope.fixtureId || !PROBE_FIXTURES[scope.fixtureId] || JSON.stringify(messages) !== JSON.stringify(PROBE_FIXTURES[scope.fixtureId]))) throw new Error('全局测试只能使用固定合成材料');
    const inputModality:InputModality=messages.some(message=>Array.isArray(message.content)&&message.content.some(block=>block.type==='image_url'))?'image':'text';
    scope={...scope,inputModality,...(scope.resultSources?{resultSources:copyResultSources(scope.resultSources)}:{})};
    const started = epoch;
    const runtime = await deps.readRuntime(scope);
    if (started !== epoch) throw new Error('准备期间配置变化，请重试');
    currentContext(runtime, scope);
    const p = parameters ?? {};
    const defaults = scope.probeProvider ?? runtime.settings.providers.find(provider => provider.id === runtime.context.providerId);
    const request = await prepareRequest({
      type: scope.type, action: scope.action, docId: scope.docId, sessionGeneration: scope.sessionGeneration,
      policyVersion: scope.type === 'document_action' ? runtime.context.document?.policyVersion ?? 0 : null,
      providerId: runtime.context.providerId, providerRevision: runtime.context.providerRevision,
      endpoint: runtime.context.endpoint, model: runtime.context.model, messages,
      parameters: { temperature: p.temperature ?? defaults?.temperature ?? 0.3, ...((p.maxTokens ?? defaults?.maxTokens ?? 0) > 0 ? { maxTokens: p.maxTokens ?? defaults?.maxTokens } : {}), json: p.json ?? false, stream: p.stream ?? true, ...(p.thinking ? {thinking:p.thinking} : {}) },
      ...(scope.sourceRevision ? {sourceRevision:scope.sourceRevision} : {}),
      ...(scope.fixtureId ? { fixtureId: scope.fixtureId } : {}),
    });
    if (started !== epoch || !sameSession(scope, deps.currentSession())) throw new Error('材料所属会话已变化');
    const cacheKey = await makeCacheKey({ feature: request.action, providerId: request.providerId, model: request.model,
      payload: JSON.stringify({ docId: request.docId, endpoint: request.endpoint, providerRevision: request.providerRevision, body: preparedBody(request) }) });
    bindings.set(request, { fingerprint: runtime.privateFingerprint, scope: { ...scope }, cacheKey });
    return { request, inputModality, targetName: runtime.providerName, imageBlockReason:runtime.imageRouteError??imageInputBlockReason(request.endpoint,request.model,runtime.imageInput), imageInput: runtime.imageInput ?? 'unknown', policy: runtime.context.document?.policy ?? 'deny_all_ai', cacheKey };
  }
  async function send(document: PreparedDocument, token: ExplicitSendToken, options: {
    signal?: AbortSignal; force?: boolean; retryInterrupted?: boolean; onDelta?: (delta: string) => void; onStatus?: (status: string) => void; timeoutMs?: number;
  } = {}): Promise<DispatchResult> {
    const request = document.request, binding = bindings.get(request);
    if (!binding) throw new Error('只能发送由本准备区创建的快照');
    if (used.has(request) || active.has(binding.cacheKey)) throw new Error('相同任务已使用或正在进行；请查看原任务');
    used.add(request);
    const started = epoch, controller = new AbortController();
    active.set(binding.cacheKey, controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, options.timeoutMs ?? 120_000);
    let runtime: RuntimeState, reservation: RequestLedgerRecord | undefined;
    const executionToken:ExecutionToken={cacheKey:binding.cacheKey,taskId:request.id,leaseOwner};
    let claimed=false,finished=false,heartbeat:ReturnType<typeof setInterval>|undefined;
    const checkLive = async () => {
      if (controller.signal.aborted) throw new DOMException('已取消或等待超时', 'AbortError');
      runtime = await deps.readRuntime(binding.scope);
      if (started !== epoch || runtime.privateFingerprint !== binding.fingerprint) throw new Error('模型配置或密钥已变化，请重新准备材料');
      currentContext(runtime, binding.scope);
      const hasImages = request.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image_url'));
      if((hasImages?'image':'text')!==binding.scope.inputModality)throw new Error('请求材料模态与已绑定路由不一致');
      const imageBlockReason=runtime.imageRouteError??imageInputBlockReason(runtime.context.endpoint,runtime.context.model,runtime.imageInput);
      if(hasImages && imageBlockReason)throw new Error(imageBlockReason);
      if (request.type === 'document_action') {
        const document = runtime.context.document;
        if (!document || document.policy !== 'allowed_to_configured_provider' || document.policyVersion !== request.policyVersion) {
          throw new Error('文献禁止 AI 或策略版本已变化；请重新准备，未发送新请求');
        }
      }
    };
    const saveTask = async (status: string) => { await deps.saveTask?.(request, status); };
    try {
      await checkLive();
      // Saved results are local reads. No quota slot or fresh HTTP request is created.
      if (!options.force) {
        const cached = await deps.readResult(runtime!, binding.cacheKey);
        if (cached !== null) {
          await checkLive(); options.onStatus?.('cached'); options.onDelta?.(cached);
          return { text: cached, usage: {}, fromCache: true };
        }
      }
      if(deps.claim){
        const claim=await deps.claim({...executionToken,docId:request.docId,snapshotHash:request.snapshotHash,explicitRetry:options.force??false,retryInterrupted:options.retryInterrupted??false});
        if(claim.state==='claimed')claimed=true;
        await checkLive();
        if(claim.state==='completed'){
          if(typeof claim.record.resultText!=='string')throw new Error('此任务已经完成，但本地没有保留结果；需要新请求时请明确重新生成');
          options.onStatus?.('cached');options.onDelta?.(claim.record.resultText);
          return {text:claim.record.resultText,usage:{},fromCache:true};
        }
        if(claim.state==='interrupted')throw new Error('旧任务已失败、取消或中断；为避免重复计费，请明确重试后再发送，不会自动重发');
        claimed=true;
        if(deps.renew)heartbeat=setInterval(()=>{void deps.renew!(executionToken).then(ok=>{if(!ok)controller.abort();}).catch(()=>controller.abort());},60_000);
      }
      await saveTask('prepared');
      await checkLive();
      const result = await dispatchPrepared(request, token, {
        getCurrentContext: () => currentContext(runtime!, binding.scope),
        probeFixtures: PROBE_FIXTURES,
        reserveAttempt: async () => {
          reservation = await deps.reserve({ taskId: request.id, docId: request.docId, timeZone: runtime!.timeZone,
            limit: runtime!.settings.limits.requestsPerDay > 0 ? runtime!.settings.limits.requestsPerDay : null });
          await deps.saveAttempt?.(reservation, 'reserved', request);
          // This read is deliberately after every reservation/storage await, just before actual dispatch.
          await checkLive();
          return reservation.id;
        },
        actualSend: (snapshot, sendOptions) => {
          options.onStatus?.('sending');
          // Transport invokes fetch synchronously before its first await. Redirect policy is fixed.
          return (deps.transport ?? sendPreparedTransport)(snapshot, { apiKey: runtime!.apiKey,
            signal: sendOptions.signal!, onDelta: delta => {
              if (!controller.signal.aborted && started === epoch && sameSession(binding.scope, deps.currentSession())) options.onDelta?.(delta);
            } });
        },
      }, controller.signal);
      await checkLive();
      let storageWarning: string | undefined;
      try {
        if(claimed&&deps.finish){await deps.finish({...executionToken,status:'completed',...(runtime!.settings.cache.enabled?{resultText:result.text}:{})});finished=true;}
        if(runtime!.settings.cache.enabled)await deps.saveCompleted?.(binding.scope,request,binding.cacheKey,result.text);
        await deps.writeResult(runtime!, binding.cacheKey, result.text);
        await saveTask('completed');
        if (reservation) await deps.saveAttempt?.(reservation, 'completed', request, result.usage);
      } catch { storageWarning = '结果已收到，但本地保存未完成；请先复制结果，为避免重复计费不要重新发送'; }
      options.onStatus?.('completed');
      return { ...result, fromCache: false, attemptId: reservation?.id, ...(storageWarning ? { storageWarning } : {}) };
    } catch (error) {
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      await Promise.allSettled([...(claimed&&!finished&&deps.finish?[deps.finish({...executionToken,status})]:[]),saveTask(status), ...(reservation && deps.saveAttempt ? [deps.saveAttempt(reservation, status, request)] : [])]);
      throw error;
    } finally {
      clearTimeout(timer);if(heartbeat)clearInterval(heartbeat); options.signal?.removeEventListener('abort', abort); active.delete(binding.cacheKey);
    }
  }
  /** Local-only lookup: deliberately independent of outbound document policy and send authorization. */
  async function readSaved(document: PreparedDocument): Promise<string | null> {
    const binding=bindings.get(document.request);
    if(!binding || document.request.type!=='document_action' || !sameSession(binding.scope,deps.currentSession()))throw new Error('已切换文献；不能读取旧会话结果');
    const runtime=await deps.readRuntime(binding.scope);
    if(!sameSession(binding.scope,deps.currentSession()))throw new Error('已切换文献；不能读取旧会话结果');
    const saved=await deps.readResult(runtime,binding.cacheKey);
    if(!sameSession(binding.scope,deps.currentSession()))throw new Error('读取期间文献会话已改变');
    return saved;
  }
  return { prepare, send, readSaved, invalidate, subscribe: (listener: (reason: string) => void) => { invalidationListeners.add(listener); return () => invalidationListeners.delete(listener); } };
}

export async function privateProviderFingerprint(settings: Settings, provider: ProviderConfig, model: string): Promise<string> {
  // Private hash is kept in WeakMap only. Never put it into DOM, logs, cache keys or exported files.
  const value = JSON.stringify({ revision: settings.revision, provider, model });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function configuredEndpoint(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}
let installationZone: Promise<string> | null = null;
async function getInstallationTimeZone(): Promise<string> {
  installationZone ??= (async () => {
    const key = 'ai.installationTimeZone.v1', stored = await chrome.storage.local.get(key);
    const zone = typeof stored[key] === 'string' ? stored[key] : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
    if (!stored[key]) await chrome.storage.local.set({ [key]: zone });
    return zone;
  })().catch(error => { installationZone = null; throw error; });
  return installationZone;
}
export function productionDispatcher(currentSession: DispatcherDependencies['currentSession']) {
  const ledger = createAttemptLedger();
  return createRequestDispatcher({
    currentSession,
    readRuntime: async scope => {
      const settings = await loadSettings();
      const route = scope.type === 'global_probe' && scope.probeProvider ? { provider: scope.probeProvider, model: scope.probeModel ?? '' } : resolveMaterialRoute(settings, scope.feature, scope.inputModality??'text');
      if (!route?.provider.baseUrl || !route.provider.apiKey || !route.model) throw new Error('请先配置服务地址、Key 与模型；不会自动打开设置或发送');
      const context: DispatchContext = { providerId: route.provider.id, providerRevision: settings.revision,
        endpoint: configuredEndpoint(route.provider.baseUrl), model: route.model };
      if (scope.type === 'document_action') {
        const doc = scope.docId ? await idbGet('docs', scope.docId) : undefined;
        const policyDoc = doc as typeof doc & { policy?: 'deny_all_ai' | 'allowed_to_configured_provider'; policyVersion?: number };
        context.document = { docId: scope.docId ?? '', sessionGeneration: scope.sessionGeneration ?? -1,
          policyVersion: policyDoc?.policyVersion ?? 0, policy: policyDoc?.policy ?? 'deny_all_ai' };
      }
      return { context, privateFingerprint: await privateProviderFingerprint(settings, route.provider, route.model), apiKey: route.provider.apiKey,
        settings, providerName: route.provider.name, timeZone: await getInstallationTimeZone(), imageInput: route.provider.imageInput ?? 'unknown', ...('imageRouteError' in route ? {imageRouteError:route.imageRouteError} : {}) };
    },
    reserve: input => ledger.reserve(input),
    claim:claimExecution,finish:finishExecution,renew:renewExecution,
    saveCompleted:async(scope,request,cacheKey,text)=>{if(scope.docId)await saveCompletedResult({cacheKey,docId:scope.docId,action:scope.action,snapshotHash:request.snapshotHash,resultText:text,sources:scope.resultSources,sourceRevision:request.sourceRevision});},
    readResult: async(runtime, key) => {
      const cached=await readCache(runtime.settings,key);if(cached!==null)return cached;
      if(!runtime.settings.cache.enabled)return null;
      const saved=await idbGet('tasks',`execution:${key}`);
      if(saved?.status!=='completed'||typeof saved.resultText!=='string')return null;
      if(runtime.settings.cache.ttlDays>0&&Date.now()-saved.updatedAt>runtime.settings.cache.ttlDays*86400000)return null;
      return saved.resultText;
    },
    writeResult: (runtime, key, text) => writeCache(runtime.settings, key, text),
    saveTask: async (request, status) => {
      if (request.docId) await idbPut('tasks', { id: request.id, docId: request.docId,
        status: status as 'prepared' | 'completed' | 'failed' | 'cancelled', snapshotHash: request.snapshotHash, updatedAt: Date.now() });
    },
    saveAttempt: async (record, status, request, usage) => {
      const metadata = { ...record, status, action: request.action, providerId: request.providerId, model: request.model,
        messageCount: request.messages.length, imageCount: request.messages.reduce((count,m) => count + (Array.isArray(m.content) ? m.content.filter(block => block.type === 'image_url').length : 0),0),
        updatedAt: Date.now(), ...(usage ? { usage } : {}) };
      await idbPut('requestLedger', metadata);
    },
  });
}

export async function setDocumentAiPolicy(docId: string, policy: 'deny_all_ai' | 'allowed_to_configured_provider'): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('docs', 'readwrite'), store = tx.objectStore('docs');
    let failure: unknown;
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure ?? tx.error ?? new Error('策略保存失败'));
    tx.onerror = () => { failure ??= tx.error; };
    const get = store.get(docId);
    get.onsuccess = () => {
      if (!get.result) { failure = new Error('文献尚未保存，未改变策略'); tx.abort(); return; }
      const old = get.result;
      store.put({ ...old, policy, policyVersion: Math.max(Date.now(), (old.policyVersion ?? 0) + 1) });
    };
  });
}

/** Opening in the AI reader is the default opt-in; an existing explicit deny always wins. */
export async function ensureReaderAiAccess(docId: string): Promise<boolean> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('docs', 'readwrite'), store = tx.objectStore('docs');
    let allowed = false;
    tx.oncomplete = () => resolve(allowed);
    tx.onabort = () => reject(tx.error ?? new Error('无法读取文献设置'));
    tx.onerror = () => reject(tx.error);
    const get = store.get(docId);
    get.onsuccess = () => {
      const old = get.result;
      if (!old || old.policy === 'deny_all_ai') return;
      allowed = true;
      if (old.policy !== 'allowed_to_configured_provider') store.put({ ...old,
        policy: 'allowed_to_configured_provider', policyVersion: Math.max(Date.now(), (old.policyVersion ?? 0) + 1) });
    };
  });
}
