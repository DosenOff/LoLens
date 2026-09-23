// lib/watcher.js
//
// Background poller: watches for Legaue starting up and for champion select
// starting.ending, and calls back into main.js when those things happen.
// This is what lests the app react without anyone manually opening a window.

const { getCredentials, lcuRequest } = require('./lcu');

function startWatching(
    { onReady, onChampSelectUpdate, onChampSelectEnd, onLeagueClosed },
    intervalMS = 2000
) {
    let leagueWasRunning = false;
    let inChampSelect = false;
    let hasLoggedFirstFailure = false;

    const timer = setInterval(async () => {
        let creds;
        try {
            creds = getCredentials();
        } catch (err) {
            // Lockfile missing/unreadable and (on Windows) the process
            // check also came back empty -> League isn't running. Log
            // the reason once on the very first failure so a League
            // that's actually running but never getting detected isn't
            // a silent black box - every tick after that stays quiet as
            // before, since a closed client failing repeatedly is normal.
            if (!hasLoggedFirstFailure) {
                hasLoggedFirstFailure = true;
                console.log(`Not watching League yet: ${err.message}`);
            }
            if (leagueWasRunning) {
                leagueWasRunning = false;
                inChampSelect = false;
                onLeagueClosed && onLeagueClosed();
            }
            return;
        }

        if (!leagueWasRunning) {
            leagueWasRunning = true;
            hasLoggedFirstFailure = false; // reset so a later disconnect logs again
            onReady && onReady();
            console.log(`League detected${creds.source ? ` (via ${creds.source})` : ''}.`);
        }

        try {
            const { statusCode, data } = await lcuRequest('/lol-champ-select/v1/session', creds);
            if (statusCode === 200) {
                inChampSelect = true;
                onChampSelectUpdate && onChampSelectUpdate(data);
            } else if (inChampSelect) {
                inChampSelect = false;
                onChampSelectEnd && onChampSelectEnd();
            }
        } catch {
            // Transient failure (League busy, brief hiccup) - just try again next tick.
        }
    }, intervalMS);

    return () => clearInterval(timer);
}

module.exports = { startWatching };