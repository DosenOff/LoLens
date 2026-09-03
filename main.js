// main.js — the Electron "main process"
//
// This app now runs primarily in the background:
//  - No dock icon (macOS), just a tray/menu-bar icon.
//  - A small toast pops up top-left when League is detected running.
//  - A compact overlay pops up top-left during champion select, and
//    disappears when champ select ends.
//  - The full dashboard (src/index.html) is still available from the
//    tray menu if you want to open it manually.

const { app, BrowserWindow, Tray, Menu, screen, ipcMain } = require('electron');
const path = require('path');
const { startWatching } = require('./lib/watcher');
const { championName } = require('./lib/championData');
const { mapSession } = require('./lib/sessionMapper');

let tray = null;
let dashboardWindow = null;
let toastWindow = null;
let overlayWindow = null;

const CORNER_MARGIN = 16;

function topLeftPosition(width, height) {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + CORNER_MARGIN, y: workArea.y + CORNER_MARGIN, width, height };
}

function createDashboardWindow() {
  if (dashboardWindow) {
    dashboardWindow.show();
    return;
  }
  dashboardWindow = new BrowserWindow({
    width: 1080,
    height: 820,
    backgroundColor: '#0A0E14',
    title: 'LoLens',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  dashboardWindow.loadFile('src/index.html');
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
}

function showToast() {
  if (toastWindow) return; // already showing

  const { x, y, width, height } = topLeftPosition(220, 46);
  toastWindow = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: { contextIsolation: true }
  });
  toastWindow.loadFile('src/toast.html');

  setTimeout(() => {
    if (toastWindow) {
      toastWindow.close();
      toastWindow = null;
    }
  }, 2500);
}

function showOverlay() {
  if (overlayWindow) return overlayWindow;

  const { x, y, width, height } = topLeftPosition(260, 160);
  overlayWindow = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlayWindow.loadFile('src/overlay.html');
  overlayWindow.on('closed', () => { overlayWindow = null; });
  return overlayWindow;
}

function hideOverlay() {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
}

function createTray() {
  // Tray requires an icon image; rather than shipping an icon asset right
  // now, we use a transparent 1x1 image and a text title on macOS (Tray
  // supports setTitle() as a menu-bar label). Swap in a real icon file later
  // without changing anything else here.
  const { nativeImage } = require('electron');
  const emptyIcon = nativeImage.createEmpty();
  tray = new Tray(emptyIcon);
  if (process.platform === 'darwin') {
    tray.setTitle('LoLens');
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: createDashboardWindow },
    { type: 'separator' },
    { label: 'Quit LoLens', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('LoLens — watching for League');
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.hide(); // background/menu-bar app, not a normal dock app
  }

  createTray();

  startWatching({
    onReady: () => {
      showToast();
    },
    onChampSelectUpdate: (rawSession) => {
      const session = mapSession(rawSession, { championName });

      // Push to the dashboard window if it's open.
      if (dashboardWindow) {
        dashboardWindow.webContents.send('session-update', session);
      }

      // Push to the corner overlay, opening it if this is the first update.
      const overlay = showOverlay();
      const sendToOverlay = () => overlay.webContents.send('champselect-update', session);
      if (overlay.webContents.isLoading()) {
        overlay.webContents.once('did-finish-load', sendToOverlay);
      } else {
        sendToOverlay();
      }
    },
    onChampSelectEnd: () => {
      hideOverlay();
      if (dashboardWindow) {
        dashboardWindow.webContents.send('session-ended');
      }
    },
    onLeagueClosed: () => {
      hideOverlay();
      if (dashboardWindow) {
        dashboardWindow.webContents.send('session-ended');
      }
    }
  });
});

app.on('window-all-closed', () => {
  // Deliberately do nothing here — this is a background/tray app,
  // so it should keep running even with no windows open (dashboard
  // closed, toast/overlay closed). Quitting only happens via the
  // tray menu's "Quit LoLens".
});