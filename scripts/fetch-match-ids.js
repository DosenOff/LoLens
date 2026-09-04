// scripts/fetch-match-ids.js
//
// Objective: get your PUUID from your Riot ID, then fetch your recent
// match ID list. This is the first real step toward personal match history.
//
// Run with: npm run fetch-match-ids
// (that script alias includes --env-file=.env so your API key loads automatically)

const fs = require('fs');
const path = require('path');
const { riotRequest } = require('../lib/riotApi');

const GAME_NAME = process.env.RIOT_GAME_NAME;
const TAG_LINE = process.env.RIOT_TAG_LINE;
const REGION = process.env.RIOT_REGION || 'americas';
const MATCH_COUNT = Number(process.env.MATCH_COUNT || 100);

(async () => {
    if (!GAME_NAME || !TAG_LINE) {
        console.error('Set RIOT_GAME_NAME and RIOT_TAG_LINE in your .env file.');
        process.exit(1);
    }

    try {
        console.log(`Looking up account: ${GAME_NAME}#${TAG_LINE} (${REGION})...`);
        const account = await riotRequest(
            `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(GAME_NAME)}/${encodeURIComponent(TAG_LINE)}`,
            REGION
        );
        console.log('Found account. PUUID:', account.puuid);

        console.log(`\nFetching up to ${MATCH_COUNT} recent match IDs...`);
        const matchIds = await riotRequest(
            `/lol/match/v5/matches/by-puuid/${account.puuid}/ids?start=0&count=${MATCH_COUNT}`,
            REGION
        );
        console.log(`Got ${matchIds.length} match IDs.`);

        const outDir = path.join(__dirname, '..', 'data');
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(
            path.join(outDir, 'match-ids.json'),
            JSON.stringify({ puuid: account.puuid, matchIds }, null, 2)
        );
        console.log('\nSaved to data/match-ids.json');
    } catch (err) {
        if (err.code === 'RATE_LIMITED') {
            console.error(`\nRate limited. Wait ${err.retryAfter}s and try again.`);
        } else {
            console.error('\nFailed:', err.message);
        }
    }
})();