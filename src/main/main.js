/**
 * Sticky Glass — main process.
 * Cửa sổ trong suốt, không khung, không trên taskbar; khay hệ thống; tự khởi động cùng Windows.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, dialog, globalShortcut } = require('electron');

app.setName('Sticky Glass');

const store = require('./store');
const fonts = require('./fonts');

let mainWindows = new Map(); // id -> BrowserWindow
let tray = null;
let quitting = false;
let capturing = process.argv.includes('--capture');
let selftest = process.argv.includes('--selftest');
let suppressGeoSave = false; // tạm lờ lưu kích thước khi mở rộng cho dropdown

// Test chạy trên profile riêng để không đọc/ghi notes.json thật của người dùng.
if (selftest) {
  const testProfile = path.join(os.tmpdir(), 'sticky-glass-selftest');
  try { fs.rmSync(testProfile, { recursive: true, force: true }); } catch { /* noop */ }
  fs.mkdirSync(testProfile, { recursive: true });
  app.setPath('userData', testProfile);
}

/* ------------------------------- screenshots ------------------------------- */

// Chụp vài ảnh demo phục vụ mô tả README/GitHub.
async function captureScreenshots(win) {
  const dir = path.join(process.cwd(), 'captures');
  fs.mkdirSync(dir, { recursive: true });
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
    console.log('capture → captures/' + name + '.png');
  };

  await new Promise((r) => setTimeout(r, 700));
  await shot('demo');

  // mở menu tùy chọn (⋯)
  try {
    await win.webContents.executeJavaScript(`document.querySelector('.pop-toggle[data-pop="morePop"]').click(); true;`);
    await new Promise((r) => setTimeout(r, 350));
    await shot('dropdown');
    await win.webContents.executeJavaScript(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true;`);
    await new Promise((r) => setTimeout(r, 250));
  } catch (e) { console.error('capture dropdown lỗi', e); }

  // mở danh sách giấy nhớ (📄)
  try {
    await win.webContents.executeJavaScript(`document.getElementById('btnNotes').click(); true;`);
    await new Promise((r) => setTimeout(r, 350));
    await shot('notes');
    await win.webContents.executeJavaScript(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true;`);
    await new Promise((r) => setTimeout(r, 200));
  } catch (e) { console.error('capture notes lỗi', e); }

  if (capturing) { quitting = true; app.exit(0); }
}

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

  // 3. Không còn bất kỳ cơ chế tự phình nào (ông tùy chọn + hàm đã bỏ)
  ok('không-còn-ô-tự-phình', !document.getElementById('optAutoGrow') && typeof window.__ui.autoGrow === 'undefined');

  // 4. Nền đen (kênh RGB < 80) nằm ở lớp ::before bên trong viền
  const noteEl = document.querySelector('.note');
  const noteStyle = getComputedStyle(noteEl);
  const surfaceStyle = getComputedStyle(noteEl, '::before');
  const bg = surfaceStyle.backgroundColor;
  const m = bg.match(/\\d+/g);
  ok('nền-đen', m && m.slice(0, 3).every((v) => +v < 80), bg);

  // 5. Viền trắng đậm 100%
  const bd = getComputedStyle(noteEl).borderTopColor;
  ok('viền-trắng-100%', bd === 'rgb(255, 255, 255)', bd);

  // 5b. Nền tối chỉ vẽ trong lòng viền, không dùng shadow tràn ra ngoài
  {
    const innerR = parseFloat(surfaceStyle.borderTopLeftRadius);
    const outerR = parseFloat(noteStyle.borderTopLeftRadius);
    const noteBg = noteStyle.backgroundColor;
    const noOuterShadow = noteStyle.boxShadow === 'none';
    ok('nền-nằm-trong-viền', noteBg === 'rgba(0, 0, 0, 0)' && noOuterShadow && innerR < outerR,
      noteBg + ' / ' + noteStyle.boxShadow + ' / ' + innerR + '<' + outerR);
  }

  // 6. Gõ nhiều chữ (dài hơn giấy) không làm khung phình to — cả chiều rộng lẫn chiều cao
  const editor = ui.editor;
  const w0 = window.innerWidth, h0 = window.innerHeight;
  editor.innerHTML = '';
  editor.focus();
  let longText = '';
  for (let i = 0; i < 60; i++) longText += 'Dòng chữ thử nghiệm thứ ' + i + '. Xin chào Sticky Glass! ';
  editor.textContent = longText;
  editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await sleep(500);
  const grew = Math.abs(window.innerWidth - w0) > 2 || Math.abs(window.innerHeight - h0) > 2;
  ok('gõ-chữ-không-phình-khung', !grew, w0 + 'x' + h0 + ' -> ' + window.innerWidth + 'x' + window.innerHeight);

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

  // 10. Góc bo 5px + thanh trên nằm trên tay cầm (kéo thả không đụng kích thước)
  const br = parseFloat(noteStyle.borderRadius);
  ok('góc-bo-5px', br <= 5, noteStyle.borderRadius);
  ok('thanh-kéo-trên-tay-cầm', parseInt(getComputedStyle(document.getElementById('grip')).zIndex, 10) >= 45);

  // 11. Thanh công cụ: ẩn lúc đầu; hiện khi tương tác; tự ẩn lại sau khi dừng
  const tb = document.getElementById('toolbar');
  await sleep(1700); // đợi trạng thái ẩn (nếu test trước để lại tương tác)
  const startHidden = tb.classList.contains('collapsed');
  editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await sleep(80);
  const showAfterEdit = !tb.classList.contains('collapsed');
  await sleep(1800);
  const hideAfterIdle = tb.classList.contains('collapsed');
  ok('toolbar-tự-ẩn/hiện', startHidden && showAfterEdit && hideAfterIdle, startHidden + '/' + showAfterEdit + '/' + hideAfterIdle);

  // 12. Tờ giấy nằm lùi vào trong cửa sổ (viền không bị mép cắt)
  const r = document.querySelector('.note').getBoundingClientRect();
  ok('viền-nằm-trong-cửa-sổ',
    r.left >= 0.5 && r.top >= 0.5 && r.bottom <= window.innerHeight - 0.5 && r.right <= window.innerWidth - 0.5,
    r.left + ',' + r.top + ',' + r.bottom + ',' + r.right);

  // 13. Kéo thả dùng cơ chế OS (app-region drag) — không còn tự gọi setPosition thủ công,
  //     nên không bao giờ đụng đến kích thước.
  {
    const gripStyle = getComputedStyle(document.getElementById('grip'));
    const titleStyle = getComputedStyle(document.getElementById('titleInput'));
    const nativeDrag = gripStyle.getPropertyValue('-webkit-app-region') === 'drag';
    const noDragTitle = titleStyle.getPropertyValue('-webkit-app-region') === 'no-drag';
    ok('kéo-thả-OS-không-đổi-kích-thước', nativeDrag && noDragTitle, nativeDrag + '/' + noDragTitle);
  }

  // 14. Nút 📄 📌 nằm ngoài vùng kéo (no-drag) để bấm được, và bấm 📄 mở danh sách giấy nhớ
  {
    const ghostNoDrag = [...document.querySelectorAll('.ghost')]
      .every((b) => getComputedStyle(b).getPropertyValue('-webkit-app-region') === 'no-drag');
    ok('nút-thanh-trên-bấm-được', ghostNoDrag);
    document.getElementById('btnNotes').click();
    await sleep(200);
    const opened = document.getElementById('notesPop').classList.contains('open');
    ok('nút-📄-mở-danh-sách-giấy-nhớ', opened);
    document.getElementById('btnNotes').click(); // đóng lại
    await sleep(120);
  }

  // 15. Tiêu đề canh trái; 2 icon tách khỏi chữ và luôn sát mép phải;
  //     tiêu đề quá dài thì cắt bớt ở bên phải, không đè lên icon.
  {
    const title = document.getElementById('titleInput');
    const pin = document.getElementById('btnPin');
    const nr = noteEl.getBoundingClientRect();
    const pr = pin.getBoundingClientRect();
    const tr = title.getBoundingClientRect();
    const iconsAtRight = nr.right - pr.right <= 6;
    const titleAtLeft = tr.left - nr.left <= 13;
    ok('tiêu-đề-trái-icon-phải', iconsAtRight && titleAtLeft,
      'iconRight=' + (nr.right - pr.right).toFixed(1) + ' titleLeft=' + (tr.left - nr.left).toFixed(1));

    const oldTitle = title.textContent;
    title.textContent = 'Một tiêu đề rất dài để kiểm tra phần chữ bị cắt ở bên phải ' + 'nội dung '.repeat(20);
    const sw = title.scrollWidth, cw = title.clientWidth;
    const tr2 = title.getBoundingClientRect();
    const pr2 = pin.getBoundingClientRect();
    const clipped = sw > cw + 1;
    const noOverlap = tr2.right <= pr2.left - 2;
    const stillRight = nr.right - pr2.right <= 6;

    // Đang sửa và đặt caret ở cuối: phần đầu vẫn phải hiển thị, phần cuối bị cắt.
    title.focus();
    const caret = document.createRange();
    caret.selectNodeContents(title);
    caret.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(caret);
    title.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await sleep(80);
    const firstChar = document.createRange();
    firstChar.setStart(title.firstChild, 0);
    firstChar.setEnd(title.firstChild, 1);
    const fcr = firstChar.getBoundingClientRect();
    const startVisible = title.scrollLeft <= 1 && fcr.left >= tr2.left - 1 && fcr.left < tr2.right;
    const scrollLeft = title.scrollLeft;
    title.blur();
    title.textContent = oldTitle;

    ok('tiêu-đề-dài-cắt-bên-phải', clipped && noOverlap && stillRight,
      'scroll/client=' + sw + '/' + cw + ' titleRight=' + tr2.right.toFixed(1) + ' iconLeft=' + pr2.left.toFixed(1));
    ok('tiêu-đề-luôn-hiện-phần-đầu', startVisible,
      'scrollLeft=' + scrollLeft + ' firstCharLeft=' + fcr.left.toFixed(1) + ' titleLeft=' + tr2.left.toFixed(1));
  }

  // 16. Menu 3 chấm tràn ra ngoài giấy khi giấy ngắn — không dùng thanh cuộn
  {
    const noteId = new URLSearchParams(location.search).get('id');
    const origW = window.innerWidth, origH = window.innerHeight;
    // thu nhỏ cửa sổ để giấy ngắn hơn menu
    await window.sticky.resizeWindow(noteId, 220, 170);
    await sleep(300);
    const noteBottom = document.querySelector('.note').getBoundingClientRect().bottom;
    const moreBtn = document.querySelector('.pop-toggle[data-pop="morePop"]');
    moreBtn.click();
    await sleep(700);
    const mp = document.getElementById('morePop');
    const mr = mp.getBoundingClientRect();
    const noScroll = mp.scrollHeight <= mp.clientHeight + 1;
    const visible = mr.top >= 2 && mr.bottom <= window.innerHeight - 2;
    const spills = mr.bottom > noteBottom - 1;
    ok('menu-tràn-ra-ngoài-giấy-không-cuộn', mp.classList.contains('open') && visible && spills && noScroll,
      'bottom=' + mr.bottom + ' noteBottom=' + noteBottom + ' h=' + window.innerHeight + ' scroll=' + mp.scrollHeight + '/' + mp.clientHeight);
    // đóng menu rồi trả về kích thước ban đầu
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await sleep(250);
    await window.sticky.resizeWindow(noteId, origW, origH);
    await sleep(250);
    await window.sticky.updateNote(noteId, { width: origW, height: origH });
    await sleep(150);
  }

  return out;
})()
`;

async function runSelfTest() {
  const win = [...mainWindows.values()][0];
  if (!win) { console.error('SELFTEST: không có cửa sổ'); quitting = true; app.exit(2); return; }
  try {
    await new Promise((r) => setTimeout(r, 1300));
    const results = await win.webContents.executeJavaScript(SELF_TEST_SOURCE);

    // kiểm tra bằng pixel: viền trắng phải hiển thị ở cả mép trên và dưới
    try {
      const img = await win.webContents.capturePage();
      const bmp = img.toBitmap();
      const { width: W, height: H } = img.getSize();
      const physW = Math.round(Math.sqrt((bmp.length / 4) * (W / H)));
      const physH = Math.round(bmp.length / 4 / physW);
      const midX = Math.floor(physW / 2);
      const isWhite = (x, y) => {
        const i = (y * physW + x) * 4;
        return bmp[i] >= 245 && bmp[i + 1] >= 245 && bmp[i + 2] >= 245;
      };
      let topHas = false, bottomHas = false;
      for (let y = 0; y < Math.min(14, physH); y++) if (isWhite(midX, y)) topHas = true;
      for (let y = Math.max(0, physH - 14); y < physH; y++) if (isWhite(midX, y)) bottomHas = true;
      results.push({ name: 'viền-trắng-hiển-thị-cả-trên-dưới', ok: topHas && bottomHas, info: `top=${topHas} bottom=${bottomHas} phys=${physW}x${physH}` });

      // vùng đệm ngoài viền trắng phải trong suốt hoàn toàn (không còn bóng đen thò ra)
      const alphaAt = (x, y) => bmp[(y * physW + x) * 4 + 3];
      const midY = Math.floor(physH / 2);
      const outside = [
        [0, midY], [physW - 1, midY], [midX, 0], [midX, physH - 1],
        [0, 0], [physW - 1, 0], [0, physH - 1], [physW - 1, physH - 1],
      ];
      const notClear = outside.filter(([x, y]) => alphaAt(x, y) > 8);
      results.push({
        name: 'không-có-nền-tối-ngoài-viền',
        ok: notClear.length === 0,
        info: 'alpha=' + outside.slice(0, 4).map(([x, y]) => alphaAt(x, y)).join(',') + ' outside=' + JSON.stringify(notClear.slice(0, 3)),
      });

      // lớp nền tối bên trong viền vẫn phải hiển thị (không bị pseudo-element nuốt mất)
      const inX = midX, inY = Math.floor(physH * 0.7);
      const inI = (inY * physW + inX) * 4;
      const innerAlpha = bmp[inI + 3];
      const innerDark = bmp[inI] < 80 && bmp[inI + 1] < 80 && bmp[inI + 2] < 80;
      results.push({
        name: 'nền-tối-hiển-thị-bên-trong-viền',
        ok: innerAlpha > 100 && innerDark,
        info: 'alpha=' + innerAlpha + ' rgb=' + bmp[inI + 2] + ',' + bmp[inI + 1] + ',' + bmp[inI],
      });
    } catch (e) {
      results.push({ name: 'viền-trắng-pixel', ok: false, info: String(e) });
    }

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
    maximizable: false,   // bấm đúp vào thanh kéo không phóng to
    fullscreenable: false,
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
      setTimeout(() => captureScreenshots(win), 1200);
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
  if (suppressGeoSave) return; // bỏ qua khi tạm mở rộng/khôi phục cho dropdown
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

  // Tạm thời mở rộng cửa sổ để menu dropdown tràn ra ngoài giấy
  ipcMain.handle('win:expandForPop', (e, id, d) => {
    const win = mainWindows.get(id);
    if (!win || win.isDestroyed()) return { ok: false };
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    const left = d.left || 0, right = d.right || 0, top = d.top || 0, bottom = d.bottom || 0;
    suppressGeoSave = true;
    win.setBounds({
      x: Math.round(x - left),
      y: Math.round(y - top),
      width: Math.max(180, Math.round(w + left + right)),
      height: Math.max(120, Math.round(h + top + bottom)),
    });
    setTimeout(() => { suppressGeoSave = false; }, 600);
    return { ok: true };
  });

  ipcMain.handle('win:restoreNoteBounds', (e, id) => {
    const note = store.getNote(id);
    const win = mainWindows.get(id);
    if (!note || !win || win.isDestroyed()) return { ok: false };
    suppressGeoSave = true;
    win.setBounds({
      x: Math.round(note.x ?? win.getPosition()[0]),
      y: Math.round(note.y ?? win.getPosition()[1]),
      width: Math.max(180, Math.round(note.width ?? 280)),
      height: Math.max(120, Math.round(note.height ?? 260)),
    });
    setTimeout(() => { suppressGeoSave = false; }, 600);
    return { ok: true };
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
