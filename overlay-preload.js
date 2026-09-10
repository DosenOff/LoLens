// overlay-preload.js 
// Exposes a safe channel for the overlay window to receive live session updates.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
    onUpdate: (callback) => ipcRenderer.on('champselect-update', (_event, data) => callback(data)),
    // Lets the overlay grow/shrink its own window when toggling between the
    // compact list and an expanded champion detail card.
    resize: (height) => ipcRenderer.send('resize-overlay', height),
});