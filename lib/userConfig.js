// lib/userConfig.js
//
// Loads/saves user-editable settings: per-role champion pools, which
// population tier to compare against, and which patch/date window of
// population data to use. Stored in Electron's per-user "userData"
// directory (NOT next to the app's own code) — once packaged, everything
// under the install directory (main.js, lib/, etc.) is bundled read-only
// inside app.asar, so writing there throws ENOTDIR. app.getPath('userData')
// resolves to the OS-correct, always-writable location in both dev and
// packaged builds (e.g. ~/Library/Application Support/LoLens on macOS,
// %APPDATA%/LoLens on Windows) — see user-config_example.json for the format.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const configPath = path.join(app.getPath('userData'), 'user-config.json');

// Keys match the LCU's assignedPosition / Riot's teamPosition strings
// (lowercased) so main.js can look a pool up directly by session.myPick.position.
const ROLE_KEYS = ['top', 'jungle', 'middle', 'bottom', 'utility'];

function emptyPools() {
    return { top: [], jungle: [], middle: [], bottom: [], utility: [] };
}

// patchFilter shapes:
//   { type: 'all' }                 - every game ever sampled (default)
//   { type: 'days', days: 30 | 90 } - rolling window, ignores patch boundaries
//   { type: 'patch', patch: '15.18' } - exactly one patch
//
// confidenceWeighting: one global setting, applied uniformly to personal/
// counter/synergy deltas - see confidenceWeight() in lib/recommendations.js.
// `threshold` is "games for full weight"; the population baseline itself
// is never weighted this way.
const DEFAULTS = {
    championPools: emptyPools(),
    populationTier: 'EMERALD',
    patchFilter: { type: 'all' },
    confidenceWeighting: { enabled: true, threshold: 20 },
    riotId: null            // { gameName, tagLine, region } once connected
};

// Older configs had a single flat `championPool: [...]` array with no
// per-role split. Rather than silently drop that list the first time this
// runs, seed every role's pool with it - not a perfect migration (we were
// never told which champion belonged to which lane), but it preserves the
// data, and the user can now split it apart from the Settings page.
function migrateLegacyPool(config) {
    if (config.championPools) return config;
    if (Array.isArray(config.championPool)) {
        const pools = emptyPools();
        for (const key of ROLE_KEYS) pools[key] = [...config.championPool];
        const { championPool, ...rest } = config;
        return { ...rest, championPools: pools };
    }
    return config;
}

function loadUserConfig() {
    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const migrated = migrateLegacyPool(JSON.parse(raw));
        return {
            ...DEFAULTS,
            ...migrated,
            // Defensive merge: guarantee all 5 role keys exist as arrays even
            // if a hand-edited or older config file is missing one.
            championPools: { ...emptyPools(), ...(migrated.championPools || {}) },
            // Same idea: an older config predating this setting, or a
            // hand-edited one missing a key, still gets sane defaults.
            confidenceWeighting: { ...DEFAULTS.confidenceWeighting, ...(migrated.confidenceWeighting || {}) }
        };
    } catch {
        return { ...DEFAULTS, championPools: emptyPools() };
    }
}

function saveUserConfig(config) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

module.exports = { loadUserConfig, saveUserConfig };