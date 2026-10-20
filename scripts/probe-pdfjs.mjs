#!/usr/bin/env node
/**
 * 探针：不运行 pdf.js（Node 里缺 DOMMatrix 等 Web API），只做静态检查。
 * 目的：锁定 pdfjs-dist 版本与 API 形态，避免大版本漂移导致 TextLayer 构造失败。
 * 用法：pnpm probe
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = resolve(root, 'node_modules/pdfjs-dist');

if (!existsSync(pkgDir)) {
  console.error('✗ 未找到 node_modules/pdfjs-dist，请先执行 pnpm install');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8'));
console.log(`pdfjs-dist 版本: ${pkg.version}`);

const mainFile = resolve(pkgDir, 'build/pdf.mjs');
if (!existsSync(mainFile)) {
  console.error('✗ 缺少 build/pdf.mjs');
  process.exit(1);
}
const src = readFileSync(mainFile, 'utf8');

const required = ['getDocument', 'GlobalWorkerOptions', 'TextLayer', 'PDFWorker'];
let failed = false;
for (const name of required) {
  const re = new RegExp(`\\b${name}\\b`);
  const ok = re.test(src);
  console.log(`${ok ? '✓' : '✗'} 导出 ${name}`);
  if (!ok) failed = true;
}

// TextLayer 构造参数形态：新版要求 textContentSource/container/viewport，且可能要求 images
const tlMatch = src.match(/class TextLayer[\s\S]{0,1200}?constructor\(\{([\s\S]{0,600}?)\}\)/);
if (tlMatch) {
  const params = tlMatch[1].replace(/\s+/g, ' ').trim();
  console.log(`TextLayer 构造参数: ${params}`);
  const needsImages = /\bimages\b/.test(params) && !/images\s*=\s*null/.test(params);
  console.log(
    needsImages
      ? '⚠ 该版本 TextLayer 构造需要 images 参数（传 null 即可，图像文字层可选）'
      : '✓ TextLayer 构造不需要 images 参数'
  );
} else {
  console.log('⚠ 未能解析 TextLayer 构造函数，请人工确认 build/pdf.mjs');
}

// worker / 资源目录
const workerCandidates = ['build/pdf.worker.min.mjs', 'build/pdf.worker.mjs', 'legacy/build/pdf.worker.min.mjs'];
const worker = workerCandidates.find((p) => existsSync(resolve(pkgDir, p)));
console.log(`${worker ? '✓' : '✗'} worker 文件: ${worker ?? workerCandidates.join(' | ')}`);
if (!worker) failed = true;

for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'web']) {
  const p = resolve(pkgDir, dir);
  if (existsSync(p)) {
    const n = readdirSync(p).length;
    console.log(`✓ 目录 ${dir}/ (${n} 项)`);
  } else {
    console.log(`- 目录 ${dir}/ 不存在（该版本可能不需要）`);
  }
}

if (failed) {
  console.error('\n✗ 探针失败：pdf.js 集成方式需要按上面的输出调整');
  process.exit(1);
}
console.log('\n✓ 探针通过：可使用 getDocument + TextLayer({textContentSource, container, viewport})');
