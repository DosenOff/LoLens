// scripts/fetch-population-data.js
//
// Builds a rank-specific champion win rate baseline from Riot's own data.
//
// IMPORTANT METHODOLOGY NOTE:
// We only count each seed player's OWN game result, not all 10 participants
// in their matches. Match-v5 doesn't tell you the rank of the other 9
// players in a match - only the seed player's rank is actually known
// (because we sampled them from a specific league-v4 tier/division).
// Labeling all 10 as that tier would be a real accuracy bug, not a shortcut.
//
// This means: 1 fetched match = 1 rank-labeled observation, not 10.
// It's slower than the naive approach, but the numbers actually mean
// what they claim to mean.
//
// Run with: npm run fetch-population-data

const fs = require('fs');
const path = require('path');
const { riotRequest, riotPlatformRequest } = require('../lib/riotApi');

const PLATFORM = process.env.RIOT_PLATFORM || 'na1';
const REGION = process.env.RIOT_REGION || 'americas';
const PLAYERS_PER_TIER = Number(process.env.POP_PLAYERS_PER_TIER || 50);
// This is a TARGET, not a one-time fetch count. Rerunning the script with a
// higher number here will top up existing players with more games rather
// than starting over - see processSeedPlayer below.
const GAMES_PER_PLAYER_TARGET = Number(process.env.POP_GAMES_PER_PLAYER || 1);
const DELAY_MS = 1200;
const QUEUE = 'RANKED_SOLO_5x5';

const DIVISIONAL_TIERS = ['EMERALD', 'DIAMOND']; // add PLATINUM, GOLD, etc. if you want more buckets
// Each tier gets split into two buckets instead of four flat divisions:
// I/II (top two divisions) -> "+" suffix, III/IV (bottom two) -> no suffix.
// e.g. EMERALD I/II -> "EMERALD+", EMERALD III/IV -> "EMERALD"
const DIVISION_GROUPS = [
    { suffix: '+', romanNumerals: ['I', 'II'] },
    { suffix: '', romanNumerals: ['III', 'IV'] }
];

const statePath = path.join(__dirname, '..', 'data', 'population-state.json');
const outputPath = path.join(__dirname, '..', 'data', 'population-stats.json');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadState() {
    if (fs.existsSync(statePath)) {
        return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    return { seenPuuids: [], seenMatchIds: [] };
}

function saveState(state) {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function loadStats() {
    if (fs.existsSync(outputPath)) {
        const loaded = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
        // Backward compatible: older data files won't have these yet.
        if (!loaded.matchups) loaded.matchups = {};
        if (!loaded.synergies) loaded.synergies = {};
        return loaded;
    }
    return { capturedAt: null, tiers: {}, matchups: {}, synergies: {} };
}

function saveStats(stats) {
    stats.capturedAt = new Date().toISOString();
    fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2));
}

function recordResult(stats, tier, championName, win) {
    if (!stats.tiers[tier]) stats.tiers[tier] = {};
    if (!stats.tiers[tier][championName]) {
        stats.tiers[tier][championName] = { games: 0, wins: 0 };
    }
    stats.tiers[tier][championName].games += 1;
    if (win) stats.tiers[tier][championName].wins += 1;
}

function recordMatchup(stats, tier, championName, enemyChampionName, win) {
    if (!enemyChampionName) return;
    if (!stats.matchups[tier]) stats.matchups[tier] = {};
    if (!stats.matchups[tier][championName]) stats.matchups[tier][championName] = {};
    if (!stats.matchups[tier][championName][enemyChampionName]) {
        stats.matchups[tier][championName][enemyChampionName] = { games: 0, wins: 0 };
    }
    stats.matchups[tier][championName][enemyChampionName].games += 1;
    if (win) stats.matchups[tier][championName][enemyChampionName].wins += 1;
}

function recordSynergy(stats, tier, championName, allyChampionName, win) {
    if (!allyChampionName) return;
    if (!stats.synergies[tier]) stats.synergies[tier] = {};
    if (!stats.synergies[tier][championName]) stats.synergies[tier][championName] = {};
    if (!stats.synergies[tier][championName][allyChampionName]) {
        stats.synergies[tier][championName][allyChampionName] = { games: 0, wins: 0 };
    }
    stats.synergies[tier][championName][allyChampionName].games += 1;
    if (win) stats.synergies[tier][championName][allyChampionName].wins += 1;
}

