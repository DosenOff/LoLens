// preload.js — runs in a privileged context, bridges main process <-> dashboard UI safely.
//
// The dashboard window (src/index.html) can't access Node or the network
// directly (contextIsolation is on, nodeIntegration is off - on purpose,
// it's safer). Instead, main.js does the real work (talking to the LCU,
// mapping session data) and pushes results through this bridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('draftAPI', {
    onSessionUpdate: (callback) => ipcRenderer.on('session-update', (_event, data) => callback(data)),
    onSessionEnded: (callback) => ipcRenderer.on('session-ended', () => callback()),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    updateSettings: (updates) => ipcRenderer.send('update-settings', updates)
});