const { execSync } = require('child_process');

exports.default = async function (context) {
    if (context.electronPlatformName !== 'darwin') return;

    const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
    execSync(`xattr -cr "${appPath}"`);
};