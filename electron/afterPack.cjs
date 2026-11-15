'use strict';
// Hook electron-builder exécuté après l'empaquetage.
//
// Les builds macOS ne sont pas signés avec un certificat Apple Developer ID,
// mais Apple Silicon refuse de lancer un binaire sans signature valide. Une
// fois le bundle renommé et son Info.plist réécrit par electron-builder, on le
// signe donc ad hoc (« - ») pour qu'il démarre sur arm64.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.platform !== 'darwin') {
    console.warn(
      '[afterPack] hors macOS : signature ad hoc ignorée (l’app ne démarrera pas sur Apple Silicon)',
    );
    return;
  }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`[afterPack] signature ad hoc : ${appPath}`);
};
