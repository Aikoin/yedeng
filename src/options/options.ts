import {modelChoices,importCompatibleSettings} from './compatibility';
/** 设置页：服务商、模型路由、提示词、阅读器、数据与隐私 */
import {initBackupControls} from '../storage/backupControls';
import {portableRecord} from '../storage/backup';
import { PROMPT_VERSION } from '../ai/prompts';
import { testConnection } from '../ai/router';
import { describeAiError } from '../ai/types';
import { clear as clearHost, h, qs } from '../shared/dom';
import { setLang } from '../shared/i18n';
import { idbCount, idbWipeAll } from '../shared/idb';
import {
  isOfficialDeepSeek,
  FEATURES,
  FEATURE_LABELS,
  loadSettings,
  saveSettings,
  type FeatureKey,
  type ProviderConfig,
  type Settings,
} from '../shared/settings';
import { toast } from '../shared/toast';

let settings: Settings;

const PRESETS: Record<string, { name: string; baseUrl: string; models: string[] }> = {
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'] },
  moonshot: { name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-32k'] },
  siliconflow: {
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
  },
};

const PROMPT_PLACEHOLDERS: Record<FeatureKey | 'custom', string> = {
  translate: '留空使用内置翻译提示词',
  explain: '留空使用内置解释提示词',
  summary: '留空使用内置 3 行摘要提示词',
  sectionSummary: '留空使用内置逐节摘要提示词',
  keywords: '留空使用内置关键词提示词',
  chat: '留空使用内置问答提示词',
  custom: '追加到所有功能的额外要求',
};

async function init(): Promise<void> {
  settings = await loadSettings();
  setLang(settings.ui.lang);
  document.documentElement.dataset.theme = settings.ui.theme;

  bindStatic();
  bindNavigation();
  initBackupControls(qs('#backup-controls'));
  renderProviders();
  renderRouting();
  renderPrompts();
  await renderStorageInfo();
  qs('#opt-custom-prompt').textContent = '';
  (qs<HTMLTextAreaElement>('#opt-custom-prompt') as HTMLTextAreaElement).value = settings.prompts.custom ?? '';
}

function persist(showToast = false): void {
  void saveSettings(settings).then(() => {
    if (showToast) toast('已保存', 'success', 1200);
    void renderStorageInfo();
  }).catch(error=>toast(`未能保存设置：${error instanceof Error?error.message:'请重试'}`,'error'));
}

/* ---------------- 服务商 ---------------- */

function renderProviders(): void {
  const host = qs('#provider-list');
  clearHost(host);
  if (settings.providers.length === 0) {
    host.appendChild(h('p', { class: 'muted' }, '还没有服务商。点下面的按钮新增，或先用上面的快速填充。'));
    return;
  }
  settings.providers.forEach((provider, index) => host.appendChild(providerCard(provider, index)));
}

function providerCard(provider: ProviderConfig, index: number): HTMLElement {
  const card = h('div', { class: 'provider' });
  const status = h('span', { class: 'status' });

  const field = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: { type?: string; placeholder?: string } = {}
  ) => {
    const input = h('input', { value, type: options.type ?? 'text', placeholder: options.placeholder ?? '' }) as HTMLInputElement;
    input.autocomplete='off';input.spellcheck=false;
    input.addEventListener('input', () => {
      onChange(input.value.trim());
      persist();
    });
    return h('label', {}, label, input);
  };

  const nameField = field('名称', provider.name, (v) => {
    provider.name = v || '未命名';
    renderRouting();
  });
  const baseField = field('服务地址', provider.baseUrl, (v) => {
    provider.baseUrl = v.replace(/\/+$/, '');
  }, { placeholder: 'https://api.deepseek.com/v1' });
  const keyField = field('API Key', provider.apiKey, (v) => {
    provider.apiKey = v;
  }, { type: 'password', placeholder: 'sk-...' });
  const modelField = field('文字模型', provider.defaultModel, (v) => {
    provider.defaultModel = v;
    renderRouting();
  }, { placeholder: 'deepseek-flash / deepseek-v4-pro' });

  const imageInput = h('select', { 'aria-label': '图像输入能力' },
    h('option', { value: 'unknown' }, '尚未确认（图片只保留在本地）'),
    h('option', { value: 'declared' }, '我已确认该模型支持图像输入')) as HTMLSelectElement;
  imageInput.value = provider.imageInput === 'declared' || provider.imageInput === 'verified' ? 'declared' : 'unknown';
  imageInput.addEventListener('change', () => { provider.imageInput = imageInput.value === 'declared' ? 'declared' : 'unknown'; persist(); });

  const modelsArea = h('textarea', { rows: '3', placeholder: '每行一个候选模型' }) as HTMLTextAreaElement;
  modelsArea.value = provider.models.join('\n');
  modelsArea.addEventListener('input', () => {
    provider.models = modelsArea.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!provider.defaultModel && provider.models[0]) provider.defaultModel = provider.models[0];
    persist();
    renderRouting();
  });

  const testButton = h(
    'button',
    {
      on: {
        click: async () => {
          status.className = 'status';
          status.textContent = '测试中…';
          try {
            const reply = await testConnection(provider, provider.defaultModel);
            status.className = 'status status--ok';
            status.textContent = `✓ 连接成功：${reply.slice(0, 40)}`;
          } catch (err) {
            const info = describeAiError(err);
            status.className = 'status status--err';
            status.textContent = `✗ ${info.message}`;
          }
        },
      },
    },
    '测试连接'
  );

  const removeButton = h(
    'button',
    {
      class: 'danger',
      on: {
        click: () => {
          settings.providers.splice(index, 1);
          persist(true);
          renderProviders();
          renderRouting();
        },
      },
    },
    '删除'
  );

  card.append(
    h(
      'div',
      { class: 'provider__head' },
      h('span', { class: 'provider__title' }, provider.name || '未命名服务'),
      h('span', { class: 'row' }, testButton, removeButton)
    ),
    h('div', { class: 'provider__grid' }, nameField, baseField, keyField, modelField),
    h('p',{class:'muted'},isOfficialDeepSeek(provider.baseUrl)?'图片任务自动使用 Flash，文字任务使用上面的型号。':'其他服务的图片任务，请在下方专用配置中选择支持图像的型号。'),
    h('details',{class:'professional'},h('summary',{},'配置其他型号与图片服务'),
      h('label',{},'此服务的图片支持声明',imageInput),
      h('p',{class:'muted'},'仅供其他服务使用。官方 DeepSeek 图片自动使用 Flash，不需要另行声明。此声明不代表图像理解质量已经验证。'),
      h('label',{},'可选文字型号（每行一个）',modelsArea)),
    h('p',{class:'muted'},'测试连接会使用合成文字发起一次请求，可能产生费用；保存设置不会调用模型。'),
    h('div', { class: 'provider__actions' }, status)
  );
  return card;
}

