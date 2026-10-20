#!/usr/bin/env node
/**
 * 生成扩展图标（PNG，Chrome 不支持 SVG 图标）。
 * 图形：用户确认的页灯书页与暖光标识，矢量几何同源生成。零依赖。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public/icons');
mkdirSync(outDir, { recursive: true });

const BG = [248, 247, 243];
// Geometry traced from the user-approved brand reference. One source for SVG and PNG.
function curve(a,b,c,d) { return Array.from({length:25},(_,i)=>{const t=i/24,q=1-t;return [q*q*q*a[0]+3*q*q*t*b[0]+3*q*t*t*c[0]+t*t*t*d[0],q*q*q*a[1]+3*q*q*t*b[1]+3*q*t*t*c[1]+t*t*t*d[1]];}); }
const shapes = [
 {points:[...curve([39,22],[56,24],[78,31],[91,44]),[91,124],...curve([91,124],[76,112],[57,105],[39,103])],color:[58,101,93]},
 {points:[[98,48],[142,21],[142,39],[98,66]],color:[204,215,200]},
 {points:[[98,69],[155,38],[155,57],[98,87]],color:[214,222,208]},
 {points:[[99,89],[179,51],[179,112]],color:[237,202,128],light:true},
 {points:[[98,94],[155,109],[98,123]],color:[58,101,93]},
];
function inside(x,y,points){let hit=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])hit=!hit;}return hit;}
const polygons=shapes.map(s=>`<polygon points="${s.points.map(p=>p.join(',')).join(' ')}" fill="${s.light?'url(#light)':`rgb(${s.color.join(',')})`}"/>`).join('');
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="28 -9.5 164 164"><defs><linearGradient id="light"><stop stop-color="#edca80"/><stop offset="1" stop-color="#faf7ed"/></linearGradient></defs>${polygons}</svg>`;
writeFileSync(resolve(outDir,'brand.svg'),svg);

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 返回该点的颜色（含 alpha），坐标归一化到 0..1 */
function sample(u, v) {
  // 圆角矩形背景
  const r = 0.22;
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  const distCorner = Math.hypot(dx, dy);
  if (distCorner > r) return [0, 0, 0, 0];

  const x=28+u*164,y=v*164-9.5;
  for(let i=shapes.length-1;i>=0;i--){const shape=shapes[i];if(inside(x,y,shape.points)){
    if(shape.light){const t=Math.max(0,Math.min(1,(x-99)/80));return [...shape.color.map((c,j)=>Math.round(c*(1-t)+[250,247,237][j]*t)),255];}
    return [...shape.color,255];
  }}
  return [...BG, 255];
}

function render(size) {
  const ss = 3; // 超采样
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [pr, pg, pb, pa] = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          const w = pa / 255;
          r += pr * w;
          g += pg * w;
          b += pb * w;
          a += pa;
        }
      }
      const n = ss * ss;
      const alpha = a / n;
      const i = (y * size + x) * 4;
      const denom = alpha > 0 ? a / 255 : 1;
      buf[i] = Math.round(r / denom);
      buf[i + 1] = Math.round(g / denom);
      buf[i + 2] = Math.round(b / denom);
      buf[i + 3] = Math.round(alpha);
    }
  }
  return encodePng(size, buf);
}

for (const size of [16, 32, 48, 128, 256]) {
  const png = render(size);
  writeFileSync(resolve(outDir, `${size}.png`), png);
  console.log(`✓ public/icons/${size}.png (${png.length}B)`);
}
