import { runInstallationCheck, type InstallationReport, type InstallationMarker } from './check';
import { h, qs } from '../shared/dom';
import { sendMessage } from '../shared/messaging';
const pageInstance = crypto.randomUUID(), markerKey = 'yedeng.installation-check.marker.v1';
let report: InstallationReport | null = null;
let reopenedThisPage = false;
const native = location.protocol === 'chrome-extension:';
const manifest = native ? chrome.runtime.getManifest() : { version: '网页预览' };
qs('#version').textContent = `版本 ${manifest.version} · 本机安装`;
const manual = () => Object.fromEntries(Array.from(document.querySelectorAll<HTMLInputElement>('[data-manual]')).map(el => [el.dataset.manual!, el.checked]));
function snapshot() {
  return { ...report, manualChecks: manual(), manualSource: 'user_attestation_not_automatically_verified', browserProcessRestartVerified: false,
    allManualItemsReported: Object.values(manual()).every(Boolean), scope: 'Independent installation only; original extension upgrade not performed',
    containsApiKey: false, containsPrivatePapers: false, permissionChanges: false, formulaRecognitionStatus: 'trial_with_source_review' };
}
function show() { qs('#result').textContent = JSON.stringify(snapshot(), null, 2); }
for (const checkbox of document.querySelectorAll('[data-manual]')) checkbox.addEventListener('change', show);
async function scratchRoundTrip(): Promise<boolean> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('yedeng-installation-check-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('probe');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const nonce = crypto.randomUUID();
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('probe', 'readwrite'); tx.objectStore('probe').put(nonce, 'self-check'); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); }); }
  finally { db.close(); }
  const reopened = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('yedeng-installation-check-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try { return await new Promise<boolean>((resolve, reject) => { const tx = reopened.transaction('probe', 'readonly'), request = tx.objectStore('probe').get('self-check'); tx.oncomplete = () => resolve(request.result === nonce); tx.onabort = () => reject(tx.error); }); }
  finally { reopened.close(); }
}
qs<HTMLButtonElement>('#run').onclick = () => void (async () => {
  const button = qs<HTMLButtonElement>('#run'); button.disabled = true;
  qs<HTMLButtonElement>('#download').disabled = true;
  try {
    report = await runInstallationCheck({ protocol: location.protocol, originHost: location.hostname, extensionId: native ? chrome.runtime.id : '', version: manifest.version,
      userAgent: navigator.userAgent, pageInstance,
      readMarker: async () => { const v = (await chrome.storage.local.get(markerKey))[markerKey] as Partial<InstallationMarker> | undefined; return v && typeof v.pageInstance === 'string' && typeof v.at === 'number' && typeof v.version === 'string' ? v as InstallationMarker : null; },
      writeMarker: async value => { await chrome.storage.local.set({ [markerKey]: value }); },
      readPermissions: () => chrome.permissions.getAll(), fileAccess: () => chrome.extension.isAllowedFileSchemeAccess(),
      background: () => sendMessage({ type: 'installation-health' }),
      checkAssets: async () => {
        for (const path of ['viewer/index.html', 'options/index.html', 'library/index.html', 'icons/brand.svg', 'icons/16.png', 'pdfjs/pdf.worker.min.mjs']) {
          const response = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
          if (!response.ok || !(await response.arrayBuffer()).byteLength) return false;
        }
        return true;
      }, checkDatabase: scratchRoundTrip });
    reopenedThisPage ||= report.previousPageRecovered;
    report.previousPageRecovered ||= reopenedThisPage;
    if (report.state === 'needs_reopen' && reopenedThisPage) report.state = 'ready_for_manual';
    const host = qs('#checks'); host.replaceChildren(...report.checks.map(c => h('div', { class: 'check', dataset: { state: c.status } }, h('strong', {}, `${c.status === 'pass' ? '✓' : c.status === 'fail' ? '未通过' : '·'} ${c.label}`), h('small', {}, c.detail))));
    qs('#status').textContent = report.state === 'blocked' ? '检查未通过。请下载结果；网页预览不会记作实机通过。'
      : report.state === 'needs_reopen' ? '自动项目通过。请关闭此页，从插件重新打开，再运行一次以核对重开恢复。'
      : '自动项目与检查页重开恢复通过。请完成下方实际阅读项目，再下载结果。完整 Chrome 重启未自动验证。';
    show(); qs<HTMLButtonElement>('#download').disabled = false;
  } catch { qs('#status').textContent = '检查未完成，请重新运行。没有修改论文库或发送模型请求。'; }
  finally { button.disabled = false; }
})();
qs('#reader').onclick = () => { if (native) void chrome.tabs.create({ url: chrome.runtime.getURL('viewer/index.html') }); };
qs('#download').onclick = () => {
  if (!report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `yedeng-installation-${report.version}.json` }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
