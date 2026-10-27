import {menuInstaller} from './contextMenus';
/**
 * Service Worker：PDF 接管入口 + 接管决策自检日志。
 *
 * 拦截阶梯（任一级可用即可，不依赖单一机制）：
 *   1) webRequest.onHeadersReceived 观察 content-type（最准，能覆盖没有 .pdf 后缀的下载链接）
 *   2) webNavigation.onCommitted / tabs.onUpdated + URL 正则兜底
 *   3) 页面内嵌 PDF（iframe/embed）：往顶层页面注入一个"用 页灯 YEDENG 打开"按钮
 *   4) 工具栏 popup / 右键菜单 手动入口；本地 file:// PDF 需在扩展详情页开启"允许访问文件网址"
 *
 * 每一次判断都会写进 storage.session 的环形日志，popup 里可以直接看到"为什么没接管"。
 */
import {redactInterceptEntry}from'../shared/messageGuard';
import {validateRuntimeMessage}from'../shared/messageGuard';
import { log } from '../shared/logger';
import { viewerUrl, type InterceptLogEntry, type Message, type PendingPdf } from '../shared/messaging';
import { loadSettings, saveSettings } from '../shared/settings';
import { shouldOfferOnboarding } from '../shared/onboarding';

const LIBRARY_URL = chrome.runtime.getURL('library/index.html');
const LOG_KEY = 'interceptLog.v1';
const LOG_LIMIT = 30;

/** 每个标签页的冷却，防止重定向循环 */
const cooldown = new Map<number, number>();
/** 内存中的待处理 PDF（SW 重启后从 storage.session 恢复） */
const pending = new Map<number, PendingPdf>();
/** 用户明确要求"用浏览器打开"的 URL，放行一次 */
const allowOnce = new Map<number, string>();
/** 已经注入过按钮的 内嵌 PDF（tabId -> pdf url） */
const offeredEmbed = new Map<number, string>();

const SKIP_HOSTS = ['chromewebstore.google.com', 'chrome.google.com', 'microsoftedge.microsoft.com'];

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function isOurUrl(url: string): boolean {
  return url.startsWith(chrome.runtime.getURL(''));
}

function isPdfContentType(value: string | undefined): boolean {
  if (!value) return false;
  const ct = value.toLowerCase();
  return ct.includes('application/pdf') || ct.includes('application/x-pdf');
}

function headerValue(
  headers: chrome.webRequest.HttpHeader[] | undefined,
  name: string
): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value;
}

function isAttachment(headers: chrome.webRequest.HttpHeader[] | undefined): boolean {
  return /attachment/i.test(headerValue(headers, 'content-disposition') ?? '');
}

/* ---------------- 决策日志 ---------------- */

async function logDecision(entry: Omit<InterceptLogEntry, 'at'>): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(LOG_KEY);
    const list = (stored[LOG_KEY] as InterceptLogEntry[] | undefined) ?? [];
    const next = [{ at: Date.now(), ...entry }, ...list].slice(0, LOG_LIMIT).map(redactInterceptEntry);
    await chrome.storage.session.set({ [LOG_KEY]: next });
  } catch (err) {
    log.debug('写接管日志失败', err);
  }
}

/* ---------------- 接管判断 ---------------- */

