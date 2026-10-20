/**
 * make-icons.js — Sinh icon cho Sticky Glass (thuần Node, không thư viện ngoài).
 *  - build/icon.png  (1024x1024, dùng cho macOS / Linux)
 *  - build/icon.ico  (16..256, nhúng PNG, dùng cho Windows)
 * Chạy: npm run icons
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------- PNG encoder (đơn giản) ------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** rgba: Uint8Array (w*h*4). Trả về Buffer PNG. */
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // raw scanlines: mỗi dòng có filter byte 0
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------- Vẽ icon (canvas RGBA) ------------------------- */

function makeIconCanvas(size) {
  const buf = Buffer.alloc(size * size * 4);
  const S = size;
  const r = S * 0.21; // bo góc

  function insideRoundRect(x, y) {
    // trong hình chữ nhật bo góc bán kính r
    if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r * r;
    if (x > S - 1 - r && y < r) return (x - (S - 1 - r)) ** 2 + (y - r) ** 2 <= r * r;
    if (x < r && y > S - 1 - r) return (x - r) ** 2 + (y - (S - 1 - r)) ** 2 <= r * r;
    if (x > S - 1 - r && y > S - 1 - r) return (x - (S - 1 - r)) ** 2 + (y - (S - 1 - r)) ** 2 <= r * r;
    return x >= r && x <= S - 1 - r && y >= r && y <= S - 1 - r;
  }

  // phông nền trong suốt
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (!insideRoundRect(x, y)) continue;

      // gradient dọc: trắng sáng → xám nhẹ (kiểu kính sữa)
      const t = y / S;
      const shade = 1 - 0.22 * t;
      const A = 252;

      // cờ gấp góc phải-trên
      const fold = x > S * 0.78 && y < S * 0.22 && (x - S * 0.78) + (y - S * 0.22) > S * 0.22 * 0.5;

      if (fold) {
        const ft = ((x - S * 0.78) + (y - S * 0.22)) / (S * 0.22 * 0.5);
        buf[i] = Math.max(0, Math.round(235 - 70 * ft));
        buf[i + 1] = Math.max(0, Math.round(236 - 70 * ft));
        buf[i + 2] = Math.max(0, Math.round(242 - 70 * ft));
        buf[i + 3] = 255;
        continue;
      }

      // nét viền mảnh
      const edge = x < r + S * 0.012 || y < r + S * 0.012 || x > S - 1 - r - S * 0.012 || y > S - 1 - r - S * 0.012;
      if (edge && x >= r && y >= r && x <= S - 1 - r && y <= S - 1 - r) {
        buf[i] = 214; buf[i + 1] = 218; buf[i + 2] = 228; buf[i + 3] = 255;
        continue;
      }

      buf[i] = Math.round(252 * shade);
      buf[i + 1] = Math.round(252 * shade);
      buf[i + 2] = Math.round(254 * shade);
      buf[i + 3] = Math.round(A * (0.9 + 0.1 * t));
    }
  }

  // Các dòng chữ gợi ý
  const lineY = [0.42, 0.55, 0.68, 0.81];
  const lineH = Math.max(2, S * 0.028);
  const lineX0 = S * 0.22;
  const lineX1 = S * 0.78;
  for (let li = 0; li < lineY.length; li++) {
    if (li === 3) continue; // dòng cuối ngắn
    const y0 = Math.round(S * lineY[li]);
    const y1 = Math.min(S - 1, y0 + lineH);
    const xEnd = li === 2 ? Math.round(S * 0.62) : Math.round(lineX1);
    for (let y = y0; y <= y1; y++) {
      for (let x = Math.round(lineX0); x <= xEnd; x++) {
        const i = (y * S + x) * 4;
        if (!insideRoundRect(x, y)) continue;
        buf[i] = 150; buf[i + 1] = 156; buf[i + 2] = 175; buf[i + 3] = 255;
      }
    }
  }

  // hộp tích (checklist) góc trái-dưới
  const bx = S * 0.22, by = S * 0.79, bs = S * 0.09;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (!insideRoundRect(x, y)) continue;
      if (x >= bx && x <= bx + bs && y >= by && y <= by + bs) {
        buf[i] = 150; buf[i + 1] = 156; buf[i + 2] = 175; buf[i + 3] = 255;
      }
      // dấu tích
      const t1 = ((x - bx) / bs) * 2 - 1;
      const t2 = ((y - by) / bs) * 2 - 1;
      if (t2 > 0.05 && Math.abs(t2) < 0.16 && t1 > -0.7 && t1 < 0.7 && Math.abs(t1) < Math.abs(t2) * 1.25) {
        buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255;
      }
    }
  }

  return buf;
}

/* ------------------------- ICO encoder ------------------------- */

function makeICO(pngs) {
  // pngs: [{size, data:Buffer}]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(16 * pngs.length);
  let offset = 6 + entries.length;
  const bodies = [];
  pngs.forEach((p, i) => {
    const e = i * 16;
    entries[e] = p.size >= 256 ? 0 : p.size;
    entries[e + 1] = p.size >= 256 ? 0 : p.size;
    entries[e + 2] = 0; // palette
    entries[e + 3] = 0; // reserved
    entries.writeUInt16LE(1, e + 4); // planes
    entries.writeUInt16LE(32, e + 6); // bpp
    entries.writeUInt32LE(p.data.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    bodies.push(p.data);
    offset += p.data.length;
  });
  return Buffer.concat([header, entries, ...bodies]);
}

/* ------------------------- chạy ------------------------- */

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const big = makeIconCanvas(1024);
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePNG(1024, 1024, big));
console.log('✓ build/icon.png (1024x1024)');

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => ({ size: s, data: encodePNG(s, s, makeIconCanvas(s)) }));
fs.writeFileSync(path.join(outDir, 'icon.ico'), makeICO(pngs));
console.log('✓ build/icon.ico (' + sizes.join(',') + ')');