async function getSeedPlayersForDivisionGroup(tier, romanNumerals, count) {
    const perDivision = Math.ceil(count / romanNumerals.length);
    const players = [];

    for (const division of romanNumerals) {
        // Randomize the page so repeated runs sample different players instead
        // of always hitting the same top-of-the-list names. Pages beyond the
        // real data just return an empty array - harmless if we guess too high.
        const page = 1 + Math.floor(Math.random() * 10);
        console.log(`  Fetching ${tier} ${division} (page ${page})...`);
        let entries = await riotPlatformRequest(
            `/lol/league/v4/entries/${QUEUE}/${tier}/${division}?page=${page}`,
            PLATFORM
        );
        await sleep(DELAY_MS);

        // If we guessed a page beyond the real data, fall back to page 1
        // rather than silently getting zero players for this division.
        if (entries.length === 0 && page !== 1) {
            console.log(`    Page ${page} was empty, falling back to page 1...`);
            entries = await riotPlatformRequest(
                `/lol/league/v4/entries/${QUEUE}/${tier}/${division}?page=1`,
                PLATFORM
            );
            await sleep(DELAY_MS);
        }

        players.push(...entries.slice(0, perDivision));
    }

    return players.slice(0, count);
}

async function getSeedPlayersForApexTiers(count) {
    console.log('  Fetching Challenger/Grandmaster/Master...');
    const [challenger, grandmaster, master] = await Promise.all([
        riotPlatformRequest(`/lol/league/v4/challengerleagues/by-queue/${QUEUE}`, PLATFORM),
        riotPlatformRequest(`/lol/league/v4/grandmasterleagues/by-queue/${QUEUE}`, PLATFORM),
        riotPlatformRequest(`/lol/league/v4/masterleagues/by-queue/${QUEUE}`, PLATFORM)
    ]);
    await sleep(DELAY_MS);

    const combined = [...challenger.entries, ...grandmaster.entries, ...master.entries];
    // Shuffle lightly so we're not only sampling the very top of Challenger every time.
    combined.sort(() => Math.random() - 0.5);
    return combined.slice(0, count);
}

async function resolvePuuid(entry) {
    if (entry.puuid) return entry.puuid;

    const summonerId = entry.summonerId;
    if (!summonerId) return null;

    try {
        const summoner = await riotPlatformRequest(`/lol/summoner/v4/summoners/${summonerId}`, PLATFORM);
        await sleep(DELAY_MS);
        return summoner.puuid || null;
    } catch (err) {
        console.log(`    Could not resolve puuid for a seed player: ${err.message}`);
        return null;
    }
}

