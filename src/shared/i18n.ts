/** 极简 i18n：中文优先，英文作为备用字典。缺 key 时回退中文，再回退 key 本身。 */

export type Lang = 'zh' | 'en';

type Entry = { zh: string; en: string };

const MESSAGES: Record<string, Entry> = {
  appName: { zh: 'Moonlight Lite', en: 'Moonlight Lite' },
  // 顶栏
  backToSource: { zh: '返回原链接', en: 'Back to source' },
  addToLibrary: { zh: '加入文献库', en: 'Add to library' },
  inLibrary: { zh: '已入库', en: 'In library' },
  zoomOut: { zh: '缩小', en: 'Zoom out' },
  zoomIn: { zh: '放大', en: 'Zoom in' },
  fitWidth: { zh: '适应宽度', en: 'Fit width' },
  theme: { zh: '主题', en: 'Theme' },
  settings: { zh: '设置', en: 'Settings' },
  openNative: { zh: '改用浏览器阅读器', en: 'Open in browser viewer' },
  openLocal: { zh: '打开本地 PDF', en: 'Open local PDF' },
  sidebar: { zh: '侧边栏', en: 'Sidebar' },
  // 侧边栏页签
  tabAi: { zh: 'AI', en: 'AI' },
  tabMarks: { zh: '高亮', en: 'Highlights' },
  tabNotes: { zh: '笔记', en: 'Notes' },
  // 摘要
  threeLineSummary: { zh: '3 行摘要', en: '3-line summary' },
  sectionSummary: { zh: '逐节摘要', en: 'Section summaries' },
  keywords: { zh: '关键词', en: 'Keywords' },
  regenerate: { zh: '重新生成', en: 'Regenerate' },
  generating: { zh: '生成中…', en: 'Generating…' },
  collapsed: { zh: '已折叠', en: 'Collapsed' },
  // 对话
  chatPlaceholder: { zh: '就这篇论文提问，Enter 发送 / Shift+Enter 换行', en: 'Ask about this paper…' },
  send: { zh: '发送', en: 'Send' },
  stop: { zh: '停止', en: 'Stop' },
  retry: { zh: '重试', en: 'Retry' },
  copy: { zh: '复制', en: 'Copy' },
  copied: { zh: '已复制', en: 'Copied' },
  clearChat: { zh: '清空对话', en: 'Clear chat' },
  clearChatConfirm: { zh: '确定清空本文档的对话记录？', en: 'Clear this document chat?' },
  model: { zh: '模型', en: 'Model' },
  // 划词工具条
  translate: { zh: '翻译', en: 'Translate' },
  explain: { zh: '解释', en: 'Explain' },
  highlight: { zh: '高亮', en: 'Highlight' },
  note: { zh: '笔记', en: 'Note' },
  askFollowUp: { zh: '追问', en: 'Follow up' },
  pin: { zh: '固定', en: 'Pin' },
  close: { zh: '关闭', en: 'Close' },
  // 标注
  noHighlights: { zh: '还没有高亮。选中正文后按 1/2/3 即可高亮。', en: 'No highlights yet.' },
  noNotes: { zh: '还没有笔记。选中正文后按 N 记一条。', en: 'No notes yet.' },
  delete: { zh: '删除', en: 'Delete' },
  notePlaceholder: { zh: '写点什么…（支持 Markdown）', en: 'Write a note… (Markdown ok)' },
  save: { zh: '保存', en: 'Save' },
  cancel: { zh: '取消', en: 'Cancel' },
  // 状态
  loadingDoc: { zh: '正在加载 PDF…', en: 'Loading PDF…' },
  extracting: { zh: '正在解析文本…', en: 'Extracting text…' },
  noTextLayer: {
    zh: '这份 PDF 没有文字层（可能是扫描版），AI 功能与划词都不可用。v1 不支持 OCR。',
    en: 'No text layer detected (scanned PDF?). AI features are unavailable.',
  },
  needApiKey: { zh: '还没有配置 AI 服务，点击去设置', en: 'No AI provider configured. Open settings.' },
  goSettings: { zh: '去设置', en: 'Settings' },
  loadFailed: { zh: 'PDF 加载失败', en: 'Failed to load PDF' },
  loadFailedHint: {
    zh: '可能是需要登录/防盗链的站点。可以先下载 PDF，再用「打开本地 PDF」或直接拖入窗口。',
    en: 'The site may require login or block hotlinking. Download the PDF and open it locally.',
  },
  passwordPrompt: { zh: '这个 PDF 有密码，请输入密码：', en: 'This PDF is password protected:' },
  requestsToday: { zh: '今日请求', en: 'Requests today' },
  // 设置页
  providers: { zh: 'AI 服务商', en: 'Providers' },
  addProvider: { zh: '新增服务商', en: 'Add provider' },
  testConnection: { zh: '测试连接', en: 'Test connection' },
  baseUrl: { zh: 'Base URL（到 /v1 为止）', en: 'Base URL' },
  apiKey: { zh: 'API Key', en: 'API Key' },
  defaultModel: { zh: '默认模型', en: 'Default model' },
  modelsHint: { zh: '候选模型（每行一个）', en: 'Models (one per line)' },
  routing: { zh: '功能 → 模型', en: 'Feature routing' },
  routingHint: { zh: '留空即使用默认模型', en: 'Empty = default model' },
  prompts: { zh: '提示词', en: 'Prompts' },
  promptsHint: { zh: '留空使用内置默认；填写则完全覆盖该功能的系统提示词', en: 'Empty = built-in prompt' },
  customPrompt: { zh: '自定义补充提示词', en: 'Custom extra prompt' },
  reader: { zh: '阅读器', en: 'Reader' },
  hijackEnabled: { zh: '打开 PDF 时自动接管', en: 'Auto-open PDFs' },
  denyList: { zh: '不接管的域名（每行一个）', en: 'Deny list' },
  data: { zh: '数据', en: 'Data' },
  cacheEnabled: { zh: '启用 AI 结果缓存', en: 'Cache AI results' },
  cacheTtl: { zh: '缓存有效期（天，0=永久）', en: 'Cache TTL days (0 = forever)' },
  clearCache: { zh: '清空缓存', en: 'Clear cache' },
  clearData: { zh: '清空全部本地数据', en: 'Wipe all local data' },
  exportData: { zh: '导出备份 JSON', en: 'Export JSON' },
  importData: { zh: '导入备份 JSON', en: 'Import JSON' },
  privacy: { zh: '隐私说明', en: 'Privacy' },
  privacyText: {
    zh: 'API Key 与所有标注只保存在浏览器本机（chrome.storage.local / IndexedDB），不会上传到任何第三方服务器。AI 请求直接从本机发往你填写的 Base URL。',
    en: 'Keys and annotations stay on this machine. AI requests go directly to your configured Base URL.',
  },
  fontSize: { zh: '字号', en: 'Font size' },
  targetLang: { zh: '翻译目标语言', en: 'Target language' },
  maxPerDay: { zh: '每日请求上限（0=不限）', en: 'Daily request cap (0 = none)' },
  saved: { zh: '已保存', en: 'Saved' },
  error: { zh: '出错', en: 'Error' },
  // popup
  openCurrent: { zh: '用 Moonlight Lite 打开当前页', en: 'Open current page' },
  openLibrary: { zh: '文献库', en: 'Library' },
  openSettings: { zh: '设置', en: 'Settings' },
  openViewer: { zh: '阅读器', en: 'Reader' },
  notPdf: { zh: '当前页可能不是 PDF，仍要尝试打开吗？', en: 'Current page may not be a PDF. Try anyway?' },
  // 库
  recent: { zh: '最近阅读', en: 'Recent' },
  favorites: { zh: '收藏', en: 'Favorites' },
  allDocs: { zh: '全部', en: 'All' },
  newFolder: { zh: '新建文件夹', en: 'New folder' },
  search: { zh: '搜索标题/作者', en: 'Search' },
  empty: { zh: '还没有文档。打开一个 PDF 就会自动入库。', en: 'No documents yet.' },
  pages: { zh: '页', en: 'pages' },
};

let current: Lang = 'zh';

export function setLang(lang: Lang): void {
  current = lang;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}

export function getLang(): Lang {
  return current;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const entry = MESSAGES[key];
  let text = entry ? entry[current] || entry.zh : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return text;
}

/** 把带 data-i18n 的元素批量翻译（静态 HTML 用） */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (!key) return;
    const target = el.dataset.i18nAttr;
    if (target) el.setAttribute(target, t(key));
    else el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    if (key) el.setAttribute('placeholder', t(key));
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (key) el.setAttribute('title', t(key));
  });
}
