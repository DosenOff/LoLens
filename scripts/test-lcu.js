// scripts/test-lcu.js
// Sanity check: can we authenticate and read our own summoner info?
// Run with: node scripts/test-lcu.js

const { getCredentials, lcuRequest } = require('../lib/lcu');

(async () => {
    try {
    const creds = getCredentials();
    console.log(`Reading lockfile at: ${creds.lockfilePath}`);
    console.log('Parsed credentials:', { ...creds, password: '(hidden)' });

    console.log('\nRequesting current summoner...');
    const { data } = await lcuRequest('/lol-summoner/v1/current-summoner', creds);
    console.log('\nCurrent summoner:\n', data);
    } catch (err) {
    if (err.code === 'ENOENT') {
        console.error('\nCould not find the lockfile. Is League actually open?');
    } else {
        console.error('\nRequest failed:', err.message);
    }
    }
})();

