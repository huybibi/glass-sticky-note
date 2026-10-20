/**
 * Sticky Glass — main process.
 * Cửa sổ trong suốt, không khung, không trên taskbar; khay hệ thống; tự khởi động cùng Windows.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, dialog, globalShortcut } = require('electron');

app.setName('Sticky Glass');

const store = require('./store');
const fonts = require('./fonts');

let mainWindows = new Map(); // id -> BrowserWindow
let tray = null;
let quitting = false;
let capturing = process.argv.includes('--capture');
let selftest = process.argv.includes('--selftest');

/* ------------------------------- selftest ------------------------------- */

// Chạy tự kiểm tra trong renderer rồi in kết quả và thoát (mã 0 = pass).
const SELF_TEST_SOURCE = `
(async () => {
  const out = [];
  const ok = (name, cond, info) => out.push({ name, ok: !!cond, info: info || '' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ui = window.__ui;

  // 1. Thanh công cụ chỉ còn: chấm đầu dòng, A±, màu, ◐, ⋯
  const banned = ['h1', 'h2', 'h3', 'bold', 'italic', 'underline', 'task', 'strikeThrough', 'insertOrderedList'];
  const missing = banned.every((c) => !document.querySelector('[data-cmd="' + c + '"]'));
  ok('toolbar-gọn-đúng-yêu-cầu', missing, banned.join(','));
  ok('còn-nút-danh-sách-chấm', !!document.querySelector('[data-cmd="insertUnorderedList"]'));

  // 2. Không còn ô tích cũ trong nội dung tải lên
  ok('không-còn-checkbox-trong-nội-dung', !document.querySelector('.task'));

  // 3. Cài đặt mặc định tắt auto-grow
  const settings = await window.sticky.getSettings();
  ok('autoGrow-mặc-định-tắt', settings.autoGrow === false);

  // 4. Nền đen (kênh RGB < 80)
  const noteEl = document.querySelector('.note');
  const bg = getComputedStyle(noteEl).backgroundColor;
  const m = bg.match(/\\d+/g);
  ok('nền-đen', m && m.slice(0, 3).every((v) => +v < 80), bg);

  // 5. Viền trắng đậm 100%
  const bd = getComputedStyle(noteEl).borderTopColor;
  ok('viền-trắng-100%', bd === 'rgb(255, 255, 255)', bd);

  // 6. Gõ chữ không làm khung phình to
  const editor = ui.editor;
  const h0 = window.innerHeight;
  editor.innerHTML = '';
  editor.focus();
  editor.textContent = 'Xin chào, đây là dòng chữ thử nghiệm để kiểm tra không phình khung.';
  editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await sleep(450);
  ok('gõ-chữ-không-phình-khung', Math.abs(window.innerHeight - h0) <= 2, h0 + ' -> ' + window.innerHeight);

  // 7. Gõ '1. ' không tạo danh sách số; ' ' ' vẫn tạo danh sách chấm
  editor.innerHTML = '';
  editor.focus();
  editor.textContent = '1.';
  editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: ' ', inputType: 'insertText' }));
  await sleep(80);
  ok('không-còn-danh-sách-số', !editor.querySelector('ol') && !editor.querySelector('li'));
  editor.innerHTML = '';
  editor.focus();
  editor.textContent = '*';
  editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: ' ', inputType: 'insertText' }));
  await sleep(80);
  ok('danh-sách-chấm-còn-hoạt-động', !!editor.querySelector('ul'));

  // 8. Enter không bị chặn (không có handler nào preventDefault)
  editor.innerHTML = '';
  editor.focus();
  let blocked = false;
  editor.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.defaultPrevented) blocked = true; }, { once: true });
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  ok('enter-không-bị-chặn', !blocked);

  // 9. Tiêu đề là div contenteditable (bấm đúng chữ mới sửa), thanh trên kéo được
  const titleEl = document.getElementById('titleInput');
  ok('tiêu-đ-là-contenteditable', titleEl && titleEl.isContentEditable === true);
  ok('thanh-trên-không-còn-app-region-drag', getComputedStyle(document.getElementById('grip')).webkitAppRegion !== 'drag' && getComputedStyle(document.getElementById('grip')).getPropertyValue('-webkit-app-region') !== 'drag');

  // 10. Góc bo 5px + thanh trên nằm trên tay cầm (kéo thả không đụng kích thước)
  const noteStyle = getComputedStyle(document.querySelector('.note'));
  const br = parseFloat(noteStyle.borderRadius);
  ok('góc-bo-5px', br <= 5, noteStyle.borderRadius);
  ok('thanh-kéo-trên-tay-cầm', parseInt(getComputedStyle(document.getElementById('grip')).zIndex, 10) >= 45);

  // 11. Thanh công cụ tự ẩn khi không soạn, hiện lại khi soạn
  const tb = document.getElementById('toolbar');
  editor.blur();
  await sleep(260);
  const hid = tb.classList.contains('collapsed');
  editor.focus();
  await sleep(80);
  const vis = !tb.classList.contains('collapsed');
  ok('toolbar-tự-ẩn/hiện', hid && vis, hid + '/' + vis);

  return out;
})()
`;

