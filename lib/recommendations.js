// lib/recommendations.js
//
// Ranks the user's champion pool for the current draft state.
//
// The formula is deliberately simple and fully explainable, not a tuned
// "black box" score:
//
//   score = population baseline WR
//         + (personal WR - baseline)   * weight(personal games)
//         + (avg counter WR - baseline) * weight(counter games)
//         + (avg synergy WR - baseline) * weight(synergy games)
//
// Each term is only added when real data supports it - a champion with no
// data just falls back to its baseline, it doesn't get penalized for
// missing data. Every component - including the individual per-champion
// counter/synergy rows, not just the average - is returned in the
// breakdown so the UI can show its work rather than just a mystery number.
//
// SAMPLE-SIZE WEIGHTING: personal/counter/synergy deltas are scaled by
// how many games back them - see confidenceWeight() below. The population
// baseline itself is never weighted this way; it's sampled from thousands
// of real games already (see scripts/fetch-population-data.js), so it
// doesn't carry the same small-sample risk. Both the raw delta and the
// weighted delta actually added to the score are returned in the
// breakdown, so nothing about the weighting is hidden.
//
// `filter` (optional patch/day filter - see lib/populationStats.js) only
// affects the baseline lookup. Matchup/synergy data stays all-time - see
// the scope note at the top of lib/populationStats.js.

const { getMatchupStats } = require('./matchupStats');
const {
    getPopulationStats,
    getPopulationMatchupStats,
    getPopulationSynergyStats
} = require('./populationStats');

function average(nums) {
    if (nums.length === 0) return null;
    return Math.round((nums.reduce((sum, n) => sum + n, 0) / nums.length) * 10) / 10;
}

// Weight scales with sample size up to full confidence.
// At the threshold, weight = 1; additional games do not amplify the delta.
//
// Square root gives diminishing returns: 25% of the threshold -> 50% weight,
// 50% -> 71%, 100% -> 100%.
//
// config is { enabled, threshold } for that stat, user-tunable from Settings.
// enabled:false (or a missing/invalid threshold) skips the penalty entirely
// and uses the raw delta as-is.
function confidenceWeight(n, config) {
    if (!n || n <= 0) return 0;
    if (!config || config.enabled === false) return 1;
    if (!config.threshold || config.threshold <= 0) return 1;
    return Math.min(1, Math.sqrt(n / config.threshold));
}

function scoreChampion(champion, { myMatches, populationStats, tier, enemyChampions, allyChampions, filter, confidenceWeighting }) {
    // One global setting applied uniformly to personal/counter/synergy -
    // see confidenceWeight() above. Never applied to the baseline anchor.
    const weighting = { enabled: true, threshold: 20, ...(confidenceWeighting || {}) };

    const baseline = getPopulationStats(populationStats, tier, champion, filter);
    const baselineWR = baseline ? baseline.winRate : null;

    // Anchor: use baseline if we have it, otherwise assume a neutral 50%
    // just so champions with zero data don't break the math - but this is
    // clearly flagged (hasBaseline: false) so the UI can show low confidence.
    const anchor = baselineWR !== null ? baselineWR : 50;

    const personal = getMatchupStats(myMatches, { myChampion: champion });
    const personalStat = personal.games > 0 ? personal : null;
    const personalDeltaRaw = personalStat ? Math.round((personalStat.winRate - anchor) * 10) / 10 : null;
    const personalWeight = personalStat ? confidenceWeight(personalStat.games, weighting) : null;
    const personalDelta = personalDeltaRaw !== null ? Math.round(personalDeltaRaw * personalWeight * 10) / 10 : null;

    // Counter: population matchup data against EVERY enemy champion
    // currently locked in (not just one), each tagged with that enemy's
    // assigned position so the UI can label rows (e.g. "JG", "MID").
    const matchupList = (enemyChampions || [])
        .map((enemy) => {
            const stat = getPopulationMatchupStats(populationStats, tier, champion, enemy.championName);
            if (!stat) return null;
            return { championName: enemy.championName, position: enemy.position || null, ...stat };
        })
        .filter(Boolean);
    const avgMatchupWR = average(matchupList.map((m) => m.winRate));
    const matchupGames = matchupList.reduce((sum, m) => sum + m.games, 0);
    const matchupDeltaRaw = avgMatchupWR !== null ? Math.round((avgMatchupWR - anchor) * 10) / 10 : null;
    const matchupWeight = avgMatchupWR !== null ? confidenceWeight(matchupGames, weighting) : null;
    const matchupDelta = matchupDeltaRaw !== null ? Math.round(matchupDeltaRaw * matchupWeight * 10) / 10 : null;

    // Synergy: same idea, for allies already locked in.
    const synergyList = (allyChampions || [])
        .map((ally) => {
            const stat = getPopulationSynergyStats(populationStats, tier, champion, ally.championName);
            if (!stat) return null;
            return { championName: ally.championName, position: ally.position || null, ...stat };
        })
        .filter(Boolean);
    const avgSynergyWR = average(synergyList.map((s) => s.winRate));
    const synergyGames = synergyList.reduce((sum, s) => sum + s.games, 0);
    const synergyDeltaRaw = avgSynergyWR !== null ? Math.round((avgSynergyWR - anchor) * 10) / 10 : null;
    const synergyWeight = avgSynergyWR !== null ? confidenceWeight(synergyGames, weighting) : null;
    const synergyDelta = synergyDeltaRaw !== null ? Math.round(synergyDeltaRaw * synergyWeight * 10) / 10 : null;

    let score = anchor;
    if (personalDelta !== null) score += personalDelta;
    if (matchupDelta !== null) score += matchupDelta;
    if (synergyDelta !== null) score += synergyDelta;
    score = Math.round(score * 10) / 10;

    return {
        champion,
        score,
        hasBaseline: baselineWR !== null,
        breakdown: {
            anchor,
            baseline,
            personal: personalStat,
            personalDeltaRaw,
            personalWeight,
            personalDelta,
            matchup: avgMatchupWR !== null
                ? { winRate: avgMatchupWR, games: matchupGames }
                : null,
            matchupDeltaRaw,
            matchupWeight,
            matchupDelta,
            matchupList,
            synergy: avgSynergyWR !== null
                ? { winRate: avgSynergyWR, allyCount: synergyList.length, games: synergyGames }
                : null,
            synergyDeltaRaw,
            synergyWeight,
            synergyDelta,
            synergyList,
            totalDelta: Math.round((score - anchor) * 10) / 10
        }
    };
}

function getPoolRecommendations(pool, { myMatches, populationStats, tier, enemyChampions, allyChampions, filter, confidenceWeighting }) {
    if (!pool || pool.length === 0) return [];

    return pool
        .map((champion) =>
            scoreChampion(champion, { myMatches, populationStats, tier, enemyChampions, allyChampions, filter, confidenceWeighting })
        )
        .sort((a, b) => b.score - a.score);
}

module.exports = { getPoolRecommendations };