/** 返回 null 表示可以接管，否则返回不能接管的原因（用于日志与提示） */
async function skipReason(url: string): Promise<string | null> {
  if (!url) return '空 URL';
  if (isOurUrl(url)) return '已经是 页灯 YEDENG 阅读器';
  if (url.startsWith('chrome://') || url.startsWith('devtools://')) return '浏览器内部页面';
  const host = hostOf(url);
  if (SKIP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return '扩展商店页面';
  const settings = await loadSettings();
  if (!settings.hijack.enabled) return '设置里关闭了「自动接管」';
  if (settings.hijack.deny.some((d) => d && host.includes(d))) return `域名 ${host} 在黑名单里`;
  const allow = settings.hijack.allow.filter(Boolean);
  if (allow.length > 0 && !allow.some((a) => host.includes(a))) return `域名 ${host} 不在白名单里`;
  if (url.startsWith('file://')) {
    return null; // file:// 能不能拿到取决于「允许访问文件网址」，失败会在 viewer 里提示
  }
  return null;
}

async function hijack(tabId: number, url: string, reason: string, kind: InterceptLogEntry['kind']): Promise<void> {
  if (tabId < 0) return;
  const host = hostOf(url);
  const base = { url, host, kind } as const;

  if (allowOnce.get(tabId) === url) {
    allowOnce.delete(tabId);
    log.debug('放行一次原生打开', url);
    await logDecision({ ...base, decision: 'skipped', reason: '你刚点了「改用浏览器阅读器」' });
    return;
  }

  const now = Date.now();
  if (now - (cooldown.get(tabId) ?? 0) < 3000) {
    // 冷却期内的重复触发（响应头 + URL 规则会各报一次）不必写日志，免得刷屏
    return;
  }

  const reason0 = await skipReason(url);
  if (reason0) {
    await logDecision({ ...base, decision: 'skipped', reason: reason0 });
    return;
  }

  cooldown.set(tabId, now);
  const record: PendingPdf = { url, tabId, detectedAt: now };
  pending.set(tabId, record);
  await chrome.storage.session.set({ [`pending:${tabId}`]: record });

  log.info(`接管 PDF（${reason}）`, url);
  try {
    await chrome.tabs.update(tabId, { url: viewerUrl(url) });
    await logDecision({ ...base, decision: 'hijacked', reason: `由${reason}触发` });
  } catch (err) {
    log.warn('接管失败', err);
    await logDecision({
      ...base,
      decision: 'failed',
      reason: `切换标签页失败：${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/* ---------------- 内嵌 PDF：注入一个打开按钮 ---------------- */

/** 注入到页面里的函数（必须是自包含的：会被序列化后执行） */
function injectEmbedButton(pdfUrl: string): void {
  const ID = 'moonlight-lite-embed-open';
  const existing = document.getElementById(ID);
  if (existing) {
    existing.dataset.url = pdfUrl;
    return;
  }
  const button = document.createElement('button');
  button.id = ID;
  button.dataset.url = pdfUrl;
  button.textContent = '用页灯 打开这篇论文';
  Object.assign(button.style, {
    position: 'fixed',
    right: '18px',
    bottom: '18px',
    zIndex: '2147483647',
    padding: '10px 14px',
    border: '0',
    borderRadius: '999px',
    background: '#4a6cf7',
    color: '#fff',
    font: '13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
    boxShadow: '0 8px 24px rgba(15,20,30,.28)',
    cursor: 'pointer',
  });
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    const url = (event.currentTarget as HTMLButtonElement).dataset.url ?? pdfUrl;
    chrome.runtime.sendMessage({ type: 'open-viewer', url });
  });
  document.documentElement.appendChild(button);
}

async function offerEmbedButton(tabId: number, pdfUrl: string): Promise<void> {
  if (tabId < 0) return;
  if (offeredEmbed.get(tabId) === pdfUrl) return;
  const reason = await skipReason(pdfUrl);
  if (reason) {
    await logDecision({
      url: pdfUrl,
      host: hostOf(pdfUrl),
      kind: 'sub_frame',
      decision: 'skipped',
      reason,
    });
    return;
  }
  offeredEmbed.set(tabId, pdfUrl);
  try {
    // 注意：要注入到**顶层页面**（frameIds: [0]），PDF 那一帧本身没有可操作的 DOM
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: injectEmbedButton,
      args: [pdfUrl],
    });
    await logDecision({
      url: pdfUrl,
      host: hostOf(pdfUrl),
      kind: 'sub_frame',
      decision: 'offered',
      reason: '这是页面内嵌的 PDF，已在右下角提供「用 页灯 YEDENG 打开」按钮',
    });
  } catch (err) {
    await logDecision({
      url: pdfUrl,
      host: hostOf(pdfUrl),
      kind: 'sub_frame',
      decision: 'failed',
      reason: `注入按钮失败：${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/* ---------------- 顶层导航的响应头观察 ---------------- */

chrome.webRequest.onHeadersReceived.addListener(
  (details): undefined => {
    if (details.tabId < 0) return undefined;
    const ct = headerValue(details.responseHeaders, 'content-type');
    if (!isPdfContentType(ct)) return undefined;

    if (details.type === 'sub_frame') {
      void offerEmbedButton(details.tabId, details.url);
      return undefined;
    }

    if (isAttachment(details.responseHeaders)) {
      // 尊重下载意图，但仍然记一笔，方便用户知道"为什么没接管"
      void logDecision({
        url: details.url,
        host: hostOf(details.url),
        kind: 'main_frame',
        contentType: ct,
        decision: 'skipped',
        reason: '服务器要求下载该文件（Content-Disposition: attachment）',
      });
      return undefined;
    }

    void hijack(details.tabId, details.url, '响应头 content-type', 'main_frame');
    return undefined;
  },
  { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
  ['responseHeaders']
);

/* ---------------- URL 正则兜底 ---------------- */

async function maybeHijackByUrl(tabId: number, url: string, kind: InterceptLogEntry['kind']): Promise<void> {
  const settings = await loadSettings();
  let matches = false;
  try {
    matches = new RegExp(settings.hijack.pattern || '\\.pdf($|[?#])', 'i').test(url);
  } catch {
    matches = /\.pdf($|[?#])/i.test(url);
  }
  if (!matches) return;
  await hijack(tabId, url, 'URL 规则', kind);
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  void maybeHijackByUrl(details.tabId, details.url, 'main_frame');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || tabId < 0) return;
  void maybeHijackByUrl(tabId, changeInfo.url, 'main_frame');
});

/* ---------------- 图标徽标：一眼看出扩展是否在接管 ---------------- */

async function refreshBadge(): Promise<void> {
  try {
    const settings = await loadSettings();
    const on = settings.hijack.enabled;
    await chrome.action.setBadgeText({ text: on ? 'ON' : 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ color: on ? '#2f9e44' : '#8a94a6' });
    await chrome.action.setTitle({
      title: on
        ? '页灯 YEDENG：已开启 PDF 接管'
        : '页灯 YEDENG：接管已关闭（可点开手动打开）',
    });
  } catch (err) {
    log.debug('刷新徽标失败', err);
  }
}

/* ---------------- 右键菜单 ---------------- */

const installMenus=menuInstaller(chrome.contextMenus,()=>chrome.runtime.lastError?.message);
function setupMenus():void { void installMenus().catch(error=>log.warn('右键菜单初始化失败',error)); }

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const target = info.menuItemId === 'ml-open-link' ? info.linkUrl : info.pageUrl ?? tab?.url;
  if (!target) return;
  void logDecision({
    url: target,
    host: hostOf(target),
    kind: 'manual',
    decision: 'hijacked',
    reason: '右键菜单手动打开',
  });
  void chrome.tabs.create({ url: viewerUrl(target) });
});

chrome.runtime.onInstalled.addListener((details) => {
  setupMenus();
  void refreshBadge();
  if (details.reason === 'install' || details.reason === 'update') {
    void (async()=>{try{const settings=await loadSettings(),seen=await chrome.storage.local.get('yedeng.onboarding.seen.v1');
      if(shouldOfferOnboarding(settings,seen['yedeng.onboarding.seen.v1'])){await chrome.tabs.create({url:chrome.runtime.getURL('welcome/index.html')});await chrome.storage.local.set({'yedeng.onboarding.seen.v1':true});}
    }catch{/* Popup keeps an explicit setup entry if first-run launch fails. */}})();
  }
});

chrome.runtime.onStartup.addListener(() => {
  setupMenus();
  void refreshBadge();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pending.delete(tabId);
  cooldown.delete(tabId);
  allowOnce.delete(tabId);
  offeredEmbed.delete(tabId);
  void chrome.storage.session.remove(`pending:${tabId}`);
});

/* ---------------- 消息处理 ---------------- */

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  if(!validateRuntimeMessage(message,sender,chrome.runtime.id))return false;
  switch (message.type) {
    case 'installation-health': { sendResponse({extensionId:chrome.runtime.id,version:chrome.runtime.getManifest().version});return false; }
    case 'settings-changed': {
      void refreshBadge();
      return false;
    }
    case 'get-pending-pdf': {
      const tabId = message.tabId >= 0 ? message.tabId : sender.tab?.id ?? -1;
      const fromMemory = pending.get(tabId);
      if (fromMemory) {
        sendResponse(fromMemory);
        return true;
      }
      void chrome.storage.session.get(`pending:${tabId}`).then((stored) => {
        sendResponse((stored[`pending:${tabId}`] as PendingPdf | undefined) ?? null);
      });
      return true;
    }
    case 'get-intercept-log': {
      void chrome.storage.session.get(LOG_KEY).then((stored) => {
        sendResponse(((stored[LOG_KEY] as InterceptLogEntry[] | undefined) ?? []).map(redactInterceptEntry));
      });
      return true;
    }
    case 'clear-intercept-log': {
      void chrome.storage.session.remove(LOG_KEY);
      return false;
    }
    case 'open-viewer': {
      void chrome.tabs.create({ url: viewerUrl(message.url) });
      return false;
    }
    case 'open-options': {
      void chrome.runtime.openOptionsPage();
      return false;
    }
    case 'open-library': {
      void chrome.tabs.create({ url: LIBRARY_URL });
      return false;
    }
    case 'open-url': {
      void chrome.tabs.create({ url: message.url });
      return false;
    }
    case 'allow-native': {
      const tabId = message.tabId ?? sender.tab?.id ?? -1;
      if (tabId >= 0) {
        allowOnce.set(tabId, message.url);
        // 稍后清理，避免长期驻留
        setTimeout(() => {
          if (allowOnce.get(tabId) === message.url) allowOnce.delete(tabId);
        }, 15000);
      }
      return false;
    }
    case 'set-hijack': {
      void (async () => {
        const settings = await loadSettings();
        settings.hijack.enabled = message.enabled;
        await saveSettings(settings);
        await refreshBadge();
      })();
      return false;
    }
    default:
      return false;
  }
});

// SW 每次被唤醒时同步一次徽标状态
void refreshBadge();
