// scripts/fetch-champion-data.js
//
// One-time (well, rerun-when-champions-change) script that downloads the
// champion ID -> name mapping from Riot's Data Dragon CDN.
//
// Unlike the LCU, Data Dragon is officially public and meant for third-party
// use - no API key, no auth, no "unsupported" caveat.
//
// Run with: node scripts/fetch-champion-data.js

const fs = require('fs');
const path = require('path');

(async () => {
    try {
        console.log('Fetching latest Data Dragon version...');
        const versionsRes = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
        const versions = await versionsRes.json();
        const latest = versions[0];
        console.log(`Latest patch: ${latest}`);

        console.log('Fetching champion data...');
        const champRes = await fetch(
            `https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/champion.json`
        );
        const champData = await champRes.json();

        // champData.data is keyed by champion name (e.g. "Aatrox"), each entry
        // has a numeric "key" field which is the championID the LCU uses.
        // We want the reverse: championId -> readable name.
        const idToName = {};
        for (const champName of Object.keys(champData.data)) {
            const champ = champData.data[champName];
            idToName[champ.key] = champ.name;   // key is a string like "266"
        }

        const outPath = path.join(__dirname, '..', "assets", 'champions.json');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify({ version: latest, idToName }, null, 2));

        console.log(`\nSaved ${Object.keys(idToName).length} champions to assets/champions.json`);
    } catch (err) {
        console.error('Failed to fetch champion data:', err.message);
    }
})();