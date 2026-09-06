// lib/riotApi.js
//
// Shared helper for Riot's public Web API (not the LCU - this is the real
// internet-facing, officially documented one, keyed by Riot ID / PUUID).
//
// Riot's API has two different routing schemes, and this file supports both:
//   - "Continent" routing (americas/europe/asia) - used by account-v1, match-v5
//   - "Platform" routing (na1/euw1/kr/etc) - used by league-v4, summoner-v4
// Mixing these up is a common mistake - a league-v4 call to "americas" or a
// match-v5 call to "na1" will simply fail.

const CONTINENT_BASE_URL = {
    americas: 'https://americas.api.riotgames.com',
    europe: 'https://europe.api.riotgames.com',
    asia: 'https://asia.api.riotgames.com'
};

const PLATFORM_BASE_URL = {
    na1: 'https://na1.api.riotgames.com',
    euw1: 'https://euw1.api.riotgames.com',
    eun1: 'https://eun1.api.riotgames.com',
    kr: 'https://kr.api.riotgames.com',
    jp1: 'https://jp1.api.riotgames.com',
    br1: 'https://br1.api.riotgames.com',
    la1: 'https://la1.api.riotgames.com',
    la2: 'https://la2.api.riotgames.com',
    oc1: 'https://oc1.api.riotgames.com',
    tr1: 'https://tr1.api.riotgames.com',
    ru: 'https://ru.api.riotgames.com'
};

function getApiKey() {
    const key = process.env.RIOT_API_KEY;
    if (!key) {
        throw new Error('RIOT_API_KEY not set. Copy .env.example to .env and fill it in.');
    }
    return key;
}

async function makeRequest(base, path) {
    const res = await fetch(`${base}${path}`, {
        headers: { 'X-Riot-Token': getApiKey() }
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

// For account-v1 and match-v5 (Riot ID lookup, match history)
async function riotRequest(path, region = 'americas') {
    const base = CONTINENT_BASE_URL[region];
    if (!base) {
        throw new Error(`Unknown region "${region}". Use one of: americas, europe, asia.`);
    }
    return makeRequest(base, path);
}

// For league-v4 and summoner-v4 (ranked tier/division data, summoner lookups)
async function riotPlatformRequest(path, platform = 'na1') {
    const base = PLATFORM_BASE_URL[platform];
    if (!base) {
        throw new Error(`Unknown platform "${platform}". Use one of: ${Object.keys(PLATFORM_BASE_URL).join(', ')}.`);
    }
    return makeRequest(base, path);
}

module.exports = { riotRequest, riotPlatformRequest };