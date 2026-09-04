// scripts/test-matchup-stats.js
//
// Objective: confirm the aggregation logic works against your real data,
// independent of the app/UI.
//
// Run with: node scripts/test-matchup-stats.js "Enemy Champion Name"

const fs = require('fs');
const path = require('path');
const { getMatchupsAgainst } = require('../lib/matchupStats');

const opponentChampion = process.argv[2];

if (!opponentChampion) {
    console.error('Usage: node scripts/test-matchup-stats.js "ChampionName"');
    process.exit(1);
}

const matchesPath = path.join(__dirname, '..', 'data', 'matches.json');
if (!fs.existsSync(matchesPath)) {
    console.error('data/matches.json not found. Run `npm run fetch-match-details` first.');
    process.exit(1);
}

const matches = JSON.parse(fs.readFileSync(matchesPath, 'utf-8'));
const results = getMatchupsAgainst(matches, opponentChampion);

if (results.length === 0) {
    console.log(`No recorded games against ${opponentChampion}.`);
} else {
    console.log(`Your history vs ${opponentChampion}:\n`);
    for (const r of results) {
        console.log(`  ${r.myChampion.padEnd(15)} ${r.winRate}% (${r.wins}/${r.games})`);
    }
}