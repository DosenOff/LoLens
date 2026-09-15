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
const fs = require('fs');
const { startWatching } = require('./lib/watcher');
const { championName, championIconUrl } = require('./lib/championData');
const { mapSession } = require('./lib/sessionMapper');
const { getMatchupsAgainst, getMatchupStats } = require('./lib/matchupStats');
const { getPopulationStats, getPopulationMatchupStats, getPopulationSynergyStats } = require('./lib/populationStats');
const { getPoolRecommendations } = require('./lib/recommendations');
const { loadUserConfig, saveUserConfig } = require('./lib/userConfig');

// User-editable settings: champion pool + which population tier to compare
// against. Loaded from user-config.json, changeable live from the UI.
let userConfig = loadUserConfig();
console.log(`Loaded user config: ${userConfig.championPool.length} champions in pool, tier=${userConfig.populationTier}`);

// Load your personal match history once at startup. If it doesn't exist yet
// (you haven't run fetch-match-ids/fetch-match-details), the app still works,
// it'll just show "no history" for every matchup until that data exists.
let myMatches = [];
try {
  const matchesPath = path.join(__dirname, 'data', 'matches.json');
  myMatches = JSON.parse(fs.readFileSync(matchesPath, 'utf-8'));
  console.log(`Loaded ${myMatches.length} matches for personal matchup stats.`);
} catch {
  console.log('No data/matches.json found yet — matchup stats will be empty until you run the fetch scripts.');
}

// Load rank-specific population baseline data. Same graceful fallback if
// you haven't run fetch-population-data yet.
let populationStats = { tiers: {} };
try {
  const popPath = path.join(__dirname, 'data', 'population-stats.json');
  populationStats = JSON.parse(fs.readFileSync(popPath, 'utf-8'));
  console.log('Loaded population baseline stats.');
} catch {
  console.log('No data/population-stats.json found yet — population comparison will be empty until you run fetch-population-data.');
}

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

  const { x, y, width, height } = topLeftPosition(250, 54);
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
  }, 3200);
}

// Overlay height starts in "list" mode and grows/shrinks from there - both
// automatically (fitting content) and manually (the user dragging the
// window's bottom edge, or the collapse toggle in the header). Keep
// OVERLAY_WIDTH/OVERLAY_LIST_HEIGHT in sync with the constants of the same
// name at the top of src/overlay.html's <script>.
const OVERLAY_WIDTH = 340;
const OVERLAY_LIST_HEIGHT = 340;

// overlayAutoFit: whether the overlay should keep resizing itself to fit
// its content on every render. Starts true; a real user edge-drag resize
// (detected below) turns it off so we stop fighting their chosen size -
// content beyond that size is simply cropped (see overlay.html's
// overflow:hidden). An explicit user action - the collapse/expand toggle,
// or double-clicking the drag grip - turns it back on (see the
// 'resize-overlay' handler's `forced` handling further down).
let overlayAutoFit = true;
// Guards against our own setSize() calls (from the resize-overlay IPC
// handler) being mistaken for a user-initiated edge-drag resize, since
// Electron's 'resize' event fires for both.
let suppressNextResizeEvent = false;

