const { execSync } = require('child_process');

exports.default = async function (context) {
    const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
    execSync(`xattr -cr "${appPath}"`);
};