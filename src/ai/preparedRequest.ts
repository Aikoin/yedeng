/** G0 primitive only. Production callers must supply an actual UI send gesture and trusted context.
 * No credentials, storage access, automatic retry, remote image fetch or provider selection lives here. */
import type { ChatMessage, VisionMessage } from './types';

export type RequestMessages = (ChatMessage | VisionMessage)[];
export interface PreparedInput {
  type: 'document_action' | 'global_probe';
  action: string;
  docId: string | null;
  sessionGeneration: number | null;
  policyVersion: number | null;
  providerId: string;
  providerRevision: number;
  endpoint: string;
  model: string;
  messages: RequestMessages;
  parameters?: { temperature?: number; maxTokens?: number; json?: boolean; stream?: boolean; thinking?: 'enabled' | 'disabled' };
  /** The trusted caller selects a constant fixture. Documents cannot create fixtures. */
  fixtureId?: string;
  /** Local source revision binding; excluded from model payload and semantic result cache. */
  sourceRevision?: string;
}
export type PreparedRequest = Readonly<PreparedInput & { id: string; snapshotHash: string }>;
export interface DispatchContext {
  providerId: string;
  providerRevision: number;
  endpoint: string;
  model: string;
  document?: {
    docId: string;
    sessionGeneration: number;
    policyVersion: number;
    policy?: 'allowed_to_configured_provider' | 'deny_all_ai';
  };
}
export interface DispatchDependencies<T> {
  getCurrentContext(): DispatchContext;
  /** Only trusted, non-document fixtures are supplied by the application. */
  probeFixtures?: Readonly<Record<string, RequestMessages>>;
  reserveAttempt(request: PreparedRequest): Promise<string>;
  /** Must invoke the transport immediately; credentials are injected outside the snapshot. */
  actualSend(request: PreparedRequest, options: { attemptId: string; redirect: 'error'; signal?: AbortSignal }): Promise<T>;
}
export class PreparedRequestError extends Error {}
const preparedRegistry = new WeakSet<object>();
const sendTokens = new WeakMap<object, { request: PreparedRequest; used: boolean }>();
export interface ExplicitSendToken { readonly __explicitSendToken: unique symbol }

export function normalizeRequestEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new PreparedRequestError('模型地址必须是绝对 URL'); }
  if (url.username || url.password || value.includes('?') || value.includes('#')) {
    throw new PreparedRequestError('模型地址不能携带用户凭据、查询参数或片段');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new PreparedRequestError('仅支持 HTTPS 或显式本机回环 HTTP 地址');
  }
  return url.href;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
