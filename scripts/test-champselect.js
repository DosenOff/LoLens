// scripts/test-champselect.js
//
// Objective: read live champion select state and print a human-readable summary.
// Run this WHILE you're actually in champion select (custom game, Draft Pick).
//
// Run with: node scripts/test-champselect.js

const { getCredentials, lcuRequest } = require('../lib/lcu');
const { championName } = require('../lib/championData');

function summarizeTeam(label, team) {
    console.log(`\n${label}`);
    for (const player of team) {
    const name = championName(player.championId) || '(none picked yet)';
    const pos = player.assignedPosition || '(unassigned)';
    console.log(`  cell ${player.cellId} — ${pos.padEnd(10)} — ${name}`);
    }
}

(async () => {
    try {
    const creds = getCredentials();
    console.log('Connected. Requesting champ select session...');

    const { statusCode, data } = await lcuRequest('/lol-champ-select/v1/session', creds);

    if (statusCode === 404) {
        console.log('\nNot currently in champion select (got 404).');
        console.log('Start a custom game (Draft Pick) and get into champ select, then rerun this.');
        return;
    }

    console.log(`\nPhase: ${data.timer.phase} — ${Math.round(data.timer.adjustedTimeLeftInPhase / 1000)}s left`);
    console.log(`Your cell ID: ${data.localPlayerCellId}`);

    summarizeTeam('MY TEAM', data.myTeam);
    summarizeTeam('THEIR TEAM', data.theirTeam);
    } catch (err) {
    if (err.message.includes('champions.json')) {
        console.error(`\n${err.message}`);
    } else if (err.code === 'ENOENT') {
        console.error('\nCould not find the lockfile. Is League actually open?');
    } else {
        console.error('\nRequest failed:', err.message);
    }
    }
})();