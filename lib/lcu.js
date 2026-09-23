// lib/lcu.js
//
// Shared helper for talking to the League Client's local API.
// Handles: finding the lockfile, parsing credentials, making authenticated requests.

const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');

// On Windows, League can be installed to any drive/folder the user chose -
// unlike the fixed macOS .app bundle path below, there's no single default
// that's actually reliable. Riot Client itself tracks every game's real
// install location in this manifest regardless of where it was installed
// (the same file other third-party League tools read for exactly this
// reason), so it's a much better source of truth than a hardcoded guess.
// Returns null on anything unexpected - missing file, unreadable JSON, a
// shape Riot has changed - so the caller can fall back to the plain
// default path rather than throwing here.
function readWindowsLockfilePathFromManifest() {
    const manifestPath = 'C:\\ProgramData\\Riot Games\\RiotClientInstalls.json';
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const patchlines = manifest.patchlines || {};
        // Prefer the live/retail install if more than one patchline (e.g.
        // a PBE install alongside it) happens to be registered.
        const installDir = patchlines.live || Object.values(patchlines)[0];
        if (!installDir) return null;
        return path.join(installDir, 'lockfile');
    } catch {
        return null;
    }
}

function getDefaultLockfilePath() {
    if (process.platform === 'darwin') {
    return '/Applications/League of Legends.app/Contents/LoL/lockfile';
    }
    if (process.platform === 'win32') {
    return readWindowsLockfilePathFromManifest() || 'C:\\Riot Games\\League of Legends\\lockfile';
    }
    return null;
}

// Lockfile format: ProcessName:PID:Port:Password:Protocol
function readLockfile(lockfilePath) {
    const raw = fs.readFileSync(lockfilePath, 'utf-8').trim();
    const [processName, pid, port, password, protocol] = raw.split(':');
    return { processName, pid, port, password, protocol, lockfilePath };
}

// Windows fallback: read the port/auth token straight off the running
// LeagueClientUx.exe process's own command line instead of locating and
// reading a lockfile on disk. This is more robust than the lockfile-path
// guess above - it works no matter where/which drive League is installed
// on, and doesn't depend on RiotClientInstalls.json existing or having
// the shape readWindowsLockfilePathFromManifest() assumes. Uses
// PowerShell/CIM rather than wmic.exe, which newer Windows builds no
// longer ship by default. Returns null (never throws) so callers can
// report a clean "not detected" rather than a confusing subprocess error.
function getWindowsCredentialsFromProcess() {
    try {
        const psCommand =
            "Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine";
        const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
            encoding: 'utf-8',
            windowsHide: true,
            timeout: 5000
        }).trim();

        if (!output) return null; // process not running

        const portMatch = output.match(/--app-port=(\d+)/);
        const tokenMatch = output.match(/--remoting-auth-token=([\w-]+)/);
        if (!portMatch || !tokenMatch) return null;

        return {
            processName: 'LeagueClientUx',
            pid: null,
            port: portMatch[1],
            password: tokenMatch[1],
            protocol: 'https',
            lockfilePath: null,
            source: 'process' // so callers/logs can tell which path worked
        };
    } catch {
        return null; // PowerShell unavailable, timed out, or query failed
    }
}

function getCredentials() {
    if (process.env.LOCKFILE_PATH) {
        return readLockfile(process.env.LOCKFILE_PATH);
    }

    if (process.platform === 'win32') {
        // Try the lockfile guess first (cheap, no subprocess); if that
        // fails for any reason, fall back to reading the running
        // process's own command line before giving up entirely.
        try {
            return readLockfile(getDefaultLockfilePath());
        } catch (lockfileErr) {
            const fromProcess = getWindowsCredentialsFromProcess();
            if (fromProcess) return fromProcess;
            throw new Error(
                `League not detected on Windows (lockfile: ${lockfileErr.message}; ` +
                `LeagueClientUx.exe process check also came back empty).`
            );
        }
    }

    const lockfilePath = getDefaultLockfilePath();
    if (!lockfilePath) {
        throw new Error(
            `Don't know the default League install path for platform "${process.platform}". Set LOCKFILE_PATH manually.`
        );
    }
    return readLockfile(lockfilePath);
}

// Makes a single authenticated GET request to the given LCU path,
// e.g. lcuRequest('/lol-summoner/v1/current-summoner')
function lcuRequest(path, { port, password }) {
    return new Promise((resolve, reject) => {
    const authHeader = 'Basic ' + Buffer.from(`riot:${password}`).toString('base64');

    const req = https.request(
        {
        hostname: '127.0.0.1',
        port: Number(port),
        path,
        method: 'GET',
        headers: { Authorization: authHeader },
        rejectUnauthorized: false // League's cert is self-signed; expected for localhost
        },
        (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
            try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
            } catch {
            resolve({ statusCode: res.statusCode, data: body });
            }
        });
        }
    );

    req.on('error', reject);
    req.end();
    });
}

module.exports = { getCredentials, lcuRequest };