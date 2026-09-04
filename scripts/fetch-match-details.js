// scripts/fetch-match-details.js
//
// Objective: turn our list of match IDs into actual usable data - your
// champion, your lane, win/loss, and who you faced in that lane.
//
// This is slower than the last script on purpose: one API call per match,
// with a delay between calls to respect Riot's rate limit (100 requests
// per 2 minutes). It's safe to stop and rerun - already-fetched matches
// are skipped, so you're only ever paying the rate-limit cost once per match.
//
// Run with: npm run fetch-match-details

const fs = require('fs');
const path = require('path');
const { riotRequest } = require('../lib/riotApi');

const REGION = process.env.RIOT_REGION || 'americas';
const DELAY_MS = 1200; // keeps us comfortably under 100 req / 2 min

const matchIdsPath = path.join(__dirname, '..', 'data', 'match-ids.json');
const outputPath = path.join(__dirname, '..', 'data', 'matches.json');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRelevantData(matchData, myPuuid) {
    const participants = matchData.info.participants;
    const me = participants.find((p) => p.puuid === myPuuid);
    if (!me || !me.teamPosition) return null; // skip ARAM/modes with no lane data

    const opponent = participants.find(
        (p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition
    );

    return {
        matchId: matchData.metadata.matchId,
        gameCreation: matchData.info.gameCreation,
        myChampion: me.championName,
        myLane: me.teamPosition,
        win: me.win,
        opponentChampion: opponent ? opponent.championName : null
    };
}

(async () => {
    if (!fs.existsSync(matchIdsPath)) {
        console.error('data/match-ids.json not found. Run `npm run fetch-match-ids` first.');
        process.exit(1);
    }

    const { puuid, matchIds } = JSON.parse(fs.readFileSync(matchIdsPath, 'utf-8'));

    // Resume support: load whatever we've already handled (saved OR skipped),
    // so reruns don't waste rate-limit budget re-fetching matches we already
    // know are non-lane modes (ARAM, Arena, etc.).
    let existing = [];
    let skippedIds = [];
    if (fs.existsSync(outputPath)) {
        existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    }
    const skippedPath = path.join(__dirname, '..', 'data', 'skipped-match-ids.json');
    if (fs.existsSync(skippedPath)) {
        skippedIds = JSON.parse(fs.readFileSync(skippedPath, 'utf-8'));
    }

    const alreadyHandled = new Set([...existing.map((m) => m.matchId), ...skippedIds]);
    const remaining = matchIds.filter((id) => !alreadyHandled.has(id));

    console.log(
        `${existing.length} matches already fetched, ${skippedIds.length} already skipped (non-lane modes). ${remaining.length} remaining.`
    );

    const results = [...existing];
    const skipped = [...skippedIds];

    for (let i = 0; i < remaining.length; i++) {
        const matchId = remaining[i];
        try {
            console.log(`[${i + 1}/${remaining.length}] Fetching ${matchId}...`);
            const matchData = await riotRequest(`/lol/match/v5/matches/${matchId}`, REGION);
            const extracted = extractRelevantData(matchData, puuid);

            if (extracted) {
                results.push(extracted);
                fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
            } else {
                console.log(`  -> skipped (gameMode: ${matchData.info.gameMode}, no lane data)`);
                skipped.push(matchId);
                fs.writeFileSync(skippedPath, JSON.stringify(skipped, null, 2));
            }

            await sleep(DELAY_MS);
        } catch (err) {
            if (err.code === 'RATE_LIMITED') {
                console.log(`Rate limited, waiting ${err.retryAfter}s...`);
                await sleep(err.retryAfter * 1000);
                i--; // retry this same match ID
            } else {
                console.error(`Failed on ${matchId}: ${err.message} — skipping.`);
            }
        }
    }

    console.log(`\nDone. ${results.length} matches saved to data/matches.json (${skipped.length} total skipped as non-lane modes)`);
})();