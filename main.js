// main.js — the Electron "main process"
//
// This app now runs primarily in the background:
//  - No dock icon (macOS), just a tray/menu-bar icon.
//  - A small toast pops up top-left when League is detected running.
//  - A compact overlay pops up top-left during champion select, and
//    disappears when champ select ends.
//  - The full dashboard is still available from the tray menu, and is now
//    a small multi-page window (src/home.html, src/settings.html,
//    src/about.html) navigated via the icons in its top-right corner
//    rather than a single long scrolling page with an inline settings panel.

const { app, BrowserWindow, Tray, Menu, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ClearType (Windows' default subpixel text antialiasing) assumes it's
// compositing onto an opaque background. On the transparent, frameless
// windows toast.html/overlay.html use, that assumption breaks and the
// result is the "vertically stretched"/blurry text look on Windows -
// macOS never hits this since it doesn't use ClearType. Must be set
// before the 'ready' event, so this runs at module load rather than
// inside app.whenReady(). Falling back to grayscale AA instead is a
// no-op visually on macOS and on Windows' opaque dashboard window.
app.commandLine.appendSwitch('disable-lcd-text');

const { startWatching } = require('./lib/watcher');
const { championName, championIconUrl, listAllChampions } = require('./lib/championData');
const { mapSession } = require('./lib/sessionMapper');
const { getMatchupsAgainst, getMatchupStats } = require('./lib/matchupStats');
const {
  getPopulationStats,
  getPopulationMatchupStats,
  getPopulationSynergyStats,
  getAvailablePatches
} = require('./lib/populationStats');
const { getPoolRecommendations } = require('./lib/recommendations');
const { loadUserConfig, saveUserConfig } = require('./lib/userConfig');
const { rankEmblemUrl } = require('./lib/rankEmblem');
const { syncMatches, loadMatches } = require('./lib/matchSync');

// User-editable settings: champion pool, which population tier to compare
// against, which patch/date window of population data to use, and the
// sample-size confidence weighting (enabled + games-for-full-weight
// threshold) applied to personal/counter/synergy deltas — see
// lib/recommendations.js's confidenceWeight(). Loaded from
// user-config.json, changeable live from the settings page.
let userConfig = loadUserConfig();
const poolCounts = Object.entries(userConfig.championPools).map(([role, list]) => `${role}:${list.length}`).join(', ');
console.log(
  `Loaded user config: pools[${poolCounts}], tier=${userConfig.populationTier}, ` +
  `patchFilter=${JSON.stringify(userConfig.patchFilter)}, confidenceWeighting=${JSON.stringify(userConfig.confidenceWeighting)}`
);

let myMatches = loadMatches();
console.log(`Loaded ${myMatches.length} matches for personal matchup stats.`);
console.log('User data folder:', app.getPath('userData'));

let syncInFlight = null;

// Sync progress goes to the dashboard window (whichever page it's showing),
// not to whoever started the sync - the welcome screen navigates away
// while the sync is still running.
function sendSyncProgress(p) {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('sync-progress', p);
  }
}

// Runs a sync in the background. opts.replace / opts.onVerified are passed
// through to syncMatches (see lib/matchSync.js). Stats reload after every
// page, so personal numbers fill in as games arrive.
function runSync(riotId, opts = {}) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    let verified = false;
    try {
      const result = await syncMatches(riotId, (p) => {
        if (p.phase === 'fetching') myMatches = loadMatches();
        sendSyncProgress(p);
      }, {
        ...opts,
        onVerified: (info) => {
          verified = true;
          if (opts.onVerified) opts.onVerified(info);
        }
      });
      myMatches = loadMatches();
      sendSyncProgress({ phase: 'done', total: result.total });
      return result;
    } catch (err) {
      // Before verification the caller reports the failure itself (the
      // 'sync-matches' handler returns it); after it, nobody is waiting on
      // this promise, so tell the UI here.
      if (verified) sendSyncProgress({ phase: 'error', message: err.userMessage || 'Sync stopped. It will retry next launch.' });
      throw err;
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
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

// Manual per-enemy role assignments made by dragging a portrait into a
// role slot in the overlay (or the dashboard). Keyed by cellId (not
// champion name, so it survives that player swapping picks) -> role
// string ('top' | 'jungle' | 'middle' | 'bottom' | 'utility'). Only
// cellIds the player has actually dragged appear here; everyone else falls
// back to the LCU's own assignedPosition. Applied directly onto
// theirTeam[].position in onChampSelectUpdate, before anything else runs,
// so every downstream consumer (lane-opponent resolution, Counter Δ,
// matchup labeling) just reads p.position and automatically respects the
// drag — no separate override plumbing anywhere else. "My opponent" is
// then simply whoever occupies my own role (see resolveLaneOpponentCellId).
// Reset whenever a champ select session ends so the next draft starts
// fresh rather than carrying a stale layout forward.
let manualEnemyRoles = {};

// Resolves which enemy the player is actually laning against: whichever
// enemy occupies the player's own role, using each enemy's EFFECTIVE
// position (manualEnemyRoles already applied to theirTeam[].position by
// the time this runs - see onChampSelectUpdate). Falls back to the first
// enemy with a pick so there's still something sensible to show/highlight
// before any position data exists (early draft, some custom games never
// assign one at all). Returns null only when no enemy has picked anything.
function resolveLaneOpponentCellId(theirTeam, myPositionKey) {
  if (myPositionKey) {
    const positionMatch = theirTeam.find(
      (p) => p.championName && p.position && p.position.toLowerCase() === myPositionKey
    );
    if (positionMatch) return positionMatch.cellId;
  }
  const anyPick = theirTeam.find((p) => p.championName);
  return anyPick ? anyPick.cellId : null;
}

let tray = null;
let dashboardWindow = null;
let toastWindow = null;
let overlayWindow = null;

const CORNER_MARGIN = 16;
const DASHBOARD_PAGES = ['home', 'settings', 'about'];

// screen.getPrimaryDisplay() is whichever monitor Windows/macOS considers
// "primary" in display settings - on a multi-monitor setup that's very
// often NOT the monitor League is actually running on, which is why the
// toast/overlay kept showing up on the wrong screen. There's no cheap,
// dependency-free way to ask "which monitor is League's window on" from
// Electron's main process, but the cursor position is a solid proxy: the
// user was just clicking through champ select, so their cursor is almost
// always still on that same monitor.
function activeDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function topLeftPosition(width, height) {
  const { workArea } = activeDisplay();
  return { x: workArea.x + CORNER_MARGIN, y: workArea.y + CORNER_MARGIN, width, height };
}

function createDashboardWindow() {
  if (dashboardWindow) {
    dashboardWindow.show();
    return;
  }
  dashboardWindow = new BrowserWindow({
    // Compact "utility app" sizing (think Unity Hub's project list, not a
    // full dashboard) - the nav icons in the top-right corner swap pages
    // within this one window rather than opening new windows.
    width: 900,
    height: 600,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0A0E14',
    title: 'LoLens',
    // Packaged builds get their icon from build.win.icon/build.mac.icon in
    // package.json - this is only for `npm start`'s unpackaged window,
    // where Windows otherwise shows the generic Electron icon in the
    // taskbar. macOS ignores this option (it uses the app bundle's icon
    // instead), so it's a no-op there rather than something to branch on.
    icon: path.join(__dirname, 'assets', 'icon', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  dashboardWindow.loadFile(userConfig.riotId ? 'src/home.html' : 'src/welcome.html');
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
  // Use the same display just chosen for x/y - clamping against the
  // primary display's height while the window itself sits on a different
  // (e.g. taller/shorter) monitor would produce a wrong maxHeight.
  const { workAreaSize } = activeDisplay();

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
    alwaysOnTop: false,
    skipTaskbar: true,
    resizable: true,
    // focusable:false means this window can never become the OS-focused
    // window - clicking League (or anything else) just focuses it normally
    // without the overlay stealing or needing to "give up" focus. Buttons/
    // rows inside the overlay still receive clicks fine on macOS this way.
    // On Windows, focusable:false goes further and blocks clicks from
    // registering on the overlay's own rows/buttons at all (a known
    // Electron/Windows quirk with non-activating windows) - so there it's
    // flipped to true, at the cost of the overlay being able to steal
    // focus from League on click there.
    focusable: process.platform === 'win32',
    hasShadow: false,
    // roundedCorners is a Windows-only option (no-op elsewhere) - harmless
    // to set everywhere. On macOS, frameless/transparent windows get a
    // compositor-level rounded corner that can't be disabled from the app
    // side; overlay.html insets its visible gold frame by a few px so that
    // rounding doesn't visibly clip the corner brackets instead.
    roundedCorners: false,
    // macOS-only: clicking a focusable:false window still tells macOS "make
    // my app active," and since this window can't actually take focus, macOS
    // hands focus to some OTHER window in the app instead - the dashboard,
    // if one happens to exist, popping it to the front (a confirmed, still-
    // open Electron/macOS bug: electron/electron#29644). type:'panel' makes
    // this a real NSPanel, which Electron 28+ specifically excludes from
    // that app-activation dance (electron/electron#40307) - the same
    // technique CleanShot X, Raycast, and similar overlay/HUD apps use.
    // Windows/Linux have no such concept and don't have this bug either.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    // On Windows, a plain (default) show at construction forces this
    // window to the very top of the OS z-order, the same way any normal
    // window briefly claims top-of-stack on creation. A normal window
    // then gets demoted the instant something else is focused/activated -
    // but this one is focusable:false, so it never receives that
    // activation/blur signal and just stays pinned on top of whatever you
    // click afterward, even with alwaysOnTop off. show:false + an inert
    // showInactive() (shows without claiming activation/top-of-stack)
    // avoids ever entering that "forced to top" state in the first place,
    // so normal window focus changes push it behind other windows as
    // expected.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlayWindow.loadFile('src/overlay.html');
  overlayWindow.once('ready-to-show', () => {
    if (overlayWindow) overlayWindow.showInactive();
  });

  // type: 'panel' above (macOS) uses NSPanel to dodge the focus-stealing
  // bug in its own comment block - but NSPanel's own default window level
  // sits above a normal document window's, independent of the
  // alwaysOnTop:false constructor option, which only guards against an
  // *explicit* always-on-top bump; it doesn't touch NSPanel's own default
  // floating level. Force the level down explicitly so clicking another
  // app/window actually covers the overlay, matching the Windows fix above.
  if (process.platform === 'darwin') {
    overlayWindow.setAlwaysOnTop(false, 'normal');
  }

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
  // Real tray icon: the "lo" mark from the LoLens wordmark (the lowercase
  // l+o reads as a magnifying glass) - see assets/icon/. Sized per each
  // platform's own tray/menu-bar convention: 16px is the Windows/Linux
  // norm, macOS's menu bar wants something closer to ~22px so it doesn't
  // look undersized next to the system's own icons. setImage() (not just
  // the constructor) so this also works if createTray() is ever called
  // again after startup.
  const { nativeImage } = require('electron');
  const trayIconPath = path.join(
    __dirname,
    'assets', 'icon',
    process.platform === 'darwin' ? 'icon-24.png' : 'icon-16.png'
  );
  const trayIcon = nativeImage.createFromPath(trayIconPath);
  tray = new Tray(trayIcon);
  if (process.platform === 'darwin') {
    // Redundant with the icon now, but a harmless extra label already in
    // place - keep it rather than risk losing a click target/affordance
    // someone may be relying on.
    tray.setTitle('LoLens');
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: createDashboardWindow },
    { type: 'separator' },
    { label: 'Quit LoLens', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('LoLens — watching for League');

  // setContextMenu() alone only pops on an actual right-click on Windows.
  // macOS treats left-click as "show the menu" by convention, so without
  // this, Windows users have to right-click to get anything out of the
  // tray icon at all - wire left-click to do the same thing there.
  if (process.platform === 'win32') {
    tray.on('click', () => tray.popUpContextMenu());
  }
}

app.whenReady().then(() => {
  // No File/Edit/View/Window/Help strip - LoLens is tray-first and none
  // of those menus do anything useful here. On macOS this menu lives in
  // the system menu bar and is invisible either way, but on Windows/Linux
  // it renders as an ugly in-window strip on every BrowserWindow unless
  // explicitly removed.
  Menu.setApplicationMenu(null);

  if (process.platform === 'darwin') {
    app.dock.hide(); // background/menu-bar app, not a normal dock app
  }

  createTray();

  if (!userConfig.riotId) {
    createDashboardWindow(); // first run: show the setup screen
  } else {
    runSync(userConfig.riotId).catch((err) => console.log('Background sync failed:', err.message));
  }

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
        iconUrl: p.championName ? championIconUrl(p.championName) : null,
        // A manual drag-to-reorder assignment overrides whatever the LCU
        // itself reports for this player's role. Applied here, once, so
        // every downstream consumer (lane-opponent resolution, matchup
        // labeling, recommendations, and the overlay/dashboard's own role
        // bucketing) just reads p.position and gets the corrected value
        // automatically, with no separate override plumbing anywhere else.
        position: manualEnemyRoles[p.cellId] || p.position
      }));

      // Who the player is actually laning against - resolved once, up
      // front, so both the report panel and the recommendation engine's
      // Counter Δ agree on the same person rather than each guessing
      // independently. This is always just "whichever enemy occupies my
      // own role," using each enemy's effective (possibly manually
      // corrected) position - see resolveLaneOpponentCellId().
      const myPick = session.myTeam.find((p) => p.cellId === session.localPlayerCellId);
      const myPositionKey = myPick && myPick.position ? myPick.position.toLowerCase() : null;
      const laneOpponentCellId = resolveLaneOpponentCellId(session.theirTeam, myPositionKey);
      const laneOpponent = laneOpponentCellId !== null
        ? session.theirTeam.find((p) => p.cellId === laneOpponentCellId)
        : null;
      session.laneOpponentCellId = laneOpponentCellId;
      session.laneOpponentChampion = laneOpponent ? laneOpponent.championName : null;

      // Compute real personal matchup stats for every enemy champion
      // that's actually been picked so far. Keyed by champion name so the
      // UI can just do matchupData[championName] - same shape the old
      // mock data used. Also includes the population matchup number for
      // each entry - how the population does in that exact matchup, not
      // just the champion overall. (Matchup data is all-time - not
      // affected by the patch/date filter; see lib/populationStats.js.)
      // Kept as a dict for every enemy pick, not just the resolved
      // opponent, in case the UI ever wants to show more than one - the
      // dataset here is tiny (at most 5 entries) so this costs nothing.
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
      // local player has actually picked (if any). The population side
      // respects the user's patch/date filter from settings.
      session.personalVsPopulation = null;
      session.synergyData = [];
      if (myPick && myPick.championName) {
        const personal = getMatchupStats(myMatches, { myChampion: myPick.championName });
        const population = getPopulationStats(
          populationStats,
          userConfig.populationTier,
          myPick.championName,
          userConfig.patchFilter
        );
        session.personalVsPopulation = {
          championName: myPick.championName,
          tier: userConfig.populationTier,
          personal: personal.games > 0 ? personal : null,
          population
        };

        // Population synergy between your pick and each already-picked ally
        // (all-time - see note above).
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
      // Counter Δ is computed against the resolved lane opponent ONLY, not
      // every enemy pick - averaging across the whole enemy team was never
      // actually "your matchup," it just happened to mostly self-correct
      // because the population matchup data is itself position-scoped (see
      // fetch-population-data.js) and off-role lookups usually came back
      // null. This makes that intentional instead of incidental.
      const currentEnemyPicks = laneOpponent
        ? [{ championName: laneOpponent.championName, position: laneOpponent.position }]
        : [];
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

      // Champion pools are now per-role (top/jungle/middle/bottom/utility),
      // set from the Settings page. Use whichever pool matches the local
      // player's assigned lane for this draft (myPositionKey, resolved
      // above). If no lane is assigned yet (early in champ select, or a
      // custom game that never assigns one), fall back to the union of
      // every role's pool, deduplicated, so recommendations aren't just
      // empty while we wait.
      let sourcePool;
      let poolSourceLabel;
      if (myPositionKey && userConfig.championPools[myPositionKey] && userConfig.championPools[myPositionKey].length > 0) {
        sourcePool = userConfig.championPools[myPositionKey];
        poolSourceLabel = myPositionKey;
      } else {
        sourcePool = [...new Set(Object.values(userConfig.championPools).flat())];
        poolSourceLabel = 'all';
      }
      const availablePool = sourcePool.filter(
        (champion) => !unavailableChampions.has(champion)
      );
      session.recommendationsPoolLabel = poolSourceLabel; // 'top' | 'jungle' | 'middle' | 'bottom' | 'utility' | 'all'

      session.recommendations = getPoolRecommendations(availablePool, {
        myMatches,
        populationStats,
        tier: userConfig.populationTier,
        enemyChampions: currentEnemyPicks,
        allyChampions: currentAllyPicks,
        filter: userConfig.patchFilter,
        confidenceWeighting: userConfig.confidenceWeighting
      }).map((r) => ({
        ...r,
        iconUrl: championIconUrl(r.champion),
        breakdown: {
          ...r.breakdown,
          matchupList: r.breakdown.matchupList.map((m) => ({ ...m, iconUrl: championIconUrl(m.championName) })),
          synergyList: r.breakdown.synergyList.map((s) => ({ ...s, iconUrl: championIconUrl(s.championName) }))
        }
      }));
      session.populationTier = userConfig.populationTier; // so the UI can show current tier
      session.tierEmblemUrl = rankEmblemUrl(userConfig.populationTier); // real Riot rank emblem for the footer
      session.patchFilter = userConfig.patchFilter; // so the UI can show current data window

      // Push to the dashboard window if it's open and showing the home page.
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
      manualEnemyRoles = {}; // next draft starts fresh, not carrying this one's layout forward
      hideOverlay();
      if (dashboardWindow) {
        dashboardWindow.webContents.send('session-ended');
      }
    },
    onLeagueClosed: () => {
      manualEnemyRoles = {};
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

// Dashboard nav icons (home/gear/about) -> swap the page loaded into the
// one dashboard window, rather than opening separate windows. Validated
// against an allowlist since this handles an ipcRenderer.send from a
// (trusted, but still) renderer.
ipcMain.on('navigate-to', (event, page) => {
  if (!DASHBOARD_PAGES.includes(page)) return;
  if (dashboardWindow) dashboardWindow.loadFile(`src/${page}.html`);
});

// Overlay or dashboard -> main: the player dragged an enemy portrait into
// a role slot (either swapping it with whoever was already there, or
// moving it into an empty slot - the renderer works out which and sends
// one call per cellId that actually changed role). Applied on the next
// poll tick (~2s, same cadence as everything else) - no need to force an
// immediate re-send. Malformed input is ignored rather than stored, so a
// stray/garbled message can't silently corrupt the layout.
const VALID_ROLES = ['top', 'jungle', 'middle', 'bottom', 'utility'];
ipcMain.on('set-enemy-role', (event, { cellId, role } = {}) => {
  if (typeof cellId !== 'number' || !VALID_ROLES.includes(role)) return;
  manualEnemyRoles[cellId] = role;
});

// Settings page: every champion Data Dragon knows about, each with an
// icon URL, for the custom searchable champion-pool dropdown. [] if
// champions.json hasn't been fetched yet - the settings page renders a
// hint in that case rather than an empty-looking picker with no explanation.
ipcMain.handle('get-champion-list', () => listAllChampions());

// Settings page: what patch/date-window options are actually available
// to pick from, given what's in the population data right now. Presets
// (all-time / last 30 / last 90 days) are always offered since they don't
// depend on what patches happen to be sampled; the patch list is whatever
// scripts/fetch-population-data.js has actually recorded.
ipcMain.handle('get-patch-options', () => ({
  presets: [
    { value: 'all', label: 'All-time' },
    { value: 'days:30', label: 'Last 30 days' },
    { value: 'days:90', label: 'Last 90 days' }
  ],
  patches: getAvailablePatches(populationStats)
}));

// Renderer -> main: the settings page pushes updates here.
// Accepts a partial update, e.g. { championPool: [...] }, { populationTier: 'DIAMOND' },
// { patchFilter: { type: 'days', days: 30 } }, or
// { confidenceWeighting: { enabled: true, threshold: 20 } }.
ipcMain.on('update-settings', (event, updates) => {
  userConfig = { ...userConfig, ...updates };
  saveUserConfig(userConfig);
  console.log('User config updated:', updates);
  // The next champ-select poll tick will pick up the new config automatically -
  // no need to force a re-send here for anything session-driven. But the
  // dashboard's persistent population-tier/patch badge (home.html) has no
  // session to wait on while idle, so push it there directly too.
  if (dashboardWindow) {
    dashboardWindow.webContents.send('settings-update', userConfig);
  }
});

// Renderer asks for current settings when the settings page first opens.
ipcMain.handle('get-settings', () => userConfig);

const VALID_REGIONS = ['na1', 'euw1', 'eun1', 'kr', 'jp1', 'br1', 'la1', 'la2', 'oc1', 'tr1', 'ru'];
ipcMain.handle('sync-matches', async (event, riotId) => {
  const { gameName, tagLine, region } = riotId || {};
  if (typeof gameName !== 'string' || typeof tagLine !== 'string' ||
    !VALID_REGIONS.includes(region) ||
    !gameName.trim() || !tagLine.trim() ||
    gameName.length > 24 || tagLine.length > 8) {
    return { ok: false, error: 'Enter a valid Riot ID and region.' };
  }
  const clean = { gameName: gameName.trim(), tagLine: tagLine.trim(), region };
  const saved = userConfig.riotId;
  const sameId = saved &&
    saved.gameName.toLowerCase() === clean.gameName.toLowerCase() &&
    saved.tagLine.toLowerCase() === clean.tagLine.toLowerCase() &&
    saved.region === clean.region;

  // A sync (e.g. the launch-time one) is already running.
  if (syncInFlight) {
    if (sameId) return { ok: true, syncing: true };
    return { ok: false, error: 'A sync is still running. Try again in a moment.' };
  }

  // Resolves as soon as the first page proves the ID is real (or fails);
  // the remaining pages keep downloading after this returns.
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    runSync(clean, {
      replace: !sameId,
      onVerified: (info) => {
        userConfig = { ...userConfig, riotId: clean }; // only saved once the ID proved valid
        saveUserConfig(userConfig);
        finish({ ok: true, syncing: info.hasMore, total: info.total });
      }
    }).then(
      (result) => finish({ ok: true, syncing: false, total: result.total }),
      (err) => finish({ ok: false, error: err.userMessage || 'Could not sync your matches. Try again in a moment.' })
    );
  });
});

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

  // Clamp against whichever display the overlay window is actually
  // sitting on right now, not the OS's primary display - the cursor may
  // have moved elsewhere since the window was placed.
  const { workAreaSize } = screen.getDisplayMatching(overlayWindow.getBounds());
  const maxHeight = workAreaSize.height - CORNER_MARGIN * 2;
  const clamped = Math.max(40, Math.min(maxHeight, Math.round(height)));
  suppressNextResizeEvent = true;
  overlayWindow.setSize(OVERLAY_WIDTH, clamped);
});