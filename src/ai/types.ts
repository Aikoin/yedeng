/** AI 抽象层：所有功能都只依赖 ChatRequest/Provider，方便以后加 Anthropic / Gemini。 */

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export type VisionContent = { type: 'text'; text: string } | {
  type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
};
export interface VisionMessage { role: Role; content: VisionContent[] }

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface ChatRequest {
  model: string;
  messages: (ChatMessage | VisionMessage)[];
  temperature?: number;
  maxTokens?: number;
  /** 要求模型返回 JSON（服务端支持 response_format 时使用） */
  json?: boolean;
  signal?: AbortSignal;
}

export type ProviderKind = 'openai';

export interface ProviderConnection {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
}

export class AiError extends Error {
  status?: number;
  retriable: boolean;
  hint?: string;

  constructor(message: string, options: { status?: number; retriable?: boolean; hint?: string } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = options.status;
    this.retriable = options.retriable ?? false;
    this.hint = options.hint;
  }
}

/** 统一的错误翻译，给用户看的中文提示 */
export function describeAiError(err: unknown): { message: string; hint?: string } {
  if (err instanceof AiError) return { message: err.message, hint: err.hint };
  if (err instanceof DOMException && err.name === 'AbortError') return { message: '已取消' };
  const message = err instanceof Error ? err.message : String(err);
  return { message };
}
