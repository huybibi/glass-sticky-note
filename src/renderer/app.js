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
  let userHeight = 260;   // chiều cao tối thiểu do người dùng kéo
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
    titleInput.value = note.title || '';
    editor.innerHTML = note.html || '';
    $('#btnPin').classList.toggle('active', !!note.alwaysOnTop);
    footerEl.style.display = settings.showFooter ? '' : 'none';
    userHeight = note.height || 260;
    editor.classList.toggle('scrollable', !settings.autoGrow);
    noteEl.classList.toggle('no-vrz', !settings.autoGrow);
  }

  async function init() {
    settings = await api.getSettings();
    note = await api.getNote(id);
    if (!note) return;

    applyNoteStyle();
    await loadFonts();
    fillNotesList();

    bindEvents();
    scheduleSave();
    requestAnimationFrame(() => autoGrow(true));
    updateCounters();
    editor.focus();
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

  function insertTask() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const task = document.createElement('div');
    task.className = 'task';
    task.innerHTML = '<span class="cb" contenteditable="false"></span><div class="tx" contenteditable="true"></div>';
    range.deleteContents();
    range.insertNode(task);

    // nếu vừa chèn vào trong <p> (ví dụ sau khi bấm Enter), đưa ô tích ra ngoài
    // để cấu trúc phẳng, tránh lỗi con trỏ đặt sai chỗ.
    let parent = task.parentElement;
    if (parent && parent !== editor && parent.tagName === 'P') {
      parent.parentNode.insertBefore(task, parent.nextSibling);
      if (!parent.textContent.trim()) parent.remove();
    }

    const tx = task.querySelector('.tx');
    placeCaretAtEnd(tx);
    tx.focus();
    updateCounters();
    onChange();
    return { task, tx };
  }

  function runCommand(cmd) {
    switch (cmd) {
      case 'insertUnorderedList': exec('insertUnorderedList'); break;
      case 'insertOrderedList': exec('insertOrderedList'); break;
      case 'task': insertTask(); break;
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

    const m = /^\[ ?\]$/.exec(text);
    if (m) {
      e.preventDefault();
      block.innerHTML = '';
      insertTask();
    } else if (text === '-' || text === '*') {
      e.preventDefault();
      block.innerHTML = '';
      exec('insertUnorderedList');
    } else if (text === '1.') {
      e.preventDefault();
      block.innerHTML = '';
      exec('insertOrderedList');
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

  /* ========================= checklist ========================= */

  function handleEditorPointerDown(e) {
    const cb = e.target.closest && e.target.closest('.cb');
    if (cb) {
      e.preventDefault();
      e.stopPropagation();
      const task = cb.closest('.task');
      if (task) {
        task.classList.toggle('done');
        cb.setAttribute('aria-checked', task.classList.contains('done') ? 'true' : 'false');
        updateCounters();
        onChange();
      }
    }
  }

  function handleEditorKeydown(e) {
    const task = e.target.closest && e.target.closest('.task');
    if (!task) return;

    const tx = e.target.closest('.tx');
    if (!tx) return;
    const empty = tx.textContent.trim() === '';

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (empty) return; // Enter trên dòng trống: không tạo thêm
      const next = document.createElement('div');
      next.className = 'task';
      next.innerHTML = '<span class="cb" contenteditable="false"></span><div class="tx" contenteditable="true"></div>';
      task.after(next);
      const ntx = next.querySelector('.tx');
      placeCaretAtEnd(ntx);
      ntx.focus();
      updateCounters();
      onChange();
    } else if (e.key === 'Backspace' && empty) {
      const prev = task.previousElementSibling;
      if (prev && prev.classList.contains('task')) {
        e.preventDefault();
        task.remove();
        placeCaretAtEnd(prev.querySelector('.tx'));
        prev.querySelector('.tx').focus();
        updateCounters();
        onChange();
      }
    }
  }

  /* ========================= đếm ========================= */

  function updateCounters() {
    const text = editor.innerText;
    const words = (text.trim().match(/\S+/g) || []).length;
    const chars = text.replace(/\n/g, '').length;
    wordCounter.textContent = `${words} từ · ${chars} ký tự`;
    const done = editor.querySelectorAll('.task.done').length;
    const total = editor.querySelectorAll('.task').length;
    taskCounter.textContent = total ? `${done}/${total} việc đã xong` : '';
  }

  /* ========================= auto-grow ========================= */

  function measureNeededHeight() {
    const grip = 34;
    const toolbar = $('#toolbar').offsetHeight + 12;
    const footer = settings.showFooter ? 22 : 2;
    const editorH = Math.max(60, editor.scrollHeight + 24);
    return grip + toolbar + editorH + footer;
  }

  function autoGrow(force) {
    if (!settings.autoGrow) return;
    const needed = Math.max(measureNeededHeight(), userHeight);
    const cur = window.innerHeight;
    if (force || Math.abs(needed - cur) > 3) {
      api.resizeWindow(id, window.innerWidth, Math.round(needed));
    }
  }

  /* ========================= lưu ========================= */

  function onChange() {
    updateCounters();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(scheduleSave, 300);
    if (settings.autoGrow) requestAnimationFrame(() => autoGrow(false));
  }

  function scheduleSave() {
    api.updateNote(id, {
      html: editor.innerHTML,
      title: titleInput.value.trim() || 'Giấy nhớ',
      opacity: note.opacity,
      fontFamily: note.fontFamily,
      fontSize: note.fontSize,
      textColor: note.textColor,
      alwaysOnTop: note.alwaysOnTop,
    });
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

  function togglePop(name) {
    const pop = $('#' + name);
    const open = pop.classList.toggle('open');
    $$('.pop').forEach((p) => { if (p !== pop) p.classList.remove('open'); });
    $$('.pop-toggle').forEach((b) => b.classList.toggle('active', b.dataset.pop === name && open));
    return open;
  }

  /* ========================= kéo chỉnh kích thước ========================= */

  function bindResize() {
    for (const el of $$('.rz')) {
      const dir = el.dataset.rz;
      if (dir === 'n' || dir === 's') el.classList.toggle('hidden', settings.autoGrow);
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
          userHeight = window.innerHeight;
          if (settings.autoGrow) requestAnimationFrame(() => autoGrow(false));
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
      }
    });

    // settings
    $('#optAutoGrow').addEventListener('change', async (e) => {
      settings.autoGrow = e.target.checked;
      await api.setSettings({ autoGrow: settings.autoGrow });
      editor.classList.toggle('scrollable', !settings.autoGrow);
      $('.rz-n').classList.toggle('hidden', settings.autoGrow);
      $('.rz-s').classList.toggle('hidden', settings.autoGrow);
      if (settings.autoGrow) { userHeight = window.innerHeight; requestAnimationFrame(() => autoGrow(true)); }
    });
    $('#optFooter').addEventListener('change', async (e) => {
      settings.showFooter = e.target.checked;
      footerEl.style.display = settings.showFooter ? '' : 'none';
      await api.setSettings({ showFooter: settings.showFooter });
      if (settings.autoGrow) requestAnimationFrame(() => autoGrow(true));
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
    editor.addEventListener('keydown', handleEditorKeydown);
    editor.addEventListener('pointerdown', handleEditorPointerDown);
    editor.addEventListener('beforeinput', handleSpaceBeforeInput);
    editor.addEventListener('blur', scheduleSave);

    titleInput.addEventListener('input', onChange);
    titleInput.addEventListener('focus', () => titleInput.select());

    // auto-grow cũng khi phông chữ thay đổi
    document.fonts?.addEventListener?.('loadingdone', () => { if (settings.autoGrow) autoGrow(false); });

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
      ['Checklist', () => insertTask()],
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
    insertTask,
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
    autoGrow,
  };

  /* ========================= chạy ========================= */

  init();
})();
