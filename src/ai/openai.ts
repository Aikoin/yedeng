/**
 * OpenAI 兼容适配器：POST {baseUrl}/chat/completions，SSE 流式。
 * 扩展页带着 host_permissions 发请求，天然绕开 CORS，所以中转站/自建服务无需改 CORS。
 */
import { AiError, AiOutputLimitError, type ChatRequest, type ProviderConnection, type TokenUsage } from './types';
import type { PreparedRequest } from './preparedRequest';

interface StreamOptions {
  onUsage?: (usage: TokenUsage) => void;
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

function headers(conn: ProviderConnection): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${conn.apiKey}`,
  };
}

export function buildBody(req: ChatRequest, conn: ProviderConnection, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream,
    temperature: req.temperature ?? conn.temperature,
  };
  const maxTokens = req.maxTokens ?? conn.maxTokens;
  if (maxTokens > 0) body.max_tokens = maxTokens;
  if (req.json) body.response_format = { type: 'json_object' };
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

function httpError(status: number, bodyText: string): AiError {
  void bodyText; // Provider errors are untrusted and may echo authentication or private source material.
  if (status === 401 || status === 403) {
    return new AiError(`认证失败（HTTP ${status}）：API Key 或 Base URL 不正确`, {
      status,
      hint: '检查设置页的 Base URL（应以 /v1 结尾）与 API Key。',
    });
  }
  if (status === 404) {
    return new AiError('接口不存在（HTTP 404）：Base URL 或模型名可能写错了', {
      status,
      hint: '多数服务商路径是 {baseUrl}/chat/completions，baseUrl 一般以 /v1 结尾。',
    });
  }
  if (status === 429) {
    return new AiError('触发限流（HTTP 429）：稍后重试或降低频率', { status, retriable: true });
  }
  if (status >= 500) {
    return new AiError(`服务端错误（HTTP ${status}）`, { status, retriable: true });
  }
  return new AiError(`请求失败（HTTP ${status}），未自动重试`, { status });
}

async function postOnce(
  url: string,
  conn: ProviderConnection,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: headers(conn),
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new AiError('网络请求失败：检查本机网络 / 代理是否可达该 Base URL', { retriable: true });
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    const error = httpError(res.status, text);
    throw error;
}

/** 流式对话：逐段 yield 文本增量 */
export async function* streamChat(
  conn: ProviderConnection,
  req: ChatRequest,
  options: StreamOptions = {}
): AsyncGenerator<string, void, void> {
  const body = buildBody(req, conn, true);
  const res = await postOnce(endpoint(conn.baseUrl), conn, body, req.signal);
  if (!res.body) throw new AiError('服务端没有返回响应体');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawAny = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!rawLine || rawLine.startsWith(':')) continue;
      if (!rawLine.startsWith('data:')) continue;
      const payload = rawLine.slice(5).trim();
      if (payload === '[DONE]') return;
      let parsed: {
        choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (parsed.usage) {
        options.onUsage?.({
          promptTokens: parsed.usage.prompt_tokens,
          completionTokens: parsed.usage.completion_tokens,
        });
      }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        sawAny = true;
        yield delta;
      }
    }
  }

  if (!sawAny) {
    // 某些中转站会谎报 stream 但返回普通 JSON，这里兜底解析 buffer 里剩下的整段
    const text = buffer.trim();
    if (text.startsWith('data:')) return;
    const fallback = extractNonStream(text);
    if (fallback) yield fallback;
  }
}

function extractNonStream(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (parsed.error?.message) throw new AiError(parsed.error.message);
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : null;
  } catch (err) {
    if (err instanceof AiError) throw err;
    return null;
  }
}

/** 非流式一次性返回（测试连接、以及流式失败后的降级） */
export async function chatOnce(conn: ProviderConnection, req: ChatRequest): Promise<string> {
  const body = buildBody(req, conn, false);
  const res = await postOnce(endpoint(conn.baseUrl), conn, body, req.signal);
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (parsed.error?.message) throw new AiError(parsed.error.message);
    return parsed.choices?.[0]?.message?.content ?? '';
  } catch (err) {
    if (err instanceof AiError) throw err;
    throw new AiError('无法解析服务端响应，未自动重试');
  }
}

/** Exact JSON payload shown by the preparation UI. No provider defaults are added later. */
export function preparedBody(request: PreparedRequest): Record<string, unknown> {
  const p = request.parameters ?? {};
  return {
    model: request.model, messages: request.messages, stream: p.stream ?? true,
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.maxTokens !== undefined ? { max_tokens: p.maxTokens } : {}),
    ...(p.thinking ? { thinking: {type:p.thinking} } : {}),
    ...(p.json ? { response_format: { type: 'json_object' } } : {}),
    ...((p.stream ?? true) ? { stream_options: { include_usage: true } } : {}),
  };
}
export interface PreparedTransportResult { text: string; usage: TokenUsage }
/** Production caller is dispatcher.ts. Exactly one fetch, fixed endpoint, no redirect/retry. */
export async function sendPreparedTransport(request: PreparedRequest, options: {
  apiKey: string; signal: AbortSignal; onDelta?: (delta: string) => void;
  fetchImplementation?: typeof fetch;
}): Promise<PreparedTransportResult> {
  if (options.signal.aborted) throw new DOMException('已取消', 'AbortError');
  const body = JSON.stringify(preparedBody(request));
  let response: Response;
  try {
    response = await (options.fetchImplementation ?? fetch)(request.endpoint, {
      method: 'POST', redirect: 'error', signal: options.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` }, body,
    });
  } catch (error) {
    if (options.signal.aborted) throw new DOMException('已取消', 'AbortError');
    throw new AiError('请求未完成：网络、跨域或重定向被阻止；没有自动重试');
  }
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw httpError(response.status, ''); }
  const usage: TokenUsage = {};
  let text = '';
  const append = (delta: string) => {
    if (text.length + delta.length > 1_000_000) throw new AiError('响应超过本机长度上限，已停止且不写入成功缓存');
    text += delta; options.onDelta?.(delta);
  };
  function readPayload(value: unknown, streaming: boolean): boolean {
    if (!value || typeof value !== 'object') throw new AiError('模型响应格式无效');
    const payload = value as { error?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: { delta?: { content?: unknown }; message?: { content?: unknown }; finish_reason?: string | null }[] };
    if (payload.error) throw new AiError('服务返回错误响应；材料保留，没有自动重试');
    const u = payload.usage;
    if (u && Number.isFinite(u.prompt_tokens) && u.prompt_tokens! >= 0) usage.promptTokens = u.prompt_tokens;
    if (u && Number.isFinite(u.completion_tokens) && u.completion_tokens! >= 0) usage.completionTokens = u.completion_tokens;
    const choice = payload.choices?.[0];
    const content = streaming ? choice?.delta?.content : choice?.message?.content;
    if (typeof content === 'string') append(content);
    if (choice?.finish_reason === 'content_filter' || choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'function_call') throw new AiError('模型没有完成普通文本回答，未保存为成功结果');
    if (choice?.finish_reason === 'length') throw new AiOutputLimitError(text,request.parameters?.maxTokens);
    return typeof choice?.finish_reason === 'string' && choice.finish_reason !== 'length';
  }
  if (!(request.parameters?.stream ?? true) || response.headers.get('content-type')?.includes('application/json')) {
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new AiError('无法解析模型响应；没有自动重试'); }
    readPayload(payload, false);
  } else {
    if (!response.body) throw new AiError('服务未返回响应体');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', complete = false, doneMarker = false;
    const abort = () => { void reader.cancel().catch(() => undefined); };
    options.signal.addEventListener('abort', abort, { once: true });
    const consume = (raw: string) => {
      const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
      if (!data) return;
      if (data === '[DONE]') { complete = true; doneMarker = true; return; }
      let value: unknown;
      try { value = JSON.parse(data); } catch { throw new AiError('流式响应损坏；已保留部分内容，没有自动重试'); }
      complete = readPayload(value, true) || complete;
    };
    try {
      for (;;) {
        if (options.signal.aborted) throw new DOMException('已取消', 'AbortError');
        const { value, done } = await reader.read();
        if (done) { buffer += decoder.decode(); break; }
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 2_000_000) throw new AiError('流式单条响应过大，已停止');
        for (;;) {
          const separator = /\r?\n\r?\n/.exec(buffer);
          if (!separator || separator.index === undefined) break;
          consume(buffer.slice(0, separator.index)); buffer = buffer.slice(separator.index + separator[0].length);
        }
        if (doneMarker) break;
      }
      if (buffer.trim()) consume(buffer);
      if (!complete) throw new AiError('响应在完成标记前中断，部分内容未作为完整结果缓存');
    } finally {
      options.signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => undefined); reader.releaseLock();
    }
  }
  if (options.signal.aborted) throw new DOMException('已取消', 'AbortError');
  if (!text.trim()) throw new AiError('模型返回空内容，没有自动重试');
  return { text, usage };
}
