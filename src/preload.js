/**
 * preload.js — cầu nối an toàn giữa renderer và main process.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sticky', {
  noteId: () => {
    try {
      const q = new URLSearchParams(window.location.search);
      return q.get('id');
    } catch { return null; }
  },

  getNote: (id) => ipcRenderer.invoke('note:get', id),
  updateNote: (id, patch) => ipcRenderer.invoke('note:update', id, patch),
  listNotes: () => ipcRenderer.invoke('note:list'),
  createNote: (opts) => { ipcRenderer.send('note:create', opts); },
  onNoteCreated: (cb) => ipcRenderer.on('note:created', (_e, r) => cb(r)),
  deleteNote: (id) => ipcRenderer.send('note:delete', id),
  focusNote: (id) => ipcRenderer.send('note:focus', id),

  moveWindow: (id, x, y) => ipcRenderer.send('win:move', id, x, y),
  resizeWindow: (id, w, h) => ipcRenderer.send('win:resize', id, w, h),
  setAlwaysOnTop: (id, flag) => ipcRenderer.send('win:setAlwaysOnTop', id, flag),
  expandForPop: (id, d) => ipcRenderer.invoke('win:expandForPop', id, d),
  restoreNoteBounds: (id) => ipcRenderer.invoke('win:restoreNoteBounds', id),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setLaunchAtLogin: (flag) => ipcRenderer.send('app:setLaunchAtLogin', flag),

  listCustomFonts: () => ipcRenderer.invoke('font:list'),
  addCustomFont: () => ipcRenderer.invoke('font:add'),

  exportNote: (id, text) => ipcRenderer.invoke('note:export', Object.assign({ id }, text ? { exportText: text } : {})),
  quit: () => ipcRenderer.send('app:quit'),
});
