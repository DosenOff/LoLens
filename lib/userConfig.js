// lib/userConfig.js
//
// Loads/saves user-editable settings: champion pool and which population
// tier to compare against. Stored at user-config.json (gitignored - it's
// personal preference, not code). user-config.example.json shows the format.

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'user-config.json');

const DEFAULTS = {
    championPool: [],
    populationTier: 'EMERALD'
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