// file: client-agent/src/renderer/capturePreload.js
// Preload for the hidden system-audio capture window.
// Exposes IPC and fs to the renderer via contextBridge.
//
// NOTE: desktopCapturer.getSources() is intentionally NOT exposed here.
// In Electron 17+, that API must be called from the main process.
// The main process calls it and passes the sourceId directly in the
// 'start-system-capture' IPC message payload.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureAPI', {
  // IPC: listen for commands from main process
  // Callback receives (outputPath, sourceId) — sourceId obtained in main process
  onStart: (cb) => ipcRenderer.on('start-system-capture', (_, outputPath, sourceId) => cb(outputPath, sourceId)),
  onStop:  (cb) => ipcRenderer.on('stop-system-capture',  () => cb()),

  // IPC: notify main process of status
  captureStarted: ()         => ipcRenderer.send('system-capture-started'),
  captureStopped: (webmPath) => ipcRenderer.send('system-capture-stopped', webmPath),
  captureError:   (msg)      => ipcRenderer.send('system-capture-error', msg),

  // Write recorded audio data to a temp .webm file via IPC (fs not available in sandbox)
  writeFile: (filePath, buffer) => ipcRenderer.sendSync('system-capture-write-file', filePath, buffer),
});
