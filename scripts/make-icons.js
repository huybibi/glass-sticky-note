/**
 * make-icons.js — Sinh icon giấy nhớ cho Sticky Glass (thuần Node, không thư viện ngoài).
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

/** rgba: Buffer (w*h*4). Trả về Buffer PNG. */
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

function inRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.max(x0 + r, Math.min(px, x1 - r));
  const cy = Math.max(y0 + r, Math.min(py, y1 - r));
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Box blur 1 chiều tách ngang + dọc, dùng cho bóng đổ.
function boxBlur(src, S, r) {
  const tmp = new Float32Array(S * S);
  const dst = new Float32Array(S * S);
  const win = r * 2 + 1;
  const at = (x, y) => src[y * S + x];
  for (let y = 0; y < S; y++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += at(clamp(k, 0, S - 1), y);
    for (let x = 0; x < S; x++) {
      tmp[y * S + x] = sum / win;
      sum -= at(clamp(x - r, 0, S - 1), y);
      sum += at(clamp(x + r + 1, 0, S - 1), y);
    }
  }
  for (let x = 0; x < S; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[clamp(k, 0, S - 1) * S + x];
    for (let y = 0; y < S; y++) {
      dst[y * S + x] = sum / win;
      sum -= tmp[clamp(y - r, 0, S - 1) * S + x];
      sum += tmp[clamp(y + r + 1, 0, S - 1) * S + x];
    }
  }
  return dst;
}

// Downsample vùng (area average, alpha nhân trước) → cạnh mượt ở mọi kích thước.
function downsample(master, S, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = S / size;
  for (let oy = 0; oy < size; oy++) {
    const sy0 = Math.floor(oy * scale);
    const sy1 = Math.min(S, Math.max(sy0 + 1, Math.floor((oy + 1) * scale)));
    for (let ox = 0; ox < size; ox++) {
      const sx0 = Math.floor(ox * scale);
      const sx1 = Math.min(S, Math.max(sx0 + 1, Math.floor((ox + 1) * scale)));
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let i = (sy * S + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, i += 4) {
          const a = master[i + 3] / 255;
          sr += master[i] * a;
          sg += master[i + 1] * a;
          sb += master[i + 2] * a;
          sa += a;
          n++;
        }
      }
      const o = (oy * size + ox) * 4;
      if (sa > 0.0001) {
        out[o] = Math.round(sr / sa);
        out[o + 1] = Math.round(sg / sa);
        out[o + 2] = Math.round(sb / sa);
        out[o + 3] = Math.round((sa / n) * 255);
      }
    }
  }
  return out;
}

/**
 * Vẽ icon giấy nhớ ở độ phân giải gốc (supersample rồi downscale):
 * tờ giấy vàng, góc dưới-phải gấp lên, vài dòng chữ, viền mảnh, bóng mềm.
 */
function makeMaster(S) {
  const buf = Buffer.alloc(S * S * 4);

  // hình học tờ giấy
  const x0 = S * 0.080, y0 = S * 0.075;
  const x1 = S * 0.920, y1 = S * 0.915;
  const r = S * 0.045;
  const bw = Math.max(1, S * 0.0075);
  const fold = S * 0.24;
  const crease = Math.max(1, S * 0.008);

  // màu
  const topCol = [255, 234, 164];
  const bottomCol = [255, 190, 45];
  const edgeCol = [235, 170, 38];
  const foldCol = [255, 246, 207];
  const foldCol2 = [255, 228, 154];
  const creaseCol = [206, 140, 20];
  const lineCol = [146, 94, 20];

  // bóng: silhouette lệch xuống, làm mờ 2 lượt
  const mask = new Float32Array(S * S);
  const dy = S * 0.028;
  const spread = S * 0.004;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (inRoundRect(x + 0.5, y + 0.5 - dy, x0 - spread, y0 - spread, x1 + spread, y1 + spread, r + spread)) {
        mask[y * S + x] = 1;
      }
    }
  }
  const blurR = Math.max(2, Math.round(S * 0.016));
  const shadow = boxBlur(boxBlur(mask, S, blurR), S, blurR);

  const lineH = S * 0.046;
  const lineR = lineH / 2;
  const lines = [
    { y: S * 0.315, xa: S * 0.215, xb: S * 0.715 },
    { y: S * 0.455, xa: S * 0.215, xb: S * 0.655 },
    { y: S * 0.595, xa: S * 0.215, xb: S * 0.560 },
  ];

  for (let y = 0; y < S; y++) {
    const py = y + 0.5;
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const i = (y * S + x) * 4;

      // nền bóng mềm (chỉ hiện ra ngoài tờ giấy)
      const sa = shadow[y * S + x];
      if (sa > 0.002) {
        buf[i] = 70; buf[i + 1] = 40; buf[i + 2] = 8;
        buf[i + 3] = Math.round(clamp(sa * 0.34, 0, 1) * 255);
      }

      if (!inRoundRect(px, py, x0, y0, x1, y1, r)) continue;

      // viền ngoài
      const innerR = Math.max(0, r - bw);
      if (!inRoundRect(px, py, x0 + bw, y0 + bw, x1 - bw, y1 - bw, innerR)) {
        buf[i] = edgeCol[0]; buf[i + 1] = edgeCol[1]; buf[i + 2] = edgeCol[2]; buf[i + 3] = 255;
        continue;
      }

      // gradient vàng nhẹ theo chiều dọc + ngang
      const tv = clamp((py - y0) / (y1 - y0), 0, 1);
      const th = clamp((px - x0) / (x1 - x0), 0, 1);
      const g = clamp(tv * 0.72 + th * 0.28, 0, 1);
      let col = mix(topCol, bottomCol, g);

      // góc gấp: tam giác phía góc dưới-phải
      const u = (px - (x1 - fold)) + (py - (y1 - fold));
      if (u > fold) {
        const ft = clamp((u - fold) / fold, 0, 1);
        col = mix(foldCol, foldCol2, ft);
      }
      // nếp gấp
      if (u >= fold && u <= fold + crease) col = creaseCol;

      // các dòng chữ
      for (let li = 0; li < lines.length; li++) {
        const ln = lines[li];
        if (inRoundRect(px, py, ln.xa, ln.y, ln.xb, ln.y + lineH, lineR)) {
          col = lineCol;
          break;
        }
      }

      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = 255;
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

const MASTER = 2048;
const master = makeMaster(MASTER);

const big = downsample(master, MASTER, 1024);
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePNG(1024, 1024, big));
console.log('✓ build/icon.png (1024x1024)');

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => ({ size: s, data: encodePNG(s, s, downsample(master, MASTER, s)) }));
fs.writeFileSync(path.join(outDir, 'icon.ico'), makeICO(pngs));
console.log('✓ build/icon.ico (' + sizes.join(',') + ')');
