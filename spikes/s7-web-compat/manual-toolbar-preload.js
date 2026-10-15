'use strict';
// Preload for the manual browser's toolbar page ONLY. Web pages never get a preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nav', {
  go: (value) => ipcRenderer.send('nav:go', String(value)),
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  onUrl: (callback) => ipcRenderer.on('nav:url', (_event, value) => callback(value)),
});
