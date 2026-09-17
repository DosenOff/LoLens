// lib/userConfig.js
//
// Loads/saves user-editable settings: champion pool, which population
// tier to compare against, and which patch/date window of population data
// to use. Stored at user-config.json (gitignored - it's personal
// preference, not code). user-config.example.json shows the format.

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'user-config.json');

// patchFilter shapes:
//   { type: 'all' }                 - every game ever sampled (default)
//   { type: 'days', days: 30 | 90 } - rolling window, ignores patch boundaries
//   { type: 'patch', patch: '15.18' } - exactly one patch
const DEFAULTS = {
    championPool: [],
    populationTier: 'EMERALD',
    patchFilter: { type: 'all' }
};

function loadUserConfig() {
    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULTS };
    }
}

function saveUserConfig(config) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

module.exports = { loadUserConfig, saveUserConfig };