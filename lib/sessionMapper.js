// lib/sessionMapper.js
//
// Converts the LCU's raw champ select session JSON into a simpler shape
// the UI can render directly - names instead of IDs, plain booleans instead
// of parsing the actions array yourself, etc.

function mapPlayer(player, championName) {
    return {
        cellId: player.cellId,
        position: player.assignedPosition || null,
        championName: championName(player.championId) // null if not picked yet
    };
}

function isLocalPlayersTurn(rawSession) {
    const allActions = (rawSession.actions || []).flat();
    return allActions.some(
        (action) => action.isInProgress && action.actorCellId === rawSession.localPlayerCellId
    );
}

// Read bans directly from completed ban actions rather than the session's
// bans.myTeamBans/theirTeamBans summary object. That summary can lag behind
// (some pathes have a "reveal" step that delays it), while individual
// actions report `completed: true` as soon as a ban actually locks in.
function getBans(rawSession, championName) {
    const allActions = (rawSession.actions || []).flat();
    const mine = [];
    const theirs = [];

    for (const action of allActions) {
        if (action.type !== 'ban' || !action.completed || !action.championId) continue;
        const name = championName(action.championId);
        if (!name) continue;
        if (action.isAllyAction) mine.push(name);
        else theirs.push(name);
    }

    return { mine, theirs };
}

function mapSession(rawSession, { championName }) {
    return {
        phase: rawSession.timer?.phase || 'UNKNOWN',
        timeLeftSeconds: Math.max(0, Math.round((rawSession.timer?.adjustedTimeLeftInPhase || 0) / 1000)),
        isMyTurn: isLocalPlayersTurn(rawSession),
        localPlayerCellId: rawSession.localPlayerCellId,
        myTeam: (rawSession.myTeam || []).map((p) => mapPlayer(p, championName)),
        theirTeam: (rawSession.theirTeam || []).map((p) => mapPlayer(p, championName)),
        bans: getBans(rawSession, championName)
    };
}

module.exports = { mapSession };