// lib/rankEmblem.js
//
// Maps a populationTier value (EMERALD, EMERALD+, DIAMOND, DIAMOND+,
// MASTER_PLUS) to its real Riot rank emblem image, downloaded from
// Riot's own developer portal:
//   https://static.developer.riotgames.com/docs/lol/ranked-emblems-latest.zip
// (official asset, separate from Data Dragon - see README for the fetch
// steps). Division/sub-bracket suffixes ("+", "_PLUS") are stripped since
// the emblem art is per base tier only - Emerald III/IV and Emerald I/II
// share the same badge, just a different division number in-game, which
// we don't attempt to reproduce here.
//
// Assumes assets/rank-emblems/<tier>.png exists (lowercase, e.g.
// "diamond.png") - flattened from the zip's raw "Rank=Diamond.png" /
// nested-folder structure. See README for the one-time setup commands.

function rankEmblemUrl(tier) {
    if (!tier) return null;
    const key = tier.replace('_PLUS', '').replace('+', '').toLowerCase();
    return `../assets/rank-emblems/${key}.png`;
}

module.exports = { rankEmblemUrl };