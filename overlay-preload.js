// overlay-preload.js 
// Exposes a safe channel for the overlay window to receive live session updates.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
    onUpdate: (callback) => ipcRenderer.on('champselect-update', (_event, data) => callback(data)),
    // Lets the overlay grow/shrink its own window - passively (fitting
    // content) or explicitly (collapse toggle, reset-size double-click).
    // `forced` tells main.js to override a user's manual edge-drag resize;
    // see the 'resize-overlay' handler in main.js for the full picture.
    resize: (height, forced) => ipcRenderer.send('resize-overlay', { height, forced: !!forced }),
    // Player dragged an enemy portrait into a role slot - swapping it with
    // whoever was already there, or moving it into an empty slot. cellId,
    // not champion name, so it survives that player swapping picks.
    setEnemyRole: (cellId, role) => ipcRenderer.send('set-enemy-role', { cellId, role })
});