async function processSeedPlayer(puuid, tierLabel, stats, state) {
    if (!state.playerGameCounts) state.playerGameCounts = {};
    const alreadyCounted = state.playerGameCounts[puuid] || 0;

    if (alreadyCounted >= GAMES_PER_PLAYER_TARGET) {
        return; // already deep enough for this player at the current target
    }

    let matchIds;
    try {
        matchIds = await riotRequest(
            `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&count=${GAMES_PER_PLAYER_TARGET}`,
            REGION
        );
        await sleep(DELAY_MS);
    } catch (err) {
        console.log(`    Failed to get match list for a seed player: ${err.message}`);
        return;
    }

    for (const matchId of matchIds) {
        if (state.seenMatchIds.includes(matchId)) continue; // avoid double-counting

        try {
            const matchData = await riotRequest(`/lol/match/v5/matches/${matchId}`, REGION);
            const participants = matchData.info.participants;
            const me = participants.find((p) => p.puuid === puuid);

            if (me) {
                recordResult(stats, tierLabel, me.championName, me.win);
                state.playerGameCounts[puuid] = (state.playerGameCounts[puuid] || 0) + 1;

                if (me.teamPosition) {
                    const enemyLaner = participants.find(
                        (p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition
                    );
                    if (enemyLaner) {
                        recordMatchup(stats, tierLabel, me.championName, enemyLaner.championName, me.win);
                    }
                }

                const allies = participants.filter((p) => p.teamId === me.teamId && p.puuid !== me.puuid);
                for (const ally of allies) {
                    recordSynergy(stats, tierLabel, me.championName, ally.championName, me.win);
                }
            }
            state.seenMatchIds.push(matchId);
            await sleep(DELAY_MS);
        } catch (err) {
            if (err.code === 'RATE_LIMITED') {
                console.log(`    Rate limited, waiting ${err.retryAfter}s...`);
                await sleep(err.retryAfter * 1000);
            } else {
                console.log(`    Failed on match ${matchId}: ${err.message}`);
            }
        }
    }

    if (!state.seenPuuids.includes(puuid)) state.seenPuuids.push(puuid);
}

(async () => {
    const stats = loadStats();
    const state = loadState();

    console.log(`Sampling ~${PLAYERS_PER_TIER} players per tier, targeting ${GAMES_PER_PLAYER_TARGET} games each.\n`);

    const tierBuckets = [];

    for (const tier of DIVISIONAL_TIERS) {
        for (const group of DIVISION_GROUPS) {
            const bucketLabel = `${tier}${group.suffix}`;
            console.log(`Collecting seed players for ${bucketLabel}...`);
            const entries = await getSeedPlayersForDivisionGroup(tier, group.romanNumerals, PLAYERS_PER_TIER);
            tierBuckets.push({ label: bucketLabel, entries });
        }
    }

    console.log('Collecting seed players for MASTER_PLUS...');
    const apexEntries = await getSeedPlayersForApexTiers(PLAYERS_PER_TIER);
    tierBuckets.push({ label: 'MASTER_PLUS', entries: apexEntries });

    for (const bucket of tierBuckets) {
        console.log(`\nProcessing ${bucket.label} (${bucket.entries.length} seed players)...`);
        let alreadyAtTargetCount = 0;
        let newlyProcessedCount = 0;

        for (let i = 0; i < bucket.entries.length; i++) {
            const puuid = await resolvePuuid(bucket.entries[i]);
            if (!puuid) continue;

            const priorCount = (state.playerGameCounts && state.playerGameCounts[puuid]) || 0;
            if (priorCount >= GAMES_PER_PLAYER_TARGET) {
                alreadyAtTargetCount++;
            } else {
                newlyProcessedCount++;
            }

            console.log(`  [${i + 1}/${bucket.entries.length}] processing seed player...`);
            await processSeedPlayer(puuid, bucket.label, stats, state);

            // Save progress after every player, not just at the end.
            saveStats(stats);
            saveState(state);
        }

        // If most of this batch was already-seen players at target depth, the
        // available pool for this bucket may be running thin (this is expected
        // and normal for MASTER_PLUS - it's a small, fixed population - but
        // shouldn't really happen for the larger divisional tiers).
        const totalSeen = alreadyAtTargetCount + newlyProcessedCount;
        if (totalSeen > 0 && alreadyAtTargetCount / totalSeen > 0.5) {
            console.log(
                `  Note: ${alreadyAtTargetCount}/${totalSeen} players in ${bucket.label} were already at target depth. ` +
                `This tier's sampled pool may be getting saturated - consider raising POP_GAMES_PER_PLAYER ` +
                `for more depth rather than expecting more new players.`
            );
        }
    }

    console.log('\nDone. Results:');
    for (const [tier, champs] of Object.entries(stats.tiers)) {
        for (const [champion, data] of Object.entries(champs)) {
            console.log(`  ${tier} - ${champion}: ${data.games} games`);
        }
    }

    let matchupPairs = 0;
    for (const champs of Object.values(stats.matchups)) {
        for (const enemies of Object.values(champs)) {
            matchupPairs += Object.keys(enemies).length;
        }
    }
    let synergyPairs = 0;
    for (const champs of Object.values(stats.synergies)) {
        for (const allies of Object.values(champs)) {
            synergyPairs += Object.keys(allies).length;
        }
    }
    console.log(`\nMatchup pairs recorded: ${matchupPairs}`);
    console.log(`Synergy pairs recorded: ${synergyPairs}`);
    console.log(`(Note: these only include matches fetched since this feature was added)`);

    console.log(`\nTotal players logged (all time): ${state.seenPuuids.length}`);
    console.log(`Saved to data/population-stats.json`);
})();