async function runSelfTest() {
  const win = [...mainWindows.values()][0];
  if (!win) { console.error('SELFTEST: không có cửa sổ'); quitting = true; app.exit(2); return; }
  try {
    await new Promise((r) => setTimeout(r, 1300));
    const results = await win.webContents.executeJavaScript(SELF_TEST_SOURCE);
    const failed = results.filter((r) => !r.ok);
    console.log('SELFTEST RESULT:');
    for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.info ? '  (' + r.info + ')' : ''}`);
    console.log(failed.length ? `SELFTEST: ${failed.length} LỖI` : 'SELFTEST: TẤT CẢ PASS');
    quitting = true;
    app.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.error('SELFTEST LỖI:', e);
    quitting = true;
    app.exit(3);
  }
}

/* ------------------------------- tray icon ------------------------------- */

function drawTrayImage() {
  const S = 32;
  const buf = Buffer.alloc(S * S * 4);
  const r = 7;
  const inside = (x, y) => {
    if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r * r;
    if (x > S - 1 - r && y < r) return (x - (S - 1 - r)) ** 2 + (y - r) ** 2 <= r * r;
    if (x < r && y > S - 1 - r) return (x - r) ** 2 + (y - (S - 1 - r)) ** 2 <= r * r;
    if (x > S - 1 - r && y > S - 1 - r) return (x - (S - 1 - r)) ** 2 + (y - (S - 1 - r)) ** 2 <= r * r;
    return x >= r && x <= S - 1 - r && y >= r && y <= S - 1 - r;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (!inside(x, y)) continue;
      const edge = x < r + 1 || y < r + 1 || x > S - 2 - r || y > S - 2 - r;
      const v = edge ? 235 : 250;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
    }
  }
  // dòng chữ
  for (let y = 8; y <= 24; y++) {
    for (let x = 8; x <= 22; x++) {
      const skip = (y >= 13 && y <= 16) || (y >= 20 && y <= 23);
      if (skip) continue;
      const i = (y * S + x) * 4;
      if (inside(x, y)) {
        buf[i] = 140; buf[i + 1] = 148; buf[i + 2] = 170; buf[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const notes = store.listNotes();
  const visibleIds = [...mainWindows.keys()].filter((id) => mainWindows.get(id).isVisible());

  const noteItems = notes.map((n) => ({
    label: (n.title || 'Giấy nhớ') + (visibleIds.includes(n.id) ? '  ✓' : ''),
    click: () => focusNote(n.id),
  }));

  const settings = store.getSettings();
  const menu = Menu.buildFromTemplate([
    { label: 'Hiện / ẩn tất cả', click: toggleAllComments },
    { label: 'Giấy nhớ mới', click: () => createNewNote() },
    { type: 'separator' },
    { label: 'Giấy nhớ', submenu: noteItems.length ? noteItems : [{ label: '(chưa có)', enabled: false }] },
    { type: 'separator' },
    {
      label: 'Tùy chọn',
      submenu: [
        {
          label: 'Tự khởi động cùng Windows',
          type: 'checkbox',
          checked: !!settings.launchAtLogin,
          click: (item) => setLaunchAtLogin(item.checked),
        },
        {
          label: 'Tự mở rộng khi viết kín',
          type: 'checkbox',
          checked: !!settings.autoGrow,
          click: (item) => store.saveSettings({ autoGrow: item.checked }),
        },
      ],
    },
    { type: 'separator' },
    { label: 'Thoát Sticky Glass', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function toggleAllComments() {
  const anyVisible = [...mainWindows.values()].some((w) => w.isVisible());
  for (const w of mainWindows.values()) {
    if (anyVisible) w.hide();
    else w.show();
  }
  if (!anyVisible && mainWindows.size) focusNote([...mainWindows.keys()][0]);
}

/* ----------------------------- cửa sổ ghi chú ----------------------------- */

function clampToWorkArea(note) {
  const wa = screen.getPrimaryDisplay().workArea;
  const all = screen.getAllDisplays().map((d) => d.workArea);
  let x = note.x, y = note.y, w = note.width || 340, h = note.height || 260;
  w = Math.min(Math.max(200, w), 1400);
  h = Math.min(Math.max(160, h), wa.height - 40);
  if (x === undefined || y === undefined) {
    const a = Math.random() * 0.4 + 0.15;
    const b = Math.random() * 0.4 + 0.15;
    x = Math.round(wa.x + wa.width * a);
    y = Math.round(wa.y + wa.height * b);
  }
  // giữ ít nhất một phần trong màn hình
  const anyOverlap = all.some((a) => x < a.x + a.width && x + w > a.x && y < a.y + a.height && y + h > a.y);
  if (!anyOverlap) {
    x = Math.round(wa.x + wa.width * 0.2);
    y = Math.round(wa.y + wa.height * 0.2);
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

function createNoteWindow(note) {
  if (mainWindows.has(note.id)) { focusNote(note.id); return mainWindows.get(note.id); }
  const b = clampToWorkArea(note);
  const win = new BrowserWindow({
    x: b.x, y: b.y,
    width: b.width, height: b.height,
    minWidth: 180, minHeight: 120,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: !!note.alwaysOnTop,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { id: note.id } });

  win.once('ready-to-show', () => {
    win.show();
    if (capturing) {
      setTimeout(() => captureDemo(win), 1500);
    }
  });

  // đóng → ẩn (giữ trạng thái), trừ khi đang thoát
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('moved', () => saveGeometry(win));
  win.on('resized', () => saveGeometry(win));

  mainWindows.set(note.id, win);
  win.on('closed', () => mainWindows.delete(note.id));
  rebuildTrayMenu();
  return win;
}

function saveGeometry(win) {
  if (!win || win.isDestroyed()) return;
  const id = win.webContents.getURL().match(/[?&]id=([^&]+)/)?.[1];
  if (!id) return;
  const [x, y] = win.getPosition();
  const [width, height] = win.getSize();
  store.updateNote(id, { x, y, width, height });
}

function focusNote(id) {
  const note = store.getNote(id);
  if (!note) return;
  let win = mainWindows.get(id);
  if (!win) win = createNoteWindow(note);
  // đưa về đúng vị trí đã lưu
  const b = clampToWorkArea(note);
  const [cx, cy] = win.getPosition();
  if (Math.abs(cx - b.x) > 2 || Math.abs(cy - b.y) > 2) win.setPosition(b.x, b.y);
  if (!win.isVisible()) win.show();
  win.setAlwaysOnTop(!!note.alwaysOnTop);
  win.focus();
  rebuildTrayMenu();
}

function createNewNote(opts) {
  const note = store.createNote();
  const win = createNoteWindow(note);
  if (opts?.focus !== false) focusNote(note.id);
  return { id: note.id };
}

function deleteNote(id) {
  const win = mainWindows.get(id);
  if (win) { mainWindows.delete(id); win.destroy(); }
  store.deleteNote(id);
  rebuildTrayMenu();
}

/* -------------------------------- auto-start ------------------------------ */

function setLaunchAtLogin(flag) {
  try {
    app.setLoginItemSettings({
      openAtLogin: flag,
      path: process.execPath,
      args: [],
    });
    store.saveSettings({ launchAtLogin: flag });
  } catch (e) {
    console.error('autostart lỗi', e);
  }
  rebuildTrayMenu();
}

/* ------------------------------- capture demo ----------------------------- */

async function captureDemo(win) {
  try {
    const img = await win.webContents.capturePage();
    const dir = path.join(process.cwd(), 'captures');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'demo.png'), img.toPNG());
    console.log('capture → captures/demo.png');
  } catch (e) {
    console.error('capture lỗi', e);
  }
  if (capturing) { quitting = true; app.quit(); }
}

/* --------------------------------- IPC ------------------------------------ */

function registerIpc() {
  ipcMain.on('note:create', (e, opts) => {
    const r = createNewNote(opts);
    e.sender.send('note:created', r);
  });

  ipcMain.on('note:delete', (e, id) => deleteNote(id));

  ipcMain.on('note:focus', (e, id) => focusNote(id));

  ipcMain.handle('note:get', (e, id) => store.getNote(id));
  ipcMain.handle('note:list', () => store.listNotes());

  ipcMain.handle('note:update', (e, id, patch) => store.updateNote(id, patch));

  ipcMain.on('win:move', (e, id, x, y) => {
    const win = mainWindows.get(id);
    if (win && !win.isDestroyed()) win.setPosition(Math.round(x), Math.round(y));
  });

  ipcMain.on('win:resize', (e, id, width, height) => {
    const win = mainWindows.get(id);
    if (win && !win.isDestroyed()) win.setSize(Math.max(180, Math.round(width)), Math.max(120, Math.round(height)));
  });

  ipcMain.on('win:setAlwaysOnTop', (e, id, flag) => {
    const win = mainWindows.get(id);
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!flag);
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (e, patch) => {
    const s = store.saveSettings(patch);
    rebuildTrayMenu();
    return s;
  });

  ipcMain.on('app:setLaunchAtLogin', (e, flag) => setLaunchAtLogin(flag));
  ipcMain.on('app:quit', () => { quitting = true; app.quit(); });

  ipcMain.handle('note:export', async (e, id) => {
    const note = store.getNote(id);
    if (!note) return { ok: false };
    const text = note.exportText || '';
    const res = await dialog.showSaveDialog({
      title: 'Xuất giấy nhớ',
      defaultPath: (note.title || 'giay-nho') + '.txt',
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, text, 'utf8');
    return { ok: true, path: res.filePath };
  });

  fonts.registerIpc();
}

/* --------------------------------- startup -------------------------------- */

const gotLock = selftest || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const first = [...mainWindows.values()][0];
    if (first) { first.show(); first.focus(); }
  });

  app.whenReady().then(() => {
    store.load();
    registerIpc();

    tray = new Tray(drawTrayImage());
    tray.setToolTip('Sticky Glass');
    tray.on('double-click', toggleAllComments);
    rebuildTrayMenu();

    Menu.setApplicationMenu(null);

    try {
      globalShortcut.register('CommandOrControl+Shift+N', toggleAllComments);
    } catch (e) { console.error('global shortcut lỗi', e); }

    // mở lại tất cả giấy nhớ đã có (và tạo note chào mừng nếu mới)
    const notes = store.listNotes();
    for (const n of notes) {
      const note = store.getNote(n.id);
      createNoteWindow(note);
    }
    if (!notes.length) createNewNote({ focus: true });

    // áp dụng tự khởi động đã lưu
    if (store.getSettings().launchAtLogin) setLaunchAtLogin(true);

    if (selftest) runSelfTest();
  });

  app.on('will-quit', () => {
    try { globalShortcut.unregisterAll(); } catch { /* noop */ }
  });

  app.on('window-all-closed', (e) => {
    // giữ ứng dụng chạy trong khay
    if (!quitting && mainWindows.size === 0) { /* không thoát */ }
  });
}
