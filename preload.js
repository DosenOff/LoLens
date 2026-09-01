// preload.js — runs in a privileged context, bridges main process <-> UI safely.
// Empty for now. When we wire up the LCU/Riot API, this is where we'll do:
//
//   const { contextBridge, ipcRenderer } = require('electron');
//   contextBridge.exposeInMainWorld('draftAPI', {
//     onSessionUpdate: (callback) => ipcRenderer.on('session-update', (_event, data) => callback(data))
//   });
//
// That lets the UI (index.html) call window.draftAPI.onSessionUpdate(...)
// to receive real champion select data pushed from the Node backend,
// without giving the browser-side code raw access to Node/filesystem/network.
