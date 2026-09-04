// lib/riotApi.js
//
// Shared helper for Riot's public Web API (not the LCU - this is the real
// internet-facing, officially documented one, keyed by Riot ID / PUUID).
// 
// Account and Match APIs use "continent" routing, not the per-server routing
// (na1, euw1, etc.) you might expect - hence the region map below.

const BASE_URL_BY_REGION = {
    americas: 'https://americas.api.riotgames.com',
    europe: 'https://europe.api.riotgames.com',
    asia: 'https://asia.api.riotgames.com'
};

function getApiKey() {
    const key = process.env.RIOT_API_KEY;
    if (!key) {
        throw new Error('RIOT_API_KEY not set. Copy .env.example to .env and fill it in.');
    }
    return key;
}

async function riotRequest(path, region = 'americas') {
    const base = BASE_URL_BY_REGION[region];
    if (!base) {
        throw new Error(`Unknown region "${region}". Use one of: americas, europe, asia.`);
    }

    const res = await fetch(`${base}${path}`, {
        headers: {'X-Riot-Token': getApiKey() }
    });

    if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || 5;
        const err = new Error(`Rate limited by Riot API. Retry after ${retryAfter}s.`);
        err.code = 'RATE_LIMITED';
        err.retryAfter = retryAfter;
        throw err;
    }

    if (!res.ok) {
        throw new Error(`Riot API error ${res.status}: ${await res.text()}`);
    }

    return res.json();
}

module.exports = { riotRequest };