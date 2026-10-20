/** Legacy UI facade. Document requests must use the visible prepared-workspace dispatcher. */
import { type FeatureKey, type ProviderConfig, type Settings } from '../shared/settings';
import { AiError, type ChatMessage } from './types';
import { productionDispatcher, PROBE_FIXTURES } from './dispatcher';
import { authorizeExplicitSend } from './preparedRequest';
export interface RunOptions { onDelta?: (delta: string) => void; signal?: AbortSignal; noCache?: boolean }
export interface RunResult { text: string; fromCache: boolean; providerId: string; providerName: string; model: string }
export class NotConfiguredError extends AiError {
  constructor() { super('还没有配置 AI 服务', { hint: '在设置页填写 Base URL、API Key 与模型名。' }); this.name = 'NotConfiguredError'; }
}
/** Fail closed: old summary/chat/card paths cannot gain send permission by switching G2 on. */
export async function runChat(_settings: Settings, _feature: FeatureKey, _messages: ChatMessage[], _options: RunOptions = {}): Promise<RunResult> {
  throw new AiError('请使用请求准备区核对实际材料并主动发送；旧 AI 入口不会直接外发');
}
export async function runJson<T>(_settings: Settings, _feature: FeatureKey, _messages: ChatMessage[], _options: RunOptions = {}): Promise<{ data: T; raw: string; fromCache: boolean }> {
  throw new AiError('结构化请求需要先准备快照；没有发送或自动补发');
}
/** Explicit settings-page test, fixed synthetic fixture only. Never includes a document. */
export async function testConnection(provider: ProviderConfig, model: string): Promise<string> {
  if (!provider.baseUrl || !provider.apiKey || !model) throw new NotConfiguredError();
  const dispatcher = productionDispatcher(() => ({ docId: '', sessionGeneration: null }));
  const prepared = await dispatcher.prepare({ type: 'global_probe', feature: 'chat', action: 'connection-test',
    docId: null, sessionGeneration: null, fixtureId: 'text-ping-v1', probeProvider: provider, probeModel: model },
    PROBE_FIXTURES['text-ping-v1'], { temperature: 0, maxTokens: 32, stream: false });
  const result = await dispatcher.send(prepared, authorizeExplicitSend(prepared.request), { force: true });
  return result.text.trim();
}
