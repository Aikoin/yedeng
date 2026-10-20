#!/usr/bin/env node
/**
 * 把 pdf.js 的运行时资源拷到 public/pdfjs/，Vite 会原样复制到 dist/。
 * 必须本地化：MV3 禁止远程代码，且 cmaps/standard_fonts 缺失会导致 CJK 缺字。
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = resolve(root, 'node_modules/pdfjs-dist');
const outDir = resolve(root, 'public/pdfjs');

if (!existsSync(pkgDir)) {
  console.error('✗ 未找到 node_modules/pdfjs-dist，请先执行 pnpm install');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const copied = [];

function copyFile(from, to) {
  const src = resolve(pkgDir, from);
  if (!existsSync(src)) return false;
  const dest = resolve(outDir, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  copied.push(`${to} (${(statSync(dest).size / 1024).toFixed(0)}KB)`);
  return true;
}

const worker = ['build/pdf.worker.min.mjs', 'build/pdf.worker.mjs'].find((p) =>
  existsSync(resolve(pkgDir, p))
);
if (!worker) {
  console.error('✗ 未找到 pdf.js worker 文件');
  process.exit(1);
}
copyFile(worker, 'pdf.worker.min.mjs');

for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs', 'image_decoders', 'web/images']) {
  const src = resolve(pkgDir, dir);
  if (existsSync(src)) {
    const target = dir === 'web/images' ? 'images' : dir;
    cpSync(src, resolve(outDir, target), { recursive: true });
    copied.push(`${target}/`);
  }
}

// pdf.js 官方查看器样式（文本层、注释层的 CSS）
const css = ['web/pdf_viewer.css', 'web/pdf_viewer.min.css'].find((p) => existsSync(resolve(pkgDir, p)));
if (css) copyFile(css, 'pdf_viewer.css');

console.log(`✓ pdfjs 资源已拷贝到 public/pdfjs/：\n  - ${copied.join('\n  - ')}`);

// Preserve third-party notices in redistributed extension packages.
for (const name of ['LICENSE', 'NOTICE']) copyFile(name, name);
const licenseDir = resolve(root, 'public/third-party');
mkdirSync(licenseDir, { recursive: true });
for (const name of ['LICENSE', 'LICENSE.txt']) {
  const katexLicense = resolve(root, 'node_modules/katex', name);
  if (existsSync(katexLicense)) cpSync(katexLicense, resolve(licenseDir, 'katex-LICENSE.txt'));
}
