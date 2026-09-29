// lib/matchSync.js
//
// Pulls a player's ranked match history from the LoLens website's
// /api/matches endpoint (which holds the Riot API key - the app never
// does) and stores it in Electron's per-user userData folder as
// matches.json, the same shape the rest of the app already reads.
//
// Incremental: matches already stored are skipped, and a sync stops as
// soon as a whole page contains nothing new, so re-syncing on every app
// launch is cheap after the first time.
//
// Two-stage by design: the first page doubles as "is this Riot ID real?"
// and calls onVerified as soon as it succeeds, so callers can save the ID
// and move on while the remaining pages keep downloading in the background.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Swap for the real domain once it's live.
const API_BASE = 'https://www.lolens.gg';

const PAGE_SIZE = 10;            // must be <= the endpoint's MAX_PAGE_SIZE
const MAX_GAMES = 100;           // how deep the first sync goes
const PAGE_DELAY_MS = 1500;      // gentle pacing between pages
const MAX_RETRIES_PER_PAGE = 3;  // rate-limit retries before giving up

function matchesPath() {
    return path.join(app.getPath('userData'), 'matches.json');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadMatches() {
    try {
        const parsed = JSON.parse(fs.readFileSync(matchesPath(), 'utf-8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// Write to a temp file then rename, so a crash mid-write can't leave a
// half-written matches.json behind.
function saveMatches(list) {
    const target = matchesPath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, target);
}

async function fetchPage({ gameName, tagLine, region }, start) {
    const url =
        `${API_BASE}/api/matches` +
        `?gameName=${encodeURIComponent(gameName)}` +
        `&tagLine=${encodeURIComponent(tagLine)}` +
        `&region=${encodeURIComponent(region)}` +
        `&start=${start}&count=${PAGE_SIZE}`;

    let res;
    try {
        res = await fetch(url);
    } catch {
        const err = new Error('network');
        err.userMessage = "Couldn't reach the LoLens server. Check your internet connection.";
        throw err;
    }

    const body = await res.json().catch(() => ({}));

    if (res.status === 429) {
        const err = new Error('rate limited');
        err.rateLimited = true;
        err.retryAfter = Number(body.retryAfter) || Number(res.headers.get('retry-after')) || 30;
        throw err;
    }
    if (res.status === 404) {
        const err = new Error('not found');
        err.userMessage = "We couldn't find that Riot ID in that region. Check the spelling, tag, and region.";
        throw err;
    }
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.userMessage = 'The LoLens server had a problem. Try again in a moment.';
        throw err;
    }
    return body;
}

// riotId: { gameName, tagLine, region }
// onProgress: optional callback({ phase, fetched, total, seconds })
// opts.replace: true when the Riot ID changed - ignore stored games and
// overwrite them. Nothing on disk is touched until the first page comes
// back successfully, so a typo'd ID (404) leaves the old data intact.
// opts.onVerified: optional callback({ total, added, hasMore }), called once,
// right after the first page has been fetched and saved. That's the point
// where the Riot ID is known to be real; the rest of the sync continues
// after it returns.
async function syncMatches(riotId, onProgress, { replace = false, onVerified } = {}) {
    const existing = replace ? [] : loadMatches();
    const known = new Set(existing.map((m) => m.matchId));
    let all = [...existing];
    let added = 0;

    for (let start = 0; start < MAX_GAMES; start += PAGE_SIZE) {
        let page;
        for (let attempt = 0; ; attempt++) {
            try {
                page = await fetchPage(riotId, start);
                break;
            } catch (err) {
                if (err.rateLimited && attempt < MAX_RETRIES_PER_PAGE) {
                    if (onProgress) onProgress({ phase: 'waiting', seconds: err.retryAfter, fetched: added, total: all.length });
                    await sleep(err.retryAfter * 1000);
                    continue;
                }
                if (err.rateLimited) {
                    err.userMessage = 'LoLens is busy right now. Try again in a few minutes.';
                }
                throw err;
            }
        }

        const fresh = (page.matches || []).filter((m) => !known.has(m.matchId));
        for (const m of fresh) known.add(m.matchId);
        all.push(...fresh);
        added += fresh.length;

        all.sort((a, b) => b.gameCreation - a.gameCreation);
        saveMatches(all); // save every page, so partial progress survives a quit
        if (onProgress) onProgress({ phase: 'fetching', fetched: added, total: all.length });

        if (start === 0 && onVerified) {
            onVerified({ total: all.length, added, hasMore: Boolean(page.hasMore) });
        }

        if (!page.hasMore) break;
        // Already-synced player and this whole page was old news: caught up.
        if (existing.length > 0 && fresh.length === 0) break;

        await sleep(PAGE_DELAY_MS);
    }

    return { total: all.length, added };
}

module.exports = { syncMatches, loadMatches };