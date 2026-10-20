/**
 * fonts.js — Quản lý font chữ tùy chỉnh.
 * Người dùng tự cài font: chọn file .ttf/.otf/.woff2 qua hộp thoại,
 * ứng dụng copy vào <userData>/fonts rồi renderer nạp qua @font-face.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { app, dialog, ipcMain } = require('electron');

const FONT_EXTS = ['.ttf', '.otf', '.woff2', '.woff', '.ttc'];

function fontsDir() {
  const dir = path.join(app.getPath('userData'), 'fonts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Danh sách font tùy chỉnh đã cài: [{ family, file, size }] */
function listCustomFonts() {
  const dir = fontsDir();
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      const ext = path.extname(f).toLowerCase();
      if (!FONT_EXTS.includes(ext)) continue;
      const full = path.join(dir, f);
      const stem = path.basename(f, path.extname(f)).replace(/[_-]+/g, ' ');
      out.push({
        family: stem,
        file: full,
        size: fs.statSync(full).size,
      });
    }
  } catch (e) {
    console.error('fonts: lỗi liệt kê', e);
  }
  return out;
}

/** copy font vào thư mục fonts (đổi tên nếu trùng) */
function addFontFrom(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!FONT_EXTS.includes(ext)) return { ok: false, error: 'Chỉ hỗ trợ .ttf / .otf / .woff2 / .woff' };
  const stem = path.basename(filePath, path.extname(filePath)).replace(/[^\w\- ]+/g, '').trim() || 'custom';
  let target = path.join(fontsDir(), stem + ext);
  let i = 2;
  while (fs.existsSync(target)) target = path.join(fontsDir(), `${stem}-${i++}${ext}`);
  fs.copyFileSync(filePath, target);
  return { ok: true, family: path.basename(target, ext).replace(/[_-]+/g, ' '), file: target };
}

function registerIpc() {
  ipcMain.handle('font:list', () => listCustomFonts());

  ipcMain.handle('font:add', async (event) => {
    const win = event.sender;
    let parent = null;
    try { parent = win.getOwnerBrowserWindow?.() || null; } catch { parent = null; }
    const res = await dialog.showOpenDialog(parent || undefined, {
      title: 'Chọn file font (ttf / otf / woff2)',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Font files', extensions: ['ttf', 'otf', 'woff2', 'woff', 'ttc'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const added = [];
    for (const p of res.filePaths) {
      try {
        const r = addFontFrom(p);
        if (r.ok) added.push(r);
      } catch (e) {
        console.error('fonts: copy lỗi', p, e);
      }
    }
    return { ok: added.length > 0, added, canceled: false };
  });
}

module.exports = { registerIpc, listCustomFonts, fontsDir };