function showOverlay() {
  if (overlayWindow) return overlayWindow;

  overlayAutoFit = true;
  suppressNextResizeEvent = false;

  const { x, y, width, height } = topLeftPosition(OVERLAY_WIDTH, OVERLAY_LIST_HEIGHT);
  const { workAreaSize } = screen.getPrimaryDisplay();

  overlayWindow = new BrowserWindow({
    x, y, width, height,
    // Width is pinned (min === max) so edge-drag can only resize height -
    // "vertically" resizable, not horizontally, per the design brief.
    minWidth: OVERLAY_WIDTH,
    maxWidth: OVERLAY_WIDTH,
    minHeight: 40,
    maxHeight: workAreaSize.height - CORNER_MARGIN * 2,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    // focusable:false means this window can never become the OS-focused
    // window - clicking League (or anything else) just focuses it normally
    // without the overlay stealing or needing to "give up" focus. Buttons/
    // rows inside the overlay still receive clicks fine; only keyboard
    // focus and being brought to the front on click are affected. If
    // edge-drag resizing feels unresponsive on your OS, flipping this to
    // true is the fix - the tradeoff is the overlay can then steal focus
    // from League on click.
    focusable: false,
    hasShadow: false,
    // roundedCorners is a Windows-only option (no-op elsewhere) - harmless
    // to set everywhere. On macOS, frameless/transparent windows get a
    // compositor-level rounded corner that can't be disabled from the app
    // side; overlay.html insets its visible gold frame by a few px so that
    // rounding doesn't visibly clip the corner brackets instead.
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlayWindow.loadFile('src/overlay.html');

  overlayWindow.on('resize', () => {
    if (suppressNextResizeEvent) {
      suppressNextResizeEvent = false;
      return;
    }
    // A real user-initiated edge-drag resize - stop auto-fitting to
    // content until they ask for that again (collapse/expand toggle, or
    // double-clicking the drag grip - see overlay.html).
    overlayAutoFit = false;
  });

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
      const session = mapSession(rawSession, { championName, championIconUrl });

      // Attach a Data Dragon icon URL to every myTeam/theirTeam entry that
      // has a champion picked. mapSession() only gives us names (it's the
      // LCU-shape -> plain-object mapper, and doesn't know about icons at
      // all), so without this the overlay's enemy-comp portraits and the
      // dashboard's team slots have nothing to render but the abbreviation
      // fallback in portraitHtml(). Recommendations already got this same
      // treatment further down (r.iconUrl, matchupList/synergyList) - this
      // just extends it to the raw team rosters too.
      session.myTeam = session.myTeam.map((p) => ({
        ...p,
        iconUrl: p.championName ? championIconUrl(p.championName) : null
      }));
      session.theirTeam = session.theirTeam.map((p) => ({
        ...p,
        iconUrl: p.championName ? championIconUrl(p.championName) : null
      }));

      // Compute real personal matchup stats for every enemy champion
      // that's actually been picked so far. Keyed by champion name so the
      // UI can just do matchupData[championName] - same shape the old
      // mock data used. Now also includes the population matchup number
      // for each entry (v2) - how the population does in that exact
      // matchup, not just the champion overall.
      const matchupData = {};
      for (const p of session.theirTeam) {
        if (p.championName && !matchupData[p.championName]) {
          const stats = getMatchupsAgainst(myMatches, p.championName);
          matchupData[p.championName] = stats.map((s) => ({
            champion: s.myChampion,
            games: s.games,
            wins: s.wins,
            winRate: s.winRate,
            populationMatchup: getPopulationMatchupStats(
              populationStats,
              userConfig.populationTier,
              s.myChampion,
              p.championName
            )
          }));
        }
      }
      session.matchupData = matchupData;

      // Personal vs. population comparison for whichever champion the
      // local player has actually picked (if any).
      const myPick = session.myTeam.find((p) => p.cellId === session.localPlayerCellId);
      session.personalVsPopulation = null;
      session.synergyData = [];
      if (myPick && myPick.championName) {
        const personal = getMatchupStats(myMatches, { myChampion: myPick.championName });
        const population = getPopulationStats(populationStats, userConfig.populationTier, myPick.championName);
        session.personalVsPopulation = {
          championName: myPick.championName,
          tier: userConfig.populationTier,
          personal: personal.games > 0 ? personal : null,
          population
        };

        // v3: population synergy between your pick and each already-picked ally.
        const allies = session.myTeam.filter(
          (p) => p.cellId !== session.localPlayerCellId && p.championName
        );
        session.synergyData = allies.map((ally) => ({
          allyChampion: ally.championName,
          synergy: getPopulationSynergyStats(
            populationStats,
            userConfig.populationTier,
            myPick.championName,
            ally.championName
          )
        }));
      }

      // Champion pool recommendations - ranks the user's pool for the
      // current draft state using the transparent formula in lib/recommendations.js.
      // Each pick is tagged with its assigned position so the UI can label
      // counter/synergy rows (e.g. "JG", "MID") instead of just a name.
      const currentEnemyPicks = session.theirTeam
        .filter((p) => p.championName)
        .map((p) => ({ championName: p.championName, position: p.position }));
      const currentAllyPicks = session.myTeam
        .filter((p) => p.cellId !== session.localPlayerCellId && p.championName)
        .map((p) => ({ championName: p.championName, position: p.position }));

      // A champion already locked in (by either team) or banned can't be
      // picked - don't recommend it. Filtering the pool before scoring
      // (rather than after) also avoids wasted lookups for champs that
      // can't be selected anyway.
      const unavailableChampions = new Set(
        [
          ...session.myTeam.map((p) => p.championName),
          ...session.theirTeam.map((p) => p.championName),
          ...session.bans.mine,
          ...session.bans.theirs
        ].filter(Boolean)
      );
      const availablePool = userConfig.championPool.filter(
        (champion) => !unavailableChampions.has(champion)
      );

      session.recommendations = getPoolRecommendations(availablePool, {
        myMatches,
        populationStats,
        tier: userConfig.populationTier,
        enemyChampions: currentEnemyPicks,
        allyChampions: currentAllyPicks
      }).map((r) => ({
        ...r,
        iconUrl: championIconUrl(r.champion),
        breakdown: {
          ...r.breakdown,
          matchupList: r.breakdown.matchupList.map((m) => ({ ...m, iconUrl: championIconUrl(m.championName) })),
          synergyList: r.breakdown.synergyList.map((s) => ({ ...s, iconUrl: championIconUrl(s.championName) }))
        }
      }));
      session.populationTier = userConfig.populationTier; // so the UI can show/edit current tier

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

// Renderer -> main: the dashboard's settings panel pushes updates here.
// Accepts a partial update, e.g. { championPool: [...] } or { populationTier: 'DIAMOND' }.
ipcMain.on('update-settings', (event, updates) => {
  userConfig = { ...userConfig, ...updates };
  saveUserConfig(userConfig);
  console.log('User config updated:', updates);
  // The next champ-select poll tick will pick up the new config automatically -
  // no need to force a re-send here.
});

// Renderer asks for current settings when the dashboard first opens.
ipcMain.handle('get-settings', () => userConfig);

// Overlay -> main: grow/shrink the overlay window to fit its content
// (switching list <-> detail, or the collapse toggle). Clamps against the
// screen's visible work area so the window can't render off-screen.
//
// `forced` distinguishes two callers: passive per-render auto-fit (from
// overlay.html's fitToContent(), forced=false/omitted) is skipped once the
// user has manually edge-drag resized the window (overlayAutoFit === false)
// so we don't fight their chosen size - content beyond that size is simply
// cropped. `forced` calls (the collapse/expand toggle, double-clicking the
// drag grip) always take effect and re-enable auto-fit going forward,
// since those are explicit "here's the size I want now" actions.
ipcMain.on('resize-overlay', (event, { height, forced } = {}) => {
  if (!overlayWindow) return;
  if (!forced && !overlayAutoFit) return;
  if (forced) overlayAutoFit = true;

  const { workAreaSize } = screen.getPrimaryDisplay();
  const maxHeight = workAreaSize.height - CORNER_MARGIN * 2;
  const clamped = Math.max(40, Math.min(maxHeight, Math.round(height)));
  suppressNextResizeEvent = true;
  overlayWindow.setSize(OVERLAY_WIDTH, clamped);
});