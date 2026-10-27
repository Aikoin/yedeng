#!/usr/bin/env node
/** 构建产物完整性断言：防止漏拷 worker/资源或 manifest 版本写错 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

const required = [
  'welcome/index.html',
  'health/index.html',
  'manifest.json',
  'background.js',
  'viewer/index.html',
  'options/index.html',
  'popup/index.html',
  'library/index.html',
  'pdfjs/pdf.worker.min.mjs',
  'pdfjs/pdf_viewer.css',
  'pdfjs/cmaps',
  'pdfjs/standard_fonts',
  'icons/brand.svg',
  'icons/16.png',
  'icons/48.png',
  'icons/128.png',
];

let failed = false;
for (const rel of required) {
  const p = resolve(dist, rel);
  const ok = existsSync(p);
  console.log(`${ok ? '✓' : '✗'} ${rel}`);
  if (!ok) failed = true;
}

const mfPath = resolve(dist, 'manifest.json');
if (existsSync(mfPath)) {
  const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
  const checks = [
    [mf.manifest_version === 3, 'manifest_version = 3'],
    [mf.version === JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version, 'manifest version matches package version'],
    [mf.version_name === undefined || mf.version_name === mf.version, 'display version matches actual version'],
    [mf.background?.service_worker === 'background.js', 'service_worker = background.js'],
    [mf.options_page === 'options/index.html', 'options_page 正确'],
    [mf.action?.default_popup === 'popup/index.html', 'default_popup 正确'],
    [/wasm-unsafe-eval/.test(mf.content_security_policy?.extension_pages ?? ''), "CSP 含 'wasm-unsafe-eval'"],
    [(mf.permissions ?? []).includes('webRequest'), 'permissions 含 webRequest'],
  ];
  for (const [ok, label] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failed = true;
  }
}

const assetsDir = resolve(dist, 'assets');
if (existsSync(assetsDir)) {
  console.log(`✓ assets/ 共 ${readdirSync(assetsDir).length} 个文件`);
}
// Diagnostic PDFs/pages and localhost shims must never enter the extension package.
function filesUnder(folder, prefix = '') {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(resolve(folder, entry.name), relative) : [relative];
  });
}
if (existsSync(dist)) {
  const files = filesUnder(dist);
  const unwanted = files.filter((file) => /(?:^|\/)(?:fixtures|work|tests)(?:\/|$)|\.pdf$|(?:^|\/)(?:g0|boundary-g0|ledger-g0|migration-g0|evidence-g2|annotation-cas-g1|execution-claims-g2|formula-persistence-g3|formula-evaluation-g3|evaluation-recovery-g3|backup-recovery-g4|reader-backup-clone-g4|migration-boundaries-g4|lifecycle-security-g4)\.html$|dev-chrome/i.test(file));
  const developmentMarkers = files.filter((file) => /\.(?:html|js|json|css)$/.test(file)).filter((file) =>
    /__g0\/vision|__g2\/mock|__g3\/evaluation|__g4\/security|isolated-localhost-preview|\/work\/dev-chrome\.ts|\/fixtures\/(?:attention|tracemonkey|boundary|password|formula-complex|formula-evaluation-crosspage)/.test(readFileSync(resolve(dist, file), 'utf8')));
  const clean = unwanted.length === 0 && developmentMarkers.length === 0;
  console.log(`${clean ? '✓' : '✗'} production package excludes fixtures, diagnostic pages and development shims`);
  if (!clean) {
    console.error({ unwanted, developmentMarkers });
    failed = true;
  }
}
const total = existsSync(dist) ? statSync(dist).isDirectory() : false;
console.log(`${total ? '✓' : '✗'} dist/ 存在`);

if (failed) {
  console.error('\n✗ 构建产物检查失败');
  process.exit(1);
}
console.log('\n✓ dist/ 构建产物完整，可在 chrome://extensions 加载已解压的扩展程序');
