#!/usr/bin/env node
/**
 * 无头 Chrome 冒烟测试：真实加载扩展，验证 pdf.js 在 MV3 里能渲染出画布与文本层、
 * 文本抽取能得到段落、且没有 CSP / worker / wasm 报错。
 *
 * 用法：pnpm build && node scripts/smoke-test.mjs
 * 依赖：本机已安装 Google Chrome；Node 22+（自带 WebSocket 客户端）。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 18412;
const CDP_PORT = 19000 + Math.floor(Math.random() * 900);

/* ---------------- 1. 生成一份最小可解析的测试 PDF ---------------- */

function buildTestPdf() {
  const lines = [
    'BT /F1 18 Tf 72 720 Td (Attention Is All You Need \(Smoke Test\)) Tj ET',
    'BT /F1 12 Tf 72 690 Td (We propose a transformer architecture based purely on attention.) Tj ET',
    'BT /F1 12 Tf 72 672 Td (The encoder has six identical layers with multi head attention.) Tj ET',
    'BT /F1 14 Tf 72 620 Td (1 Introduction) Tj ET',
    'BT /F1 12 Tf 72 596 Td (Recurrent models have long been the standard for sequence modeling.) Tj ET',
    'BT /F1 12 Tf 72 578 Td (They are slow to train because of their sequential nature.) Tj ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${lines.length} >>\nstream\n${lines}\nendstream`,
    '<< /Type /Annot /Subtype /Link /Rect [72 690 520 705] /Border [0 0 1] /A << /S /URI /URI (https://arxiv.org/) >> >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const pdfBytes = buildTestPdf();
const server = createServer((req, res) => {
  if (req.url?.startsWith('/paper.pdf')) {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdfBytes.length });
    res.end(pdfBytes);
    return;
  }
  res.writeHead(404).end('not found');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`✓ 测试 PDF 已在 http://127.0.0.1:${PORT}/paper.pdf 提供（${pdfBytes.length} 字节）`);

/* ---------------- 2. 启动无头 Chrome 并加载扩展 ---------------- */

if (!existsSync(CHROME)) {
  console.error(`✗ 未找到 Chrome：${CHROME}`);
  process.exit(2);
}
if (!existsSync(resolve(dist, 'manifest.json'))) {
  console.error('✗ 请先执行 pnpm build');
  process.exit(2);
}

const profile = mkdtempSync(resolve(tmpdir(), 'ml-smoke-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    // CDP 的 WebSocket 会校验 Origin，必须显式放开
    '--remote-allow-origins=*',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DialMediaRouteProvider',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--load-extension=${dist}`,
    `--disable-extensions-except=${dist}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
chrome.stderr.on('data', (d) => {
  const text = String(d);
  if (/ERROR|FATAL/.test(text) && !/DevTools listening|Fontconfig|GPU/.test(text)) {
    process.stdout.write(`[chrome] ${text}`);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(path) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`);
  return res.json();
}

/** 未打包扩展的 ID 由绝对路径的 SHA-256 推出（前 16 字节，nibble 映射到 a-p） */
function extensionIdForPath(absPath) {
  const hash = createHash('sha256').update(absPath).digest('hex').slice(0, 32);
  return hash.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

let extensionId = '';
for (let i = 0; i < 40 && !extensionId; i++) {
  try {
    const targets = await fetchJson('/json/list');
    const sw = targets.find((t) => typeof t.url === 'string' && t.url.startsWith('chrome-extension://'));
    if (sw) extensionId = new URL(sw.url).host;
  } catch {
    /* Chrome 还没起来 */
  }
  if (!extensionId) await sleep(500);
}
if (!extensionId) {
  extensionId = extensionIdForPath(dist);
  console.log(`⚠ 未从 service worker 拿到 ID，改用路径推导：${extensionId}`);
}
console.log(`✓ 扩展 ID：${extensionId}`);

/* ---------------- 3. CDP：打开阅读器、收集报错、断言 ---------------- */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (event) => {
      const raw = String(event.data);
      if (process.env.ML_SMOKE_VERBOSE) console.log(`[cdp←] ${raw.slice(0, 300)}`);
      const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : ok(msg.result);
      } else if (msg.method) {
        for (const handler of this.handlers) handler(msg);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok);
      ws.addEventListener('error', fail);
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((ok, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          ok(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  on(handler) {
    this.handlers.push(handler);
  }
}

console.log('→ 连接 CDP…');
const browser = await Cdp.connect((await fetchJson('/json/version')).webSocketDebuggerUrl);
console.log('✓ CDP 已连接');
const problems = [];
browser.on((msg) => {
  const text =
    msg.method === 'Runtime.exceptionThrown'
      ? msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text
      : msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error'
        ? (msg.params.args ?? []).map((a) => a.value ?? a.description).join(' ')
        : msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error'
          ? `${msg.params.entry.text} ${msg.params.entry.url ?? ''}`
          : null;
  if (text) problems.push(`[${msg.method}] ${text}`);
});

console.log('→ 打开阅读器页面…');
const { targetId } = await browser.send('Target.createTarget', {
  url: `chrome-extension://${extensionId}/viewer/index.html?src=http://127.0.0.1:${PORT}/paper.pdf`,
});
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
console.log(`✓ 已附着到页面 target ${targetId}`);
const send = (method, params) => browser.send(method, params, sessionId);
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate 抛错');
  }
  return result.result.value;
};

// 等文档加载 + 渲染 + 文本抽取
let snapshot = null;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  if (i % 5 === 0) console.log(`  …等待渲染与文本抽取（${i + 1}s）`);
  snapshot = await evaluate(`(() => {
    const s = window.__ml && window.__ml.state;
    return {
      pages: document.querySelectorAll('.ml-page').length,
      canvases: document.querySelectorAll('.ml-page canvas').length,
      spans: document.querySelectorAll('.textLayer span').length,
      links: document.querySelectorAll('.annotationLayer .linkAnnotation').length,
      title: document.querySelector('#doc-title')?.textContent ?? '',
      paragraphs: (s && s.docText && s.docText.pages[0]?.paragraphs.map(p => p.text)) || [],
      sections: (s && s.docText && s.docText.sections.map(x => x.title)) || [],
      chunks: (s && s.chunks && s.chunks.length) || 0,
      hasText: !!(s && s.docText && s.docText.hasText),
    };
  })()`);
  if (snapshot.spans > 0 && snapshot.paragraphs.length > 0) break;
}

console.log('\n—— 阅读器快照 ——');
console.log(JSON.stringify(snapshot, null, 2));

const checks = [
  [snapshot.pages >= 1, '页面容器已创建'],
  [snapshot.canvases >= 1, 'canvas 已渲染'],
  [snapshot.spans > 0, '文本层已渲染（可划词）'],
  [snapshot.links >= 1, 'PDF 链接注释层已渲染'],
  [snapshot.title.includes('Attention'), `标题已解析：${snapshot.title}`],
  [snapshot.paragraphs.some((p) => p.includes('transformer')), '正文段落重建成功'],
  [snapshot.sections.length >= 1, `章节切分：${snapshot.sections.join(' / ')}`],
  [snapshot.chunks > 0, `检索分块：${snapshot.chunks} 块`],
  [snapshot.hasText, '文档有文字层'],
  [problems.length === 0, `无控制台/页面报错（${problems.length} 条）`],
];

console.log('\n—— 断言 ——');
let failed = 0;
for (const [ok, label] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed++;
}
if (problems.length > 0) {
  console.log('\n—— 报错明细 ——');
  for (const p of problems.slice(0, 12)) console.log(`  ${p}`);
}

/* ---------------- 4. 清理 ---------------- */

chrome.kill('SIGKILL');
server.close();
writeFileSync(resolve(tmpdir(), 'moonlight-smoke-result.json'), JSON.stringify({ snapshot, problems }, null, 2));

if (failed > 0) {
  console.error(`\n✗ 冒烟测试未通过（${failed} 项失败）`);
  process.exit(1);
}
console.log('\n✓ 冒烟测试通过：pdf.js 在 MV3 扩展里渲染、文本层、链接层、文本抽取与章节切分都正常');
process.exit(0);
