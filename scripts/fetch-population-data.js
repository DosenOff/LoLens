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
// PATCH/DATE TRACKING:
// Every result is now tagged with the patch it was played on
// (matchData.info.gameVersion, truncated to "major.minor", e.g. "15.18")
// and the calendar date it was played (matchData.info.gameCreation, as a
// UTC "YYYY-MM-DD" string). This only applies to the main tier baseline
// (stats.tiers) - matchup/synergy data stays all-time, see the scope note
// in lib/populationStats.js. byDate buckets older than DATE_BUCKET_RETENTION_DAYS
// are pruned on every save so the file doesn't grow forever; byPatch
// buckets are kept indefinitely since there are only a handful of patches
// a year.
//
// USAGE:
//   npm run fetch-population-data                        -> full sweep (all brackets), .env defaults
//   npm run fetch-population-data -- diamond 100 5        -> just Diamond III/IV, 100 players, 5 games each
//   npm run fetch-population-data -- diamond+ 100 5       -> just Diamond I/II
//   npm run fetch-population-data -- diamond "" 5         -> just Diamond III/IV, PLAYERS from .env, 5 games each
//   npm run fetch-population-data -- --help
//
// (the "--" is required so npm hands these args to the script, not itself)

const fs = require('fs');
const path = require('path');
const { riotRequest, riotPlatformRequest } = require('../lib/riotApi');

const PLATFORM = process.env.RIOT_PLATFORM || 'na1';
const REGION = process.env.RIOT_REGION || 'americas';
const DELAY_MS = 1200;
const QUEUE = 'RANKED_SOLO_5x5';
const DATE_BUCKET_RETENTION_DAYS = 90;

// Every bucket we know how to fetch. A "bracket" CLI arg selects exactly
// one of these; omitting it processes all of them (the old default sweep).
const BUCKET_DEFINITIONS = [
    { label: 'EMERALD+', tier: 'EMERALD', romanNumerals: ['I', 'II'] },
    { label: 'EMERALD', tier: 'EMERALD', romanNumerals: ['III', 'IV'] },
    { label: 'DIAMOND+', tier: 'DIAMOND', romanNumerals: ['I', 'II'] },
    { label: 'DIAMOND', tier: 'DIAMOND', romanNumerals: ['III', 'IV'] },
    { label: 'MASTER_PLUS', apex: true }
];

const statePath = path.join(__dirname, '..', 'data', 'population-state.json');
const outputPath = path.join(__dirname, '..', 'data', 'population-stats.json');

function printUsageAndExit(code) {
    console.log(`
Usage: npm run fetch-population-data -- [bracket] [playersPerTier] [gamesPerPlayer]

  bracket          One of: ${BUCKET_DEFINITIONS.map((b) => b.label.toLowerCase()).join(', ')}, or "all" (default)
  playersPerTier   Overrides POP_PLAYERS_PER_TIER from .env for this run
  gamesPerPlayer   Overrides POP_GAMES_PER_PLAYER from .env for this run

  Leave a field empty ("") to fall through to its .env default while still
  setting a later field. All three are optional - with none given, this
  behaves exactly like the old full sweep.

Examples:
  npm run fetch-population-data -- diamond 100 5
  npm run fetch-population-data -- diamond+ 100 5
  npm run fetch-population-data -- diamond "" 5
  npm run fetch-population-data
`);
    process.exit(code);
}

function normalizeBracketArg(raw) {
    if (!raw || raw.trim() === '') return null;
    const cleaned = raw.trim().toUpperCase();
    if (cleaned === 'ALL') return 'ALL';
    if (cleaned === 'MASTER+' || cleaned === 'MASTERPLUS' || cleaned === 'MASTER_PLUS') return 'MASTER_PLUS';
    return cleaned; // e.g. "DIAMOND", "DIAMOND+", "EMERALD", "EMERALD+"
}

function parseOverrideInt(raw, envVar, fallback) {
    if (raw !== undefined && raw.trim() !== '') {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
            console.error(`Invalid value "${raw}" - expected a positive whole number.`);
            process.exit(1);
        }
        return parsed;
    }
    return Number(process.env[envVar] || fallback);
}

const [rawBracket, rawPlayers, rawGames] = process.argv.slice(2);

if (rawBracket && ['--help', '-h', 'help'].includes(rawBracket.trim().toLowerCase())) {
    printUsageAndExit(0);
}

const targetBracket = normalizeBracketArg(rawBracket);
const PLAYERS_PER_TIER = parseOverrideInt(rawPlayers, 'POP_PLAYERS_PER_TIER', 50);
// This is a TARGET, not a one-time fetch count. Rerunning the script with a
// higher number here will top up existing players with more games rather
// than starting over - see processSeedPlayer below.
const GAMES_PER_PLAYER_TARGET = parseOverrideInt(rawGames, 'POP_GAMES_PER_PLAYER', 1);

let bucketsToProcess;
if (!targetBracket || targetBracket === 'ALL') {
    bucketsToProcess = BUCKET_DEFINITIONS;
} else {
    const match = BUCKET_DEFINITIONS.find((b) => b.label === targetBracket);
    if (!match) {
        console.error(`Unknown bracket "${rawBracket}".`);
        printUsageAndExit(1);
    }
    bucketsToProcess = [match];
}

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

// Drops byDate buckets older than DATE_BUCKET_RETENTION_DAYS across every
// tier/champion so the file doesn't grow forever. byPatch buckets are
// untouched - there are only a handful of patches a year, so keeping all
// of them indefinitely is cheap and lets the settings page offer "any
// patch we've ever sampled", not just recent ones.
function pruneOldDateBuckets(stats) {
    const cutoff = Date.now() - DATE_BUCKET_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const champs of Object.values(stats.tiers || {})) {
        for (const entry of Object.values(champs)) {
            if (!entry.byDate) continue;
            for (const dateStr of Object.keys(entry.byDate)) {
                if (new Date(`${dateStr}T00:00:00Z`).getTime() < cutoff) {
                    delete entry.byDate[dateStr];
                }
            }
        }
    }
}

function saveStats(stats) {
    pruneOldDateBuckets(stats);
    stats.capturedAt = new Date().toISOString();
    fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2));
}