/* ---------------- 模型路由 ---------------- */

function renderRouting(): void {
  const host = qs('#routing-list');
  clearHost(host);
  host.appendChild(h('p', { class: 'muted' }, '以下选择只控制纯文本。包含原图的请求自动使用视觉路由；官方 DeepSeek 自动使用 Flash。'));
  const options: { value: string; label: string }[] = [{ value: '', label: '默认（第一个服务商的默认模型）' }];
  options.push(...modelChoices(settings));
  for (const feature of FEATURES) {
    const select = h('select') as HTMLSelectElement;
    for (const option of options) {
      select.appendChild(h('option', { value: option.value }, option.label));
    }
    const current = settings.routing[feature];
    if(current&&!options.some(option=>option.value===`${current.providerId}::${current.model}`))select.appendChild(h('option',{value:`${current.providerId}::${current.model}`},`已保存的型号 · ${current.model}`));
    select.value = current ? `${current.providerId}::${current.model}` : '';
    select.addEventListener('change', () => {
      if (!select.value) delete settings.routing[feature];
      else {
        const [providerId, ...rest] = select.value.split('::');
        settings.routing[feature] = { providerId, model: rest.join('::') };
      }
      persist();
    });
    host.appendChild(h('label', {}, FEATURE_LABELS[feature], select));
  }
  const vision = h('select', { 'aria-label': '其他服务的视觉路由' }) as HTMLSelectElement;
  vision.appendChild(h('option', { value: '' }, '未配置（官方 DeepSeek 自动 Flash）'));
  for (const option of options.filter(item => item.value)) vision.appendChild(h('option', { value: option.value }, option.label));
  if(settings.visionRoute&&!options.some(option=>option.value===`${settings.visionRoute!.providerId}::${settings.visionRoute!.model}`))vision.appendChild(h('option',{value:`${settings.visionRoute.providerId}::${settings.visionRoute.model}`},`已保存的图片型号 · ${settings.visionRoute.model}`));
  vision.value = settings.visionRoute ? `${settings.visionRoute.providerId}::${settings.visionRoute.model}` : '';
  vision.addEventListener('change', () => {
    if (!vision.value) delete settings.visionRoute;
    else {
      const [providerId, ...parts] = vision.value.split('::');
      settings.visionRoute = { providerId, model: parts.join('::') };
    }
    persist();
  });
  host.appendChild(h('label', {}, '其他服务的视觉路由', vision));
  host.appendChild(h('p', { class: 'muted' }, '使用其他网关时，请选择该服务实际支持图像输入的型号。不会自动换用其他服务，文字 Pro 不会覆盖图片任务。'));
}

/* ---------------- 提示词 ---------------- */

function renderPrompts(): void {
  const host = qs('#prompt-list');
  clearHost(host);
  const keys: FeatureKey[] = [...FEATURES];
  for (const key of keys) {
    const area = h('textarea', { rows: '3', placeholder: PROMPT_PLACEHOLDERS[key] }) as HTMLTextAreaElement;
    area.value = settings.prompts[key] ?? '';
    area.addEventListener('change', () => {
      if (area.value.trim()) settings.prompts[key] = area.value;
      else delete settings.prompts[key];
      persist();
    });
    host.appendChild(
      h('details', {}, h('summary', {}, `${FEATURE_LABELS[key]}（覆盖内置提示词）`), area)
    );
  }
  host.appendChild(h('p', { class: 'muted' }, `内置提示词版本：${PROMPT_VERSION}（改提示词后旧缓存会自动失效）`));
}

/* ---------------- 静态控件 ---------------- */

function bindStatic(): void {
  qs('#btn-add-provider').addEventListener('click', () => {
    settings.providers.push({
      id: crypto.randomUUID(),
      name: '新服务商',
      kind: 'openai',
      baseUrl: '',
      apiKey: '',
      models: [],
      defaultModel: '',
      temperature: 0.3,
      maxTokens: 2048,
    });
    persist();
    renderProviders();
    renderRouting();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = PRESETS[button.dataset.preset ?? ''];
      if (!preset) return;
      settings.providers.push({
        id: crypto.randomUUID(),
        name: preset.name,
        kind: 'openai',
        baseUrl: preset.baseUrl,
        apiKey: '',
        models: [...preset.models],
        defaultModel: preset.models[0] ?? '',
        temperature: 0.3,
        maxTokens: 2048,
      });
      persist();
      renderProviders();
      renderRouting();
      toast('已填充模板，记得填 API Key', 'info', 2600);
    });
  });

  bindValue('#opt-target-lang', () => settings.translate.targetLang, (v) => (settings.translate.targetLang = v || 'zh-CN'));
  bindValue('#opt-font-size', () => String(settings.ui.fontSize), (v) => (settings.ui.fontSize = clamp(Number(v) || 14, 12, 20)));
  bindValue('#opt-pattern', () => settings.hijack.pattern, (v) => (settings.hijack.pattern = v || '\\.pdf($|[?#])'));
  bindValue('#opt-theme', () => settings.ui.theme, (v) => {
    settings.ui.theme = (v as Settings['ui']['theme']) || 'auto';
    document.documentElement.dataset.theme = settings.ui.theme;
  });
  bindValue('#opt-allow', () => settings.hijack.allow.join('\n'), (v) => (settings.hijack.allow = splitLines(v)));
  bindValue('#opt-deny', () => settings.hijack.deny.join('\n'), (v) => (settings.hijack.deny = splitLines(v)));
  bindValue('#opt-cache-ttl', () => String(settings.cache.ttlDays), (v) => (settings.cache.ttlDays = Math.max(0, Number(v) || 0)));
  bindValue('#opt-max-req', () => String(settings.limits.requestsPerDay), (v) => (settings.limits.requestsPerDay = Math.max(0, Number(v) || 0)));

  const custom = qs<HTMLTextAreaElement>('#opt-custom-prompt');
  custom.addEventListener('change', () => {
    if (custom.value.trim()) settings.prompts.custom = custom.value;
    else delete settings.prompts.custom;
    persist();
  });

  bindCheck('#opt-hijack', () => settings.hijack.enabled, (v) => (settings.hijack.enabled = v));
  bindCheck('#opt-auto-overview', () => settings.reading?.autoOverview!==false, (v) => {settings.reading={autoOverview:v};});
  bindCheck('#opt-cache', () => settings.cache.enabled, (v) => (settings.cache.enabled = v));

  qs('#btn-library').addEventListener('click', () => void chrome.tabs.create({ url: chrome.runtime.getURL('library/index.html') }));
  qs('#btn-close').addEventListener('click', () => window.close());

  qs('#btn-clear-cache').addEventListener('click', async () => {
    const { idbClear } = await import('../shared/idb');
    await idbClear('cache');
    toast('AI 缓存已清空', 'success');
    await renderStorageInfo();
  });

  qs('#btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(portableRecord(settings), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'yedeng-settings-without-keys.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  const importFile = qs<HTMLInputElement>('#import-file');
  qs('#btn-import').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Settings;
      settings = importCompatibleSettings(parsed,settings);
      await saveSettings(settings);
      renderProviders();
      renderRouting();
      renderPrompts();
      syncImportedFields();
      toast('设置已导入', 'success');
    } catch (err) {
      toast(`导入失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  });

  qs('#btn-wipe').addEventListener('click', async () => {
    if (!window.confirm('会清空：设置、文献库、高亮笔记、缓存、用量。确定继续？')) return;
    await idbWipeAll();
    await chrome.storage.local.clear();
    toast('已清空，正在重新加载…', 'success');
    window.setTimeout(() => location.reload(), 800);
  });
}

function bindValue(selector: string, read: () => string, write: (value: string) => void): void {
  const input = qs<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
  input.value = read();
  input.addEventListener('change', () => {
    write(input.value.trim());
    persist(true);
  });
}

function bindCheck(selector: string, read: () => boolean, write: (value: boolean) => void): void {
  const input = qs<HTMLInputElement>(selector);
  input.checked = read();
  input.addEventListener('change', () => {
    write(input.checked);
    persist(true);
  });
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function renderStorageInfo(): Promise<void> {
  const [docs, annotations, cache] = await Promise.all([
    idbCount('docs'),
    idbCount('annotations'),
    idbCount('cache'),
  ]);
  qs('#storage-info').textContent = `本地数据：文献 ${docs} 篇 · 标注 ${annotations} 条 · 缓存 ${cache} 条`;
}

void init();

function bindNavigation():void{
 const activate=()=>{const requested=location.hash.slice(1);const name=['ai','reading','data','help'].includes(requested)?requested:['backup','backup-controls'].includes(requested)?'data':'ai';
  document.querySelectorAll<HTMLElement>('[data-page]').forEach(page=>{page.hidden=page.dataset.page!==name;});
  document.querySelectorAll<HTMLElement>('.settings-nav [data-section]').forEach(button=>{if(button.dataset.section===name)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
 };
 document.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(button=>{button.onclick=()=>{location.hash=button.dataset.section!;activate();document.querySelector<HTMLElement>(`[data-page="${button.dataset.section}"] h1`)?.focus();};});
 window.addEventListener('hashchange',activate);activate();
 qs('#app-version').textContent=`页灯 ${chrome.runtime.getManifest().version}`;
}
function syncImportedFields():void{
 const values:Record<string,string>={'opt-target-lang':settings.translate.targetLang,'opt-font-size':String(settings.ui.fontSize),'opt-pattern':settings.hijack.pattern,'opt-theme':settings.ui.theme,'opt-allow':settings.hijack.allow.join('\n'),'opt-deny':settings.hijack.deny.join('\n'),'opt-cache-ttl':String(settings.cache.ttlDays),'opt-max-req':String(settings.limits.requestsPerDay),'opt-custom-prompt':settings.prompts.custom??''};
 for(const[id,value]of Object.entries(values))qs<HTMLInputElement>(`#${id}`).value=value;
 qs<HTMLInputElement>('#opt-hijack').checked=settings.hijack.enabled;qs<HTMLInputElement>('#opt-cache').checked=settings.cache.enabled;qs<HTMLInputElement>('#opt-auto-overview').checked=settings.reading?.autoOverview!==false;document.documentElement.dataset.theme=settings.ui.theme;
}
