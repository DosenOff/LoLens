// lib/recommendations.js
//
// Ranks the user's champion pool for the current draft state.
//
// The formula is deliberately simple and fully explainable, not a tuned
// "black box" score:
//
//   score = population baseline WR
//         + (personal WR - baseline)       [only if you have personal games]
//         + (matchup WR - baseline)        [only if there's an enemy pick AND matchup data]
//         + (synergy WR - baseline)        [only if allies are picked AND synergy data, averaged]
//
// Each term is only added when real data supports it - a champion with no
// data just falls back to its baseline, it doesn't get penalized for
// missing data. Every component is returned alongside the score so the UI
// can show its work rather than just a mystery number.

const { getMatchupStats } = require('./matchupStats');
const {
    getPopulationStats,
    getPopulationMatchupStats,
    getPopulationSynergyStats
} = require('./populationStats');

function scoreChampion(champion, { myMatches, populationStats, tier, enemyChampion, allyChampions }) {
    const baseline = getPopulationStats(populationStats, tier, champion);
    const baselineWR = baseline ? baseline.winRate : null;

    const personal = getMatchupStats(myMatches, { myChampion: champion });
    const personalStat = personal.games > 0 ? personal : null;

    let matchupStat = null;
    if (enemyChampion) {
        matchupStat = getPopulationMatchupStats(populationStats, tier, champion, enemyChampion);
    }

    let synergyStats = [];
    if (allyChampions && allyChampions.length > 0) {
        synergyStats = allyChampions
            .map((ally) => getPopulationSynergyStats(populationStats, tier, champion, ally))
            .filter(Boolean);
    }
    const avgSynergyWR =
        synergyStats.length > 0
            ? Math.round((synergyStats.reduce((sum, s) => sum + s.winRate, 0) / synergyStats.length) * 10) / 10
            : null;

    // Anchor: use baseline if we have it, otherwise assume a neutral 50%
    // just so champions with zero data don't break the math - but this is
    // clearly flagged in the breakdown so the UI can show low confidence.
    const anchor = baselineWR !== null ? baselineWR : 50;

    let score = anchor;
    if (personalStat) score += personalStat.winRate - anchor;
    if (matchupStat) score += matchupStat.winRate - anchor;
    if (avgSynergyWR !== null) score += avgSynergyWR - anchor;

    return {
        champion,
        score: Math.round(score * 10) / 10,
        hasBaseline: baselineWR !== null,
        breakdown: {
            baseline: baseline,
            personal: personalStat,
            matchup: matchupStat,
            synergy: avgSynergyWR !== null ? { winRate: avgSynergyWR, allyCount: synergyStats.length } : null
        }
    };
}

function getPoolRecommendations(pool, { myMatches, populationStats, tier, enemyChampion, allyChampions }) {
    if (!pool || pool.length === 0) return [];

    return pool
        .map((champion) =>
            scoreChampion(champion, { myMatches, populationStats, tier, enemyChampion, allyChampions })
        )
        .sort((a, b) => b.score - a.score);
}

module.exports = { getPoolRecommendations };