// patch: "15.18"-style string, derived from matchData.info.gameVersion.
// dateStr: "YYYY-MM-DD" UTC, derived from matchData.info.gameCreation.
function recordResult(stats, tier, championName, win, patch, dateStr) {
    if (!stats.tiers[tier]) stats.tiers[tier] = {};
    if (!stats.tiers[tier][championName]) {
        stats.tiers[tier][championName] = { games: 0, wins: 0, byPatch: {}, byDate: {} };
    }
    const entry = stats.tiers[tier][championName];

    entry.games += 1;
    if (win) entry.wins += 1;

    if (patch) {
        if (!entry.byPatch[patch]) entry.byPatch[patch] = { games: 0, wins: 0 };
        entry.byPatch[patch].games += 1;
        if (win) entry.byPatch[patch].wins += 1;
    }

    if (dateStr) {
        if (!entry.byDate[dateStr]) entry.byDate[dateStr] = { games: 0, wins: 0 };
        entry.byDate[dateStr].games += 1;
        if (win) entry.byDate[dateStr].wins += 1;
    }
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

// ---- run-scoped diff helpers ----
//
// loadStats() returns the whole all-time file. To report "what did THIS
// invocation actually add" rather than "here's the entire file's history",
// snapshot the relevant counts before touching anything, then diff against
// the same shape after. Kept intentionally dumb (counts only, no need to
// diff win/loss separately for a progress summary).

// stats.tiers is tier -> champion -> {games, wins, byPatch, byDate}.
function snapshotTierGames(tiers) {
    const snapshot = {};
    for (const [tier, champs] of Object.entries(tiers || {})) {
        snapshot[tier] = {};
        for (const [champion, data] of Object.entries(champs)) {
            snapshot[tier][champion] = data.games;
        }
    }
    return snapshot;
}

// stats.matchups / stats.synergies are tier -> champion -> opponent/ally ->
// {games, wins} (3 levels deep).
function sumNestedGames(obj) {
    let total = 0;
    for (const champs of Object.values(obj || {})) {
        for (const others of Object.values(champs)) {
            for (const entry of Object.values(others)) {
                total += entry.games;
            }
        }
    }
    return total;
}

function countNestedPairs(obj) {
    let count = 0;
    for (const champs of Object.values(obj || {})) {
        for (const others of Object.values(champs)) {
            count += Object.keys(others).length;
        }
    }
    return count;
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

async function getSeedPlayersForBucket(def, count) {
    if (def.apex) {
        console.log('Collecting seed players for MASTER_PLUS...');
        return getSeedPlayersForApexTiers(count);
    }
    console.log(`Collecting seed players for ${def.label}...`);
    return getSeedPlayersForDivisionGroup(def.tier, def.romanNumerals, count);
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

// gameVersion looks like "15.18.123.456" - "major.minor" is what people
// mean by "the patch" (15.18.1 and 15.18.2 hotfixes are the same patch
// for balance purposes).
function patchFromGameVersion(gameVersion) {
    if (!gameVersion) return null;
    const parts = gameVersion.split('.');
    if (parts.length < 2) return null;
    return `${parts[0]}.${parts[1]}`;
}

function dateStrFromGameCreation(gameCreation) {
    if (!gameCreation) return null;
    return new Date(gameCreation).toISOString().slice(0, 10);
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
                const patch = patchFromGameVersion(matchData.info.gameVersion);
                const dateStr = dateStrFromGameCreation(matchData.info.gameCreation);

                recordResult(stats, tierLabel, me.championName, me.win, patch, dateStr);
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

    // Snapshot before this run touches anything - see the diff helpers above.
    const beforeTierGames = snapshotTierGames(stats.tiers);
    const beforeMatchupGames = sumNestedGames(stats.matchups);
    const beforeSynergyGames = sumNestedGames(stats.synergies);
    const beforeMatchupPairs = countNestedPairs(stats.matchups);
    const beforeSynergyPairs = countNestedPairs(stats.synergies);
    const seenPuuidsBefore = state.seenPuuids.length;

    console.log(`Bracket(s): ${bucketsToProcess.map((b) => b.label).join(', ')}`);
    console.log(`Sampling ~${PLAYERS_PER_TIER} players per tier, targeting ${GAMES_PER_PLAYER_TARGET} games each.\n`);

    const tierBuckets = [];

    for (const def of bucketsToProcess) {
        const entries = await getSeedPlayersForBucket(def, PLAYERS_PER_TIER);
        tierBuckets.push({ label: def.label, entries });
    }

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
                `This tier's sampled pool may be getting saturated - consider raising the games-per-player target ` +
                `for more depth rather than expecting more new players.`
            );
        }
    }

    // ---- summary: only what THIS run added, not the whole file's history ----

    console.log('\nDone. Added this run:');
    let anyChampionGamesAdded = false;
    for (const [tier, champs] of Object.entries(stats.tiers)) {
        for (const [champion, data] of Object.entries(champs)) {
            const before = (beforeTierGames[tier] && beforeTierGames[tier][champion]) || 0;
            const added = data.games - before;
            if (added > 0) {
                anyChampionGamesAdded = true;
                console.log(`  ${tier} - ${champion}: +${added} games (${data.games} total)`);
            }
        }
    }
    if (!anyChampionGamesAdded) {
        console.log('  (no new games added - every sampled player was already at the target depth for this bracket)');
    }

    const matchupGamesAdded = sumNestedGames(stats.matchups) - beforeMatchupGames;
    const synergyGamesAdded = sumNestedGames(stats.synergies) - beforeSynergyGames;
    const matchupPairsAdded = countNestedPairs(stats.matchups) - beforeMatchupPairs;
    const synergyPairsAdded = countNestedPairs(stats.synergies) - beforeSynergyPairs;

    console.log(`\nMatchup games added this run: ${matchupGamesAdded} (${matchupPairsAdded} new matchup pairs)`);
    console.log(`Synergy games added this run: ${synergyGamesAdded} (${synergyPairsAdded} new synergy pairs)`);
    console.log(`(Note: matchup/synergy tracking only covers matches fetched since that feature was added)`);

    console.log(`\nNew players logged this run: ${state.seenPuuids.length - seenPuuidsBefore}`);
    console.log(`Total players logged (all time): ${state.seenPuuids.length}`);
    console.log(`Saved to data/population-stats.json`);
})();