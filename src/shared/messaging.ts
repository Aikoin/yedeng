/** 扩展内部消息协议：SW ↔ 扩展页 */

export interface PendingPdf {
  url: string;
  tabId: number;
  referer?: string;
  detectedAt: number;
}

/** 接管决策日志：出问题时用户能在 popup 里看到"为什么没接管" */
export interface InterceptLogEntry {
  at: number;
  url: string;
  host: string;
  kind: 'main_frame' | 'sub_frame' | 'manual';
  contentType?: string;
  decision: 'hijacked' | 'skipped' | 'offered' | 'failed';
  reason: string;
}

export type Message =
  | { type: 'installation-health' }
  | { type: 'settings-changed' }
  | { type: 'open-viewer'; url?: string }
  | { type: 'open-options' }
  | { type: 'open-library' }
  | { type: 'open-url'; url: string }
  | { type: 'get-pending-pdf'; tabId: number }
  | { type: 'pending-pdf-result'; pending: PendingPdf | null }
  | { type: 'open-text'; text: string; title?: string }
  | { type: 'hijack-skipped' }
  /** 用户主动要求用浏览器原生阅读器打开该 URL，本次放行不接管 */
  | { type: 'allow-native'; url: string; tabId?: number }
  | { type: 'get-tab-id' }
  | { type: 'set-hijack'; enabled: boolean }
  | { type: 'get-intercept-log' }
  | { type: 'clear-intercept-log' };

export async function sendMessage<T = unknown>(message: Message): Promise<T | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T | undefined;
  } catch {
    // 接收端不存在（例如 SW 正在重启）时静默失败
    return undefined;
  }
}

export function viewerUrl(src?: string): string {
  const base = chrome.runtime.getURL('viewer/index.html');
  if (!src) return base;
  return `${base}?src=${encodeURIComponent(src)}`;
}
