// lib/recommendations.js
//
// Ranks the user's champion pool for the current draft state.
//
// The formula is deliberately simple and fully explainable, not a tuned
// "black box" score:
//
//   score = population baseline WR
//         + (personal WR - baseline)       [only if you have personal games]
//         + (avg counter WR - baseline)    [only if enemies are picked AND matchup data]
//         + (avg synergy WR - baseline)    [only if allies are picked AND synergy data]
//
// Each term is only added when real data supports it - a champion with no
// data just falls back to its baseline, it doesn't get penalized for
// missing data. Every component - including the individual per-champion
// counter/synergy rows, not just the average - is returned in the
// breakdown so the UI can show its work rather than just a mystery number.
//
// `filter` (optional patch/day filter - see lib/populationStats.js) only
// affects the baseline lookup. Matchup/synergy data stays all-time - see
// the scope note at the top of lib/populationStats.js.
//
// NOTE: this is intentionally NOT a weighted/confidence-discounted formula
// (no role weights, no sample-size penalty term). It's a flat additive
// model. If per-role weighting or small-sample dampening is wanted later,
// that's a real change to the math here, not just a UI addition.

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

function scoreChampion(champion, { myMatches, populationStats, tier, enemyChampions, allyChampions, filter }) {
    const baseline = getPopulationStats(populationStats, tier, champion, filter);
    const baselineWR = baseline ? baseline.winRate : null;

    // Anchor: use baseline if we have it, otherwise assume a neutral 50%
    // just so champions with zero data don't break the math - but this is
    // clearly flagged (hasBaseline: false) so the UI can show low confidence.
    const anchor = baselineWR !== null ? baselineWR : 50;

    const personal = getMatchupStats(myMatches, { myChampion: champion });
    const personalStat = personal.games > 0 ? personal : null;
    const personalDelta = personalStat ? Math.round((personalStat.winRate - anchor) * 10) / 10 : null;

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
    const matchupDelta = avgMatchupWR !== null ? Math.round((avgMatchupWR - anchor) * 10) / 10 : null;

    // Synergy: same idea, for allies already locked in.
    const synergyList = (allyChampions || [])
        .map((ally) => {
            const stat = getPopulationSynergyStats(populationStats, tier, champion, ally.championName);
            if (!stat) return null;
            return { championName: ally.championName, position: ally.position || null, ...stat };
        })
        .filter(Boolean);
    const avgSynergyWR = average(synergyList.map((s) => s.winRate));
    const synergyDelta = avgSynergyWR !== null ? Math.round((avgSynergyWR - anchor) * 10) / 10 : null;

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
            personalDelta,
            matchup: avgMatchupWR !== null
                ? { winRate: avgMatchupWR, games: matchupList.reduce((sum, m) => sum + m.games, 0) }
                : null,
            matchupDelta,
            matchupList,
            synergy: avgSynergyWR !== null
                ? { winRate: avgSynergyWR, allyCount: synergyList.length }
                : null,
            synergyDelta,
            synergyList,
            totalDelta: Math.round((score - anchor) * 10) / 10
        }
    };
}

function getPoolRecommendations(pool, { myMatches, populationStats, tier, enemyChampions, allyChampions, filter }) {
    if (!pool || pool.length === 0) return [];

    return pool
        .map((champion) =>
            scoreChampion(champion, { myMatches, populationStats, tier, enemyChampions, allyChampions, filter })
        )
        .sort((a, b) => b.score - a.score);
}

module.exports = { getPoolRecommendations };