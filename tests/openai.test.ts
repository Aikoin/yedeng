import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatOnce, streamChat } from '../src/ai/openai';
import { AiError, type ProviderConnection } from '../src/ai/types';

const connection: ProviderConnection = {
  kind: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  temperature: 0.3,
  maxTokens: 128,
};

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('streamChat', () => {
  it('拼接 SSE 增量，能处理跨 chunk 的半行', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"cont',
        'ent":"好"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"世界"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
    );
    vi.stubGlobal('fetch', fetchMock);

    const parts: string[] = [];
    for await (const delta of streamChat(connection, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      parts.push(delta);
    }
    expect(parts.join('')).toBe('你好世界');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(true);
    expect(body.model).toBe('deepseek-chat');
  });

  it('读取 usage 回调', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n',
          'data: [DONE]\n\n',
        ])
      )
    );
    let usage: { promptTokens?: number; completionTokens?: number } = {};
    for await (const _ of streamChat(
      connection,
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { onUsage: (u) => (usage = u) }
    )) {
      /* 消费流 */
    }
    expect(usage.promptTokens).toBe(11);
    expect(usage.completionTokens).toBe(2);
  });

  it('401 给出可操作的中文提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    await expect(async () => {
      for await (const _ of streamChat(connection, {
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      })) {
        /* 不应有内容 */
      }
    }).rejects.toThrow(/认证失败/);
  });

  it('response_format不支持时不自动补发付费请求', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse({error:{message:'unsupported'}},400));
    vi.stubGlobal('fetch',fetchMock);
    await expect(async () => {
      for await (const _ of streamChat(connection,{model:'m',messages:[{role:'user',content:'x'}],json:true})) {}
    }).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error');
  });
  it('429和网络失败都只尝试一次', async () => {
    const fetchMock=vi.fn(async () => new Response('rate limit',{status:429}));
    vi.stubGlobal('fetch',fetchMock);
    await expect(chatOnce(connection,{model:'m',messages:[{role:'user',content:'x'}]})).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});

describe('chatOnce', () => {
  it('解析非流式响应', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: '连接成功' } }] }))
    );
    const reply = await chatOnce(connection, { model: 'm', messages: [{ role: 'user', content: 'ping' }] });
    expect(reply).toBe('连接成功');
  });

  it('服务端返回 error 字段时抛出 AiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: '余额不足' } })));
    await expect(
      chatOnce(connection, { model: 'm', messages: [{ role: 'user', content: 'ping' }] })
    ).rejects.toBeInstanceOf(AiError);
  });
});
