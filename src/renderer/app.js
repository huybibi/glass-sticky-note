/**
 * Sticky Glass — renderer logic.
 * Soạn thảo rich-text (contenteditable), checklist, auto-grow, kéo chỉnh kích thước.
 */
'use strict';

(() => {
  const api = window.sticky;
  const id = api.noteId();

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const noteEl = $('#note');
  const editor = $('#editor');
  const titleInput = $('#titleInput');
  const footerEl = $('#footer');
  const taskCounter = $('#taskCounter');
  const wordCounter = $('#wordCounter');
  const fontSelect = $('#fontSelect');
  const colorInput = $('#colorInput');
  const opacityRange = $('#opacityRange');

  let note = null;
  let settings = null;
  let saveTimer = null;

  const SYSTEM_FONTS = [
    { label: 'Segoe UI (mặc định)', value: '"Segoe UI", system-ui, sans-serif' },
    { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
    { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
    { label: 'Georgia', value: 'Georgia, serif' },
    { label: 'Courier New', value: '"Courier New", monospace' },
    { label: 'Consolas', value: 'Consolas, monospace' },
    { label: 'Tahoma', value: 'Tahoma, Verdana, sans-serif' },
    { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
    { label: 'Trebuchet MS', value: '"Trebuchet MS", sans-serif' },
    { label: 'Comic Sans MS', value: '"Comic Sans MS", cursive' },
  ];

  /* ========================= khởi tạo ========================= */

  function applyNoteStyle() {
    const r = document.documentElement.style;
    r.setProperty('--alpha', String(note.opacity ?? 0.55));
    r.setProperty('--fs', (note.fontSize || 16) + 'px');
    r.setProperty('--ff', note.fontFamily || '"Segoe UI", system-ui, sans-serif');
    r.setProperty('--tc', note.textColor || '#ffffff');
    opacityRange.value = Math.round((note.opacity ?? 0.55) * 100);
    colorInput.value = note.textColor || '#ffffff';
    titleInput.textContent = note.title || '';
    editor.innerHTML = note.html || '';
    $('#btnPin').classList.toggle('active', !!note.alwaysOnTop);
    footerEl.style.display = settings.showFooter ? '' : 'none';
    editor.classList.add('scrollable');
  }

  async function init() {
    settings = await api.getSettings();
    note = await api.getNote(id);
    if (!note) return;

    applyNoteStyle();
    await loadFonts();
    fillNotesList();

    bindEvents();
    syncToolbar();
    scheduleSave();
    updateCounters();
  }

  /* ========================= font ========================= */

  function injectCustomFonts(custom) {
    const style = document.createElement('style');
    style.id = 'custom-fonts';
    let css = '';
    for (const f of custom) {
      const url = 'file:///' + f.file.replace(/\\/g, '/').replace(/#/g, '%23').replace(/\s/g, '%20');
      css += `@font-face{font-family:"${f.family}";src:url("${url}") format("truetype");}\n`;
    }
    style.textContent = css;
    const old = $('#custom-fonts');
    if (old) old.remove();
    document.head.appendChild(style);
  }

  async function loadFonts() {
    const custom = await api.listCustomFonts();
    injectCustomFonts(custom);
    fontSelect.innerHTML = '';
    for (const f of SYSTEM_FONTS) {
      const o = document.createElement('option');
      o.value = f.value; o.textContent = f.label;
      fontSelect.appendChild(o);
    }
    if (custom.length) {
      const og = document.createElement('optgroup');
      og.label = 'Font tự cài';
      for (const f of custom) {
        const o = document.createElement('option');
        o.value = `"${f.family}", sans-serif`;
        o.textContent = f.family;
        og.appendChild(o);
      }
      fontSelect.appendChild(og);
    }
    // chọn font đang dùng
    const cur = note.fontFamily || '';
    const match = [...fontSelect.options].find((o) => o.value === cur);
    if (match) fontSelect.value = match.value;
    else if (custom.some((f) => `"${f.family}", sans-serif` === cur)) fontSelect.value = cur;
  }

  /* ========================= lệnh soạn thảo ========================= */

  function exec(cmd, val) {
    document.execCommand(cmd, false, val);
  }

  function runCommand(cmd) {
    switch (cmd) {
      case 'insertUnorderedList': exec('insertUnorderedList'); break;
      case 'font-size-inc': changeFontSize(+1); break;
      case 'font-size-dec': changeFontSize(-1); break;
    }
  }

  function changeFontSize(delta) {
    const next = Math.min(40, Math.max(10, (note.fontSize || 16) + delta));
    note.fontSize = next;
    document.documentElement.style.setProperty('--fs', next + 'px');
    onChange();
  }

  function setFontFamily(value) {
    note.fontFamily = value;
    document.documentElement.style.setProperty('--ff', value);
    onChange();
  }

  function setTextColor(value) {
    note.textColor = value;
    document.documentElement.style.setProperty('--tc', value);
    exec('foreColor', value);
    onChange();
  }

  function setOpacity(value) {
    note.opacity = value;
    document.documentElement.style.setProperty('--alpha', String(value));
    opacityRange.value = Math.round(value * 100);
    $$('.opacity-chips button').forEach((b) => b.classList.toggle('active', Math.abs(+b.dataset.op - value) < 0.001));
    onChange();
  }

  /* ========================= markdown nhanh ========================= */

  function currentBlock() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const node = sel.anchorNode;
    const el = node.nodeType === 3 ? node.parentElement : node;
    return el && el.closest ? (el.closest('p, div, li, h1, h2, h3') || el) : el;
  }

  function handleSpaceBeforeInput(e) {
    if (e.inputType !== 'insertText' || e.data !== ' ') return;
    const block = currentBlock();
    if (!block) return;
    const text = block.textContent;

    if (text === '-' || text === '*') {
      e.preventDefault();
      block.innerHTML = '';
      exec('insertUnorderedList');
    }
  }

  function placeCaretAtEnd(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /* ========================= đếm ========================= */

  function updateCounters() {
    const text = editor.innerText;
    const words = (text.trim().match(/\S+/g) || []).length;
    const chars = text.replace(/\n/g, '').length;
    wordCounter.textContent = `${words} từ · ${chars} ký tự`;
    taskCounter.textContent = '';
  }

  /* ========================= lưu ========================= */

  function onChange() {
    updateCounters();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(scheduleSave, 300);
  }

  function scheduleSave() {
    api.updateNote(id, {
      html: editor.innerHTML,
      title: titleInput.textContent.trim() || 'Giấy nhớ',
      opacity: note.opacity,
      fontFamily: note.fontFamily,
      fontSize: note.fontSize,
      textColor: note.textColor,
      alwaysOnTop: note.alwaysOnTop,
    });
  }

  /* ========================= tiêu đề ========================= */

  // Giữ tiêu đề luôn hiển thị từ đầu; phần dư bị cắt ở bên phải.
  function keepTitleStart() {
    if (titleInput.scrollLeft !== 0) titleInput.scrollLeft = 0;
  }

  /* ========================= danh sách giấy nhớ ========================= */

  async function fillNotesList() {
    const notes = await api.listNotes();
    const box = $('#notesList');
    box.innerHTML = '';
    for (const n of notes) {
      const b = document.createElement('button');
      b.className = 'note-item' + (n.id === id ? ' active' : '');
      b.innerHTML = `<span class="t">${escapeHtml(n.title)}</span><span class="e">${escapeHtml(n.excerpt || '')}</span>`;
      b.addEventListener('click', () => api.focusNote(n.id));
      box.appendChild(b);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ========================= popover ========================= */

  function anchorForPop(name) {
    if (name === 'notesPop') return $('#btnNotes');
    return document.querySelector('.pop-toggle[data-pop="' + name + '"]');
  }

  let popExpanded = false; // cửa sổ đang được mở rộng tạm thời cho dropdown

  // Khi đóng hết menu: khôi phục kích thước giấy ban đầu.
  function restoreAfterPop(force) {
    if (popExpanded || force) {
      popExpanded = false;
      api.restoreNoteBounds(id);
    }
  }

  // Đặt menu tại vị trí tự nhiên (mở xuống). Nếu thiếu chỗ trong cửa sổ,
  // mở rộng tạm thời cửa sổ xuống dưới để menu tràn ra ngoài giấy — không dùng thanh cuộn.
  async function positionPop(pop, name) {
    const btn = anchorForPop(name);
    if (!btn) return;
    const gap = 6;
    pop.style.maxHeight = 'none';
    pop.style.overflowY = 'visible';
    pop.style.left = '10px';
    pop.style.top = '10px';

    const pw = Math.min(pop.offsetWidth || 240, window.innerWidth - 12);
    const ph = pop.offsetHeight || 300;
    const r = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - (r.bottom + gap);
    const spaceAbove = r.top - gap;
    const left = Math.min(Math.max(gap, r.right - pw), window.innerWidth - pw - gap);

    if (spaceBelow >= ph) {
      pop.style.left = left + 'px';
      pop.style.top = (r.bottom + gap) + 'px';
    } else if (spaceAbove >= ph) {
      pop.style.left = left + 'px';
      pop.style.top = (r.top - ph - gap) + 'px'; // lật lên trên
    } else {
      // mở rộng cửa sổ xuống dưới để menu tràn ra ngoài giấy
      const need = Math.ceil(ph - spaceBelow) + 12; // +12px đệm an toàn, không chạm mép
      await api.expandForPop(id, { bottom: need });
      await new Promise((res) => setTimeout(res, 90));
      const r2 = btn.getBoundingClientRect();
      pop.style.left = Math.min(Math.max(gap, r2.right - pw), window.innerWidth - pw - gap) + 'px';
      pop.style.top = (r2.bottom + gap) + 'px';
      popExpanded = true;
    }
  }

  async function togglePop(name) {
    const pop = $('#' + name);
    const open = pop.classList.toggle('open');
    const wasOpen = !open && document.querySelector('.pop.open') === null;
    $$('.pop').forEach((p) => { if (p !== pop) p.classList.remove('open'); });
    $$('.pop-toggle').forEach((b) => b.classList.toggle('active', b.dataset.pop === name && open));
    if (open) {
      await positionPop(pop, name);
    } else {
      restoreAfterPop(false);
    }
    syncToolbar();
    return open;
  }

  // Thanh công cụ tự ẩn khi không soạn thảo; hiện lại khi đang gõ/bấm,
  // rê chuột lên thanh công cụ, hoặc đang mở menu.
  let toolbarHover = false;
  let lastInteract = 0;
  let hideTimer = null;
  function markInteract() {
    lastInteract = Date.now();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(syncToolbar, 1550);
    syncToolbar();
  }
  function syncToolbar() {
    const interact = Date.now() - lastInteract < 1500;
    const popOpen = !!document.querySelector('.pop.open');
    $('#toolbar').classList.toggle('collapsed', !(interact || popOpen || toolbarHover));
  }

  /* ========================= kéo chỉnh kích thước ========================= */

  function bindResize() {
    for (const el of $$('.rz')) {
      const dir = el.dataset.rz;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        const sX = e.screenX, sY = e.screenY;
        const x0 = window.screenX, y0 = window.screenY;
        const w0 = window.innerWidth, h0 = window.innerHeight;

        const onMove = (ev) => {
          const dx = ev.screenX - sX, dy = ev.screenY - sY;
          let x = x0, y = y0, w = w0, h = h0;
          if (dir.includes('e')) w = w0 + dx;
          if (dir.includes('s')) h = h0 + dy;
          if (dir.includes('w')) { w = w0 - dx; x = x0 + dx; }
          if (dir.includes('n')) { h = h0 - dy; y = y0 + dy; }
          if (w < 180) { if (dir.includes('w')) x -= 180 - w; w = 180; }
          if (h < 120) { if (dir.includes('n')) y -= 120 - h; h = 120; }
          api.moveWindow(id, x, y);
          api.resizeWindow(id, w, h);
        };
        const onUp = () => {
          el.removeEventListener('pointermove', onMove);
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp, { once: true });
      });
    }
  }

  /* ========================= sự kiện ========================= */

  function bindEvents() {
    // toolbar commands
    $('#toolbar').addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    $('#toolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-cmd]');
      if (btn) runCommand(btn.dataset.cmd);
    });

    fontSelect.addEventListener('change', () => setFontFamily(fontSelect.value));
    colorInput.addEventListener('input', () => setTextColor(colorInput.value));

    $('#btnPin').addEventListener('click', () => {
      note.alwaysOnTop = !note.alwaysOnTop;
      api.setAlwaysOnTop(id, note.alwaysOnTop);
      $('#btnPin').classList.toggle('active', note.alwaysOnTop);
      onChange();
    });

    // opacity
    opacityRange.addEventListener('input', () => setOpacity(opacityRange.value / 100));
    $$('.opacity-chips button').forEach((b) =>
      b.addEventListener('click', () => setOpacity(+b.dataset.op)));
    $$('.opacity-chips button').forEach((b) =>
      b.classList.toggle('active', Math.abs(+b.dataset.op - (note.opacity ?? 0.55)) < 0.001));

    // popovers
    $$('.pop-toggle').forEach((b) =>
      b.addEventListener('click', (e) => { e.stopPropagation(); togglePop(b.dataset.pop); }));
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.pop') && !e.target.closest('.pop-toggle')) {
        $$('.pop').forEach((p) => p.classList.remove('open'));
        $$('.pop-toggle').forEach((b) => b.classList.remove('active'));
        restoreAfterPop(false);
        syncToolbar();
      }
    });

    // thanh công cụ tự ẩn/hiện theo tương tác
    noteEl.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.rz')) markInteract();
    });
    editor.addEventListener('pointerdown', markInteract);
    editor.addEventListener('keydown', markInteract);
    editor.addEventListener('input', markInteract);
    titleInput.addEventListener('pointerdown', markInteract);
    titleInput.addEventListener('input', markInteract);
    const tb = $('#toolbar');
    tb.addEventListener('pointerdown', markInteract);
    tb.addEventListener('mouseenter', () => { toolbarHover = true; syncToolbar(); });
    tb.addEventListener('mouseleave', () => { toolbarHover = false; syncToolbar(); });

    // settings
    $('#optFooter').addEventListener('change', async (e) => {
      settings.showFooter = e.target.checked;
      footerEl.style.display = settings.showFooter ? '' : 'none';
      await api.setSettings({ showFooter: settings.showFooter });
    });
    $('#optLaunch').addEventListener('change', (e) => {
      api.setLaunchAtLogin(e.target.checked);
      settings.launchAtLogin = e.target.checked;
    });

    $('#btnAddFont').addEventListener('click', async () => {
      const r = await api.addCustomFont();
      if (r.ok) await loadFonts();
    });

    $('#btnExport').addEventListener('click', async () => {
      await api.exportNote(id, editor.innerText);
    });

    $('#btnDelete').addEventListener('click', () => {
      if (confirm('Xóa giấy nhớ này?')) {
        api.deleteNote(id);
      }
    });

    $('#btnQuit').addEventListener('click', () => api.quit());

    // notes popover
    $('#btnNotes').addEventListener('click', (e) => {
      e.stopPropagation();
      fillNotesList().then(() => togglePop('notesPop'));
    });
    $('#btnNewNote').addEventListener('click', () => {
      api.createNote({ focus: true });
    });
    api.onNoteCreated(() => { /* cửa sổ mới tự mở */ });

    // editor
    editor.addEventListener('input', onChange);
    editor.addEventListener('beforeinput', handleSpaceBeforeInput);
    editor.addEventListener('blur', scheduleSave);

    titleInput.addEventListener('input', () => { keepTitleStart(); onChange(); });
    titleInput.addEventListener('focus', () => {
      const r = document.createRange();
      r.selectNodeContents(titleInput);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      requestAnimationFrame(keepTitleStart);
    });
    titleInput.addEventListener('click', keepTitleStart);
    titleInput.addEventListener('keyup', keepTitleStart);
    document.addEventListener('selectionchange', () => {
      if (document.activeElement === titleInput) keepTitleStart();
    });

    bindResize();

    // chặn menu chuột phải mặc định, thay bằng menu ngữ cảnh tiện ích
    editor.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY);
    });
  }

  function showContextMenu(x, y) {
    const menu = document.createElement('div');
    menu.className = 'ctx';
    const items = [
      ['Tăng cỡ chữ', () => changeFontSize(+1)],
      ['Giảm cỡ chữ', () => changeFontSize(-1)],
      ['Danh sách chấm', () => exec('insertUnorderedList')],
      ['---'],
      ['Sao chép', () => exec('copy')],
      ['Dán', () => exec('paste')],
    ];
    for (const [label, fn] of items) {
      if (label === '---') { menu.appendChild(document.createElement('hr')); continue; }
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => { menu.remove(); fn(); });
      menu.appendChild(b);
    }
    menu.style.left = Math.min(x, window.innerWidth - 170) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 260) + 'px';
    document.body.appendChild(menu);
    setTimeout(() => {
      document.addEventListener('mousedown', (e) => { if (!menu.contains(e.target)) menu.remove(); }, { once: true });
    }, 0);
  }

  /* ========================= test hooks ========================= */

  window.__ui = {
    runCommand,
    exec,
    changeFontSize,
    setOpacity,
    setFontFamily,
    setTextColor,
    togglePop,
    getNote: () => note,
    getSettings: () => settings,
    editor,
    fillNotesList,
  };

  /* ========================= chạy ========================= */

  init();
})();
