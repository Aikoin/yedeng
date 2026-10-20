/** 设置模型与读写（chrome.storage.local）。SW 与所有扩展页共用。 */

export type ProviderKind = 'openai';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  /** 例如 https://api.deepseek.com/v1 （不含 /chat/completions） */
  baseUrl: string;
  apiKey: string;
  /** 手动维护的候选模型列表 */
  models: string[];
  defaultModel: string;
  temperature: number;
  maxTokens: number;
  /** User declaration is distinct from a successful vision capability probe. */
  imageInput?: 'unknown' | 'declared' | 'verified';
}

export const FEATURES = ['translate', 'explain', 'summary', 'sectionSummary', 'keywords', 'chat'] as const;
export type FeatureKey = (typeof FEATURES)[number];

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  translate: '划句翻译',
  explain: '划句解释',
  summary: '3 行摘要',
  sectionSummary: '逐节摘要',
  keywords: '关键词',
  chat: '全文问答',
};

export interface ModelRoute {
  providerId: string;
  model: string;
}

export interface Settings {
  version: 1;
  /** Invalidation epoch; dispatch also compares a private full configuration digest. */
  revision: number;
  ui: {
    lang: 'zh' | 'en';
    theme: 'auto' | 'light' | 'dark';
    fontSize: number;
    sidebarWidth: number;
  };
  providers: ProviderConfig[];
  routing: Partial<Record<FeatureKey, ModelRoute>>;
  /** Explicit visual route for non-official providers; never infer gateway model support. */
  visionRoute?: ModelRoute;
  reading?: { autoOverview: boolean };
  /** 空字符串 = 使用内置默认提示词；非空 = 完全覆盖 */
  prompts: Partial<Record<FeatureKey | 'custom', string>>;
  translate: {
    targetLang: string;
  };
  hijack: {
    enabled: boolean;
    allow: string[];
    deny: string[];
    /** 兜底的 URL 正则（当响应头观察不可用时） */
    pattern: string;
  };
  cache: {
    enabled: boolean;
    /** 0 = 永不过期 */
    ttlDays: number;
  };
  limits: {
    /** 0 = 不限制 */
    requestsPerDay: number;
  };
}

export const DEFAULT_PROMPTS: Record<FeatureKey, string> = {
  translate: '',
  explain: '',
  summary: '',
  sectionSummary: '',
  keywords: '',
  chat: '',
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  revision: 0,
  ui: { lang: 'zh', theme: 'auto', fontSize: 14, sidebarWidth: 360 },
  providers: [],
  routing: {},
  reading: { autoOverview: true },
  prompts: {},
  translate: { targetLang: 'zh-CN' },
  hijack: {
    enabled: true,
    allow: [],
    deny: [],
    pattern: '\\.pdf($|[?#])',
  },
  cache: { enabled: true, ttlDays: 0 },
  limits: { requestsPerDay: 0 },
};

const KEY = 'settings.v1';

/** 深合并，保证升级后新增字段有默认值 */
export function mergeSettings(partial: unknown): Settings {
  const base = structuredClone(DEFAULT_SETTINGS) as Settings;
  if (!partial || typeof partial !== 'object') return base;
  const p = partial as Partial<Settings>;
  return {
    version: 1,
    revision: Number.isSafeInteger(p.revision) && (p.revision ?? 0) >= 0 ? p.revision! : 0,
    ui: { ...base.ui, ...(p.ui ?? {}) },
    providers: Array.isArray(p.providers) ? p.providers.map(normalizeProvider) : base.providers,
    routing: { ...base.routing, ...(p.routing ?? {}) },
    reading: { autoOverview: p.reading?.autoOverview !== false },
    ...(p.visionRoute && typeof p.visionRoute.providerId==='string' && typeof p.visionRoute.model==='string' ? {visionRoute:{providerId:p.visionRoute.providerId,model:p.visionRoute.model}} : {}),
    prompts: { ...base.prompts, ...(p.prompts ?? {}) },
    translate: { ...base.translate, ...(p.translate ?? {}) },
    hijack: { ...base.hijack, ...(p.hijack ?? {}) },
    cache: { ...base.cache, ...(p.cache ?? {}) },
    limits: { ...base.limits, ...(p.limits ?? {}) },
  };
}

function normalizeProvider(raw: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: raw.id ?? crypto.randomUUID(),
    name: raw.name ?? '未命名服务',
    kind: 'openai',
    baseUrl: (raw.baseUrl ?? '').replace(/\/+$/, ''),
    apiKey: raw.apiKey ?? '',
    models: Array.isArray(raw.models) ? raw.models.filter(Boolean) : [],
    defaultModel: raw.defaultModel ?? raw.models?.[0] ?? '',
    temperature: typeof raw.temperature === 'number' ? raw.temperature : 0.3,
    maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : 2048,
    imageInput: raw.imageInput === 'declared' || raw.imageInput === 'verified' ? raw.imageInput : 'unknown',
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  return mergeSettings(stored[KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  const current = await loadSettings();
  settings.revision = Math.max(Date.now(), current.revision + 1);
  await chrome.storage.local.set({ [KEY]: settings });
  // 通知所有打开的扩展页刷新配置
  chrome.runtime.sendMessage({ type: 'settings-changed' }).catch(() => {
    /* 没有监听者时忽略 */
  });
}

export async function updateSettings(mutate: (s: Settings) => void): Promise<Settings> {
  const settings = await loadSettings();
  mutate(settings);
  await saveSettings(settings);
  return settings;
}

/** 返回某个功能实际使用的 { provider, model }；未配置路由时回退到第一个服务商的默认模型 */
export function resolveRoute(
  settings: Settings,
  feature: FeatureKey
): { provider: ProviderConfig; model: string } | null {
  const route = settings.routing[feature];
  if (route) {
    const provider = settings.providers.find((p) => p.id === route.providerId);
    if (provider) return { provider, model: route.model || provider.defaultModel };
  }
  const fallback = settings.providers.find((p) => p.defaultModel);
  if (fallback) return { provider: fallback, model: fallback.defaultModel };
  return null;
}

export function isConfigured(settings: Settings): boolean {
  return settings.providers.some((p) => p.baseUrl && p.apiKey && p.defaultModel);
}

export type InputModality = 'text' | 'image';
export function isOfficialDeepSeek(baseUrl:string):boolean {
  try {const url=new URL(baseUrl);return url.protocol==='https:' && url.hostname==='api.deepseek.com' && (!url.port || url.port==='443');}catch{return false;}
}
/** Final materials determine this route. Selecting a text model never opts a gateway into DeepSeek. */
export function resolveMaterialRoute(settings:Settings,feature:FeatureKey,modality:InputModality): {provider:ProviderConfig;model:string;imageRouteError?:string}|null {
  const text=resolveRoute(settings,feature);if(!text || modality==='text')return text;
  if(isOfficialDeepSeek(text.provider.baseUrl))return {provider:text.provider,model:'deepseek-flash'};
  const route=settings.visionRoute,provider=route&&settings.providers.find(item=>item.id===route.providerId);
  if(provider && route.model)return {provider,model:route.model};
  return {...text,imageRouteError:'此服务尚未配置明确的视觉路由；请配置支持图像的服务与型号，图片保留在本机。'};
}
