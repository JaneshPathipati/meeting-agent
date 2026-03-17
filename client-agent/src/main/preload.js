// file: client-agent/src/main/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetChamp', {
  login: () => ipcRenderer.invoke('auth:login'),
  verifyEmail: (email) => ipcRenderer.invoke('auth:verify-email', email),
  microsoftSignIn: () => ipcRenderer.invoke('auth:microsoft-signin'),
  getAuthStatus: () => ipcRenderer.invoke('auth:status'),
  verifyAuthKey: (key) => ipcRenderer.invoke('setup:verify-key', key),
  completeEnrollment: (data) => ipcRenderer.invoke('setup:complete-enrollment', data),
  closeSetup: () => ipcRenderer.invoke('setup:close'),
});
