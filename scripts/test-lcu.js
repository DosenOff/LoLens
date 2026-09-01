// scripts/test-lcu.js
//
// Objective: prove we can talk to the League Client at all.
// Run this with League open (menu screen is fine, custom game champ select is better)
// and it should print your own summoner info as JSON.
//
// Run with: node scripts/test-lcu.js
//
// Why we're not using league-connect's authenticate() here:
// on macOS it reads credentials by scanning `ps aux` output with a regex,
// and that regex is currently mis-parsing the password field (it grabs part
// of the next command-line flag too). Reading League's lockfile directly
// is simpler and avoids that bug entirely.

const fs = require('fs');
const https = require('https');

// Default install locations differ by OS. If you installed League somewhere
// custom, override with an environment variable instead, e.g.:
//   LOCKFILE_PATH=/path/to/lockfile node scripts/test-lcu.js
function getDefaultLockfilePath() {
    if (process.platform === 'darwin') {
    return '/Applications/League of Legends.app/Contents/LoL/lockfile';
    }
    if (process.platform === 'win32') {
    return 'C:\\Riot Games\\League of Legends\\lockfile';
    }
  // League doesn't officially support Linux; leaving this unset on purpose
  // rather than guessing a path that's unlikely to be right.
    return null;
}

const lockfilePath = process.env.LOCKFILE_PATH || getDefaultLockfilePath();

if (!lockfilePath) {
    console.error(
    `Don't know the default League install path for platform "${process.platform}".`
    );
    console.error('Set LOCKFILE_PATH manually and try again.');
    process.exit(1);
}

function readLockfile(path) {
  // The lockfile is a single line, colon-separated:
  // ProcessName:PID:Port:Password:Protocol
    const raw = fs.readFileSync(path, 'utf-8').trim();
    const [processName, pid, port, password, protocol] = raw.split(':');
    return { processName, pid, port, password, protocol };
}

function requestSummoner({ port, password }) {
    return new Promise((resolve, reject) => {
    const authHeader = 'Basic ' + Buffer.from(`riot:${password}`).toString('base64');

    const req = https.request(
        {
        hostname: '127.0.0.1',
        port: Number(port),
        path: '/lol-summoner/v1/current-summoner',
        method: 'GET',
        headers: { Authorization: authHeader },
        // League's cert is self-signed; this is expected and fine for localhost.
        rejectUnauthorized: false
        },
        (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
            try {
            resolve(JSON.parse(body));
            } catch {
            resolve(body);
            }
        });
        }
    );

    req.on('error', reject);
    req.end();
    });
}

(async () => {
    try {
    console.log(`Reading lockfile at: ${lockfilePath}`);
    const creds = readLockfile(lockfilePath);
    console.log('Parsed credentials:', { ...creds, password: '(hidden)' });

    console.log('\nRequesting current summoner...');
    const summoner = await requestSummoner(creds);
    console.log('\nCurrent summoner:\n', summoner);
    } catch (err) {
    if (err.code === 'ENOENT') {
        console.error(`\nCould not find lockfile at ${lockfilePath}`);
        console.error('Is League actually open? If installed somewhere non-default,');
        console.error('set LOCKFILE_PATH to the correct location and try again.');
    } else {
        console.error('\nRequest failed:', err.message);
    }
    }
})();

