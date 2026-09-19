// preload.js — runs in a privileged context, bridges main process <-> dashboard UI safely.
//
// The dashboard window (src/home.html, src/settings.html, src/about.html)
// can't access Node or the network directly (contextIsolation is on,
// nodeIntegration is off - on purpose, it's safer). Instead, main.js does
// the real work (talking to the LCU, mapping session data, reading config
// and champion data) and pushes results through this bridge.
//
// This same preload script runs on every dashboard page - Electron
// re-injects it on each loadFile() navigation - so window.draftAPI stays
// available no matter which page (home/settings/about) is currently shown.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('draftAPI', {
    onSessionUpdate: (callback) => ipcRenderer.on('session-update', (_event, data) => callback(data)),
    onSessionEnded: (callback) => ipcRenderer.on('session-ended', () => callback()),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    updateSettings: (updates) => ipcRenderer.send('update-settings', updates),
    getChampionList: () => ipcRenderer.invoke('get-champion-list'),
    getPatchOptions: () => ipcRenderer.invoke('get-patch-options'),
    navigate: (page) => ipcRenderer.send('navigate-to', page),
    // Player clicked an enemy portrait to say "this is who I'm laning
    // against" - overrides the position-based auto-guess. cellId, not
    // champion name, so it survives that player swapping picks.
    setLaneOpponent: (cellId) => ipcRenderer.send('set-lane-opponent', cellId)
});