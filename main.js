// main.js — the Electron "main process"
// This is the one file that has access to the OS (windows, files, network).
// Right now it does the bare minimum: open a window and load our UI.
// Later, this is where LCU/Riot API calls will live, passed to the UI via IPC.

const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 820,
    backgroundColor: '#0A0E14', // matches the app bg so there's no white flash on load
    title: 'Draft Intel',
    webPreferences: {
      // preload.js is where we'll safely expose backend data to the UI later
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('src/index.html');

  // Uncomment while developing to open Chrome devtools automatically:
  // win.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
