/**
 * store.js — Lưu trữ dữ liệu ứng dụng (notes.json trong thư mục userData).
 * Auto-save gộp (debounce), ghi file nguyên tử (temp + rename).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let filePath = null;
let state = null;
let saveTimer = null;

const DEFAULT_SETTINGS = {
  launchAtLogin: false,
  showFooter: true,
  defaultOpacity: 0.55,
  defaultFontFamily: 'Segoe UI',
  defaultFontSize: 16,
  defaultTextColor: '#ffffff',
};

/** Loại bỏ cấu trúc checkbox cũ (nếu có) trong HTML đã lưu. */
function sanitizeLegacyHtml(html) {
  return String(html || '').replace(/<div class="task"[^>]*>([\s\S]*?)<\/div>/g, (_m, inner) => {
    const innerClean = inner
      .replace(/<span class="cb"[^>]*><\/span>/g, '')
      .replace(/<div class="tx"[^>]*>([\s\S]*?)<\/div>/g, '$1');
    return '<p>' + innerClean + '</p>';
  });
}

function noteTemplate() {
  const now = Date.now();
  return {
    id: 'n' + now.toString(36) + Math.random().toString(36).slice(2, 7),
    title: 'Giấy nhớ',
    html: '',
    x: undefined, y: undefined,
    width: 340,
    height: 260,
    opacity: DEFAULT_SETTINGS.defaultOpacity,
    fontFamily: DEFAULT_SETTINGS.defaultFontFamily,
    fontSize: DEFAULT_SETTINGS.defaultFontSize,
    textColor: DEFAULT_SETTINGS.defaultTextColor,
    alwaysOnTop: false,
    createdAt: now,
    updatedAt: now,
  };
}

function welcomeNote() {
  const n = noteTemplate();
  n.title = 'Chào mừng 🌟';
  n.html =
    '<p style="font-size:1.35em;font-weight:700;margin:.1em 0 .25em">Sticky Glass</p>' +
    '<p>Tờ giấy nhớ trong suốt, dán thẳng lên desktop của bạn.</p>' +
    '<p>Bạn có thể kéo để di chuyển, kéo mép để đổi kích thước — chữ tự xuống dòng theo bề rộng.</p>' +
    '<p style="margin-top:.5em">Mẹo:</p>' +
    '<ul><li>Chọn dòng chữ → bấm nút <b>S̶</b> (hoặc chuột phải → Gạch ngang) để gạch việc đã làm xong</li>' +
    '<li>Nút <b>◐</b> để chỉnh độ trong suốt nền (đậm → mờ → trong suốt)</li>' +
    '<li>Nút <b>📌</b> để ghim luôn ở trên các cửa sổ khác</li>' +
    '<li>Nút <b>A+ / A−</b> để tăng giảm cỡ chữ nhanh</li>' +
    '<li>Menu <b>⋯</b> chứa chọn font chữ, tự khởi động cùng máy…</li>' +
    '<li>Biểu tượng khay hệ thống (cạnh đồng hồ) để quản lý giấy nhớ</li></ul>' +
    '<p><i>Chúc bạn ghi chú vui vẻ ✨</i></p>';
  return n;
}

function load() {
  if (state) return state;
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  filePath = path.join(dir, 'notes.json');
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const notes = Array.isArray(raw.notes) && raw.notes.length ? raw.notes : [];
    state = {
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
      notes: notes.map((n) => ({ ...n, html: sanitizeLegacyHtml(n.html) })),
    };
    if (!state.notes.length) {
      state.notes.push(welcomeNote());
    }
  } catch {
    state = { settings: { ...DEFAULT_SETTINGS }, notes: [welcomeNote()] };
  }

  // Loại bỏ hoàn toàn tính năng tự mở rộng (auto-grow) — không bao giờ để giấy tự phình.
  if (state.settings.autoGrow || !state.settings.settingsVersion || state.settings.settingsVersion < 3) {
    delete state.settings.autoGrow;
    state.settings.settingsVersion = 3;
    persist();
  }

  return state;
}

function persist() {
  if (!state) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (e) {
      console.error('store: lỗi ghi file', e);
    }
  }, 250);
}

function getSettings() {
  return load().settings;
}

function saveSettings(patch) {
  const s = load();
  Object.assign(s.settings, patch);
  persist();
  return s.settings;
}

function listNotes() {
  return load().notes.map((n) => ({
    id: n.id,
    title: n.title,
    updatedAt: n.updatedAt,
    excerpt: (n.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40),
  }));
}

function getNote(id) {
  const n = load().notes.find((x) => x.id === id);
  return n ? { ...n } : null;
}

/** patch: {html,title,opacity,fontFamily,fontSize,textColor,alwaysOnTop,width,height,x,y} */
function updateNote(id, patch) {
  const s = load();
  const n = s.notes.find((x) => x.id === id);
  if (!n) return null;
  Object.assign(n, patch, { updatedAt: Date.now() });
  persist();
  return { ...n };
}

function createNote() {
  const s = load();
  const n = noteTemplate();
  s.notes.push(n);
  persist();
  return { ...n };
}

function deleteNote(id) {
  const s = load();
  const idx = s.notes.findIndex((x) => x.id === id);
  if (idx === -1) return false;
  s.notes.splice(idx, 1);
  persist();
  return true;
}

module.exports = {
  DEFAULT_SETTINGS,
  load,
  getSettings,
  saveSettings,
  listNotes,
  getNote,
  updateNote,
  createNote,
  deleteNote,
};