function copyMessages(messages: RequestMessages): RequestMessages {
  if (!Array.isArray(messages) || !messages.length) throw new PreparedRequestError('请求材料不能为空');
  return messages.map((message) => {
    if (!['system', 'user', 'assistant'].includes(message.role)) throw new PreparedRequestError('无效消息角色');
    if (typeof message.content === 'string') return { role: message.role, content: message.content };
    if (!Array.isArray(message.content)) throw new PreparedRequestError('无效消息材料');
    return { role: message.role, content: message.content.map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return { type: 'text' as const, text: block.text };
      if (block.type === 'image_url' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(block.image_url.url)) {
        const detail = block.image_url.detail;
        if (detail !== undefined && !['auto', 'low', 'high'].includes(detail)) throw new PreparedRequestError('无效图像精度');
        return { type: 'image_url' as const, image_url: { url: block.image_url.url, ...(detail ? { detail } : {}) } };
      }
      throw new PreparedRequestError('图片必须是已准备的内联数据，不允许远端图片 URL');
    }) };
  });
}
export async function prepareRequest(input: PreparedInput): Promise<PreparedRequest> {
  if (!input.providerId || !input.model || !Number.isInteger(input.providerRevision) || input.providerRevision < 0) throw new PreparedRequestError('无效服务配置');
  if (input.type === 'document_action') {
    if (!input.docId || !Number.isInteger(input.sessionGeneration) || !Number.isInteger(input.policyVersion)) throw new PreparedRequestError('缺少文献会话或策略版本');
  } else if (input.type === 'global_probe') {
    if (input.docId !== null || input.sessionGeneration !== null || input.policyVersion !== null || !input.fixtureId) throw new PreparedRequestError('全局测试不能绑定文献');
  } else throw new PreparedRequestError('无效请求类型');
  const parameters = {
    ...(input.parameters?.temperature !== undefined ? { temperature: input.parameters.temperature } : {}),
    ...(input.parameters?.maxTokens !== undefined ? { maxTokens: input.parameters.maxTokens } : {}),
    ...(input.parameters?.json !== undefined ? { json: input.parameters.json } : {}),
    ...(input.parameters?.stream !== undefined ? { stream: input.parameters.stream } : {}),
    ...(input.parameters?.thinking !== undefined ? { thinking: input.parameters.thinking } : {}),
  };
  if (parameters.thinking !== undefined && (!['enabled','disabled'].includes(parameters.thinking) || !supportsThinkingToggle(input.endpoint,input.model))) throw new PreparedRequestError('此端点或模型不支持显式思考参数');
  if (parameters.temperature !== undefined && !Number.isFinite(parameters.temperature)) throw new PreparedRequestError('无效生成参数');
  if (parameters.maxTokens !== undefined && (!Number.isInteger(parameters.maxTokens) || parameters.maxTokens <= 0)) throw new PreparedRequestError('无效长度参数');
  if (parameters.json !== undefined && typeof parameters.json !== 'boolean') throw new PreparedRequestError('无效输出参数');
  if (parameters.stream !== undefined && typeof parameters.stream !== 'boolean') throw new PreparedRequestError('无效流式参数');
  if(input.sourceRevision!==undefined && (typeof input.sourceRevision!=='string' || !input.sourceRevision || input.sourceRevision.length>512))throw new PreparedRequestError('无效来源修订');
  const data: PreparedInput = {
    type: input.type, action: input.action, docId: input.docId, sessionGeneration: input.sessionGeneration,
    policyVersion: input.policyVersion, providerId: input.providerId, providerRevision: input.providerRevision,
    endpoint: normalizeRequestEndpoint(input.endpoint), model: input.model, messages: copyMessages(input.messages), parameters,
    ...(input.sourceRevision!==undefined ? {sourceRevision:input.sourceRevision} : {}),
    ...(input.type === 'global_probe' ? { fixtureId: input.fixtureId } : {}),
  };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(data)));
  const snapshotHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const request = deepFreeze({ ...data, id: crypto.randomUUID(), snapshotHash });
  preparedRegistry.add(request);
  return request;
}
/** Call only from the application's explicit send action, never when preparing materials. */
export function authorizeExplicitSend(request: PreparedRequest): ExplicitSendToken {
  if (!preparedRegistry.has(request)) throw new PreparedRequestError('未注册的请求快照');
  const token = Object.freeze({});
  sendTokens.set(token, { request, used: false });
  return token as ExplicitSendToken;
}
function validateCurrent<T>(request: PreparedRequest, deps: DispatchDependencies<T>): void {
  const current = deps.getCurrentContext();
  if (current.providerId !== request.providerId || current.providerRevision !== request.providerRevision
    || normalizeRequestEndpoint(current.endpoint) !== request.endpoint || current.model !== request.model) {
    throw new PreparedRequestError('服务配置已变化，请重新准备材料');
  }
  if (request.type === 'document_action') {
    const doc = current.document;
    if (!doc || doc.policy !== 'allowed_to_configured_provider' || doc.docId !== request.docId
      || doc.sessionGeneration !== request.sessionGeneration || doc.policyVersion !== request.policyVersion) {
      throw new PreparedRequestError('文献禁止 AI 或会话与策略已变化');
    }
  } else {
    const fixture = request.fixtureId && deps.probeFixtures?.[request.fixtureId];
    if (request.docId !== null || !fixture || canonical(copyMessages(fixture)) !== canonical(request.messages)) {
      throw new PreparedRequestError('全局测试必须使用固定合成材料');
    }
  }
}
export async function dispatchPrepared<T>(request: PreparedRequest, token: ExplicitSendToken,
  deps: DispatchDependencies<T>, signal?: AbortSignal): Promise<T> {
  const permission = sendTokens.get(token);
  if (!preparedRegistry.has(request) || !permission || permission.request !== request || permission.used) {
    throw new PreparedRequestError('发送授权缺失或已使用');
  }
  // Consume synchronously before awaiting: repeated clicks cannot dispatch the same gesture twice.
  permission.used = true;
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
  validateCurrent(request, deps);
  const attemptId = await deps.reserveAttempt(request);
  if (!attemptId) throw new PreparedRequestError('未取得请求尝试预留');
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
  validateCurrent(request, deps); // Policy/configuration may change during storage reservation.
  // No retry, fallback, redirect-following or post-preview material mutation here.
  return deps.actualSend(request, { attemptId, redirect: 'error', signal });
}

/** Explicit vendor option: never attach to gateways or unrelated models. */
export function supportsThinkingToggle(endpoint: string, model: string): boolean {
  try { const target=new URL(endpoint);return target.protocol==='https:' && target.hostname==='api.deepseek.com' && (!target.port || target.port==='443') && ['deepseek-v4-pro','deepseek-flash'].includes(model); } catch { return false; }
}
