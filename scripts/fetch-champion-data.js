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

        // champData.data is keyed by the champion's internal Data Dragon id
        // (e.g. "MonkeyKing" for Wukong) - NOT always the same as the
        // display name. Each entry has:
        //   .key  -> numeric championId, what the LCU uses (e.g. "62")
        //   .name -> display name, what match/population data is NOT keyed
        //            by (e.g. "Wukong")
        //   .id   -> Data Dragon id, what match/population data IS keyed by
        //            (Riot's match-v5 championName field), and what square
        //            icon filenames use: /img/champion/{id}.png
        // idToName: championId -> display name, for readable UI text.
        // nameToId: display name -> Data Dragon id, for building icon URLs
        // and for reconciling live champ-select picks (LCU only gives us
        // the display name via idToName) with match/population data (keyed
        // by id). The two differ for ~15-20 champs (Wukong/MonkeyKing,
        // Renata Glasc/Renata, Nunu & Willump/Nunu, Kai'Sa/Kaisa, etc).
        const idToName = {};
        const nameToId = {};
        for (const champKey of Object.keys(champData.data)) {
            const champ = champData.data[champKey];
            idToName[champ.key] = champ.name;   // key is a string like "266"
            nameToId[champ.name] = champ.id;
        }

        const outPath = path.join(__dirname, '..', "assets", 'champions.json');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify({ version: latest, idToName, nameToId }, null, 2));

        console.log(`\nSaved ${Object.keys(idToName).length} champions to assets/champions.json`);
    } catch (err) {
        console.error('Failed to fetch champion data:', err.message);
    }
})();