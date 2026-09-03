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

    const timer = setInterval(async () => {
        let creds;
        try {
            creds = getCredentials();
        } catch {
            // Lockfile missing or unreadable -> League isn't running.
            if (leagueWasRunning) {
                leagueWasRunning = false;
                inChampSelect = false;
                onLeagueClosed && onLeagueClosed();
            }
            return;
        }

        if (!leagueWasRunning) {
            leagueWasRunning = true;
            onReady && onReady();
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