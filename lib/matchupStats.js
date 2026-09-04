// lib/matchupStats.js
//
// Turns the flat list of match records into per-matchup stats:
// "when I played champion X against champion Y, how'd I do?"

function getMatchupStats(matches, { myChampion, opponentChampion } = {}) {
    let filtered = matches;
    if (myChampion) {
        filtered = filtered.filter((m) => m.myChampion === myChampion);
    }
    if (opponentChampion) {
        filtered = filtered.filter((m) => m.opponentChampion === opponentChampion);
    }

    const games = filtered.length;
    const wins = filtered.filter((m) => m.win).length;
    const winRate = games > 0 ? Math.round((wins / games) * 1000) / 10 : null;

    return { myChampion, opponentChampion, games, wins, winRate };
}

// Given an enemy champion, return your win rate against them broken down
// by which of your own champions you were playing — this is the exact
// shape the UI's "Your history vs X" panel needs.
function getMatchupsAgainst(matches, opponentChampion) {
    const relevant = matches.filter((m) => m.opponentChampion === opponentChampion);
    const myChampions = [...new Set(relevant.map((m) => m.myChampion))];

    return myChampions
        .map((champ) => getMatchupStats(matches, { myChampion: champ, opponentChampion }))
        .sort((a, b) => b.games - a.games);
}

module.exports = { getMatchupStats, getMatchupsAgainst };