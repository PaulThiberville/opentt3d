import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));

interface DesktopConfig {
  WEB_PREFERENCES: Record<string, unknown>;
}

const config = require('../electron/config.cjs') as DesktopConfig;

function read(relative: string): string {
  return readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
}

interface DecodedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  pixels: Buffer;
}

function decodePng(buffer: Buffer): DecodedPng {
  expect(buffer.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  expect(bitDepth).toBe(8);
  expect(colorType).toBe(6); // RGBA
  expect(interlace).toBe(0);

  const raw = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x] ?? 0;
      const left = x >= bytesPerPixel ? (pixels[target + x - bytesPerPixel] ?? 0) : 0;
      const up = y > 0 ? (pixels[target - stride + x] ?? 0) : 0;
      const upLeft =
        y > 0 && x >= bytesPerPixel ? (pixels[target - stride + x - bytesPerPixel] ?? 0) : 0;
      let reconstructed = value;
      if (filter === 1) reconstructed = value + left;
      else if (filter === 2) reconstructed = value + up;
      else if (filter === 3) reconstructed = value + Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        reconstructed = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      pixels[target + x] = reconstructed & 0xff;
    }
  }

  return { width, height, bitDepth, colorType, pixels };
}

describe('processus principal Electron', () => {
  const main = read('electron/main.cjs');

  it('déclare un schéma privilégié et charge l’application', () => {
    expect(main).toContain('protocol.registerSchemesAsPrivileged');
    expect(main).toContain('protocol.handle');
    expect(main).toContain('config.APP_URL');
    expect(main).toContain('config.DEV_URL');
    expect(main).toContain('content-security-policy');
    expect(main).toContain("request.method === 'HEAD'");
  });

  it('verrouille la navigation et l’ouverture de fenêtres', () => {
    expect(main).toContain('setWindowOpenHandler');
    expect(main).toContain("wc.on('will-navigate'");
    expect(main).toContain('event.preventDefault()');
    expect(main).toContain('config.isExternalUrl(url)');
    expect(main).toContain('will-attach-webview');
  });

  it('restreint les permissions et gère les erreurs de rendu', () => {
    expect(main).toContain('setPermissionRequestHandler');
    expect(main).toContain('setPermissionCheckHandler');
    expect(main).toContain("wc.on('render-process-gone'");
    expect(main).toContain("wc.on('did-fail-load'");
    expect(main).toContain("wc.on('unresponsive'");
  });

  it('ajoute un menu, des raccourcis et l’état de fenêtre', () => {
    expect(main).toContain('Menu.setApplicationMenu');
    expect(main).toContain('input.key.toLowerCase()');
    expect(main).toContain("key === 'f11'");
    expect(main).toContain('saveWindowState');
    expect(main).toContain('loadWindowState');
    expect(main).toContain('requestSingleInstanceLock');
  });

  it('n’active aucune option Electron dangereuse', () => {
    for (const forbidden of [
      'nodeIntegration: true',
      'nodeIntegrationInWorker: true',
      'sandbox: false',
      'webSecurity: false',
      'allowRunningInsecureContent: true',
      'webviewTag: true',
      'enableRemoteModule',
    ]) {
      expect(main).not.toContain(forbidden);
    }
    expect(config.WEB_PREFERENCES.contextIsolation).toBe(true);
    expect(config.WEB_PREFERENCES.sandbox).toBe(true);
  });
});

describe('preload', () => {
  const preload = read('electron/preload.cjs');

  it('expose uniquement des informations de lecture seule', () => {
    expect(preload).toContain('contextBridge.exposeInMainWorld');
    expect(preload).toContain("'opentt3dDesktop'");
    expect(preload).toContain('Object.freeze');
  });

  it('ne donne aucun accès privilégié au renderer', () => {
    for (const forbidden of [
      'ipcRenderer',
      'ipcMain',
      'child_process',
      "require('node:fs')",
      "require('fs')",
      'shell.openExternal',
      'process.env',
    ]) {
      expect(preload).not.toContain(forbidden);
    }
  });
});

describe('signature macOS ad hoc', () => {
  it('signe le bundle sans certificat Apple', () => {
    const afterPack = read('electron/afterPack.cjs');
    expect(afterPack).toContain("context.electronPlatformName !== 'darwin'");
    expect(afterPack).toContain("'--sign'");
    expect(afterPack).toContain("'-'");
    expect(afterPack).toContain("'--verify'");
  });
});

describe('workflow desktop', () => {
  const workflow = read('.github/workflows/desktop.yml');

  it('est déclenché manuellement uniquement', () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
  });

  it('construit nativement sur macOS et Windows', () => {
    expect(workflow).toContain('macos-15');
    expect(workflow).toContain('windows-latest');
    expect(workflow).toContain('npx electron-builder --${{ matrix.platform }} --publish never');
    expect(workflow).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'");
    expect(workflow).toContain('timeout-minutes:');
  });

  it('conserve les artefacts un jour et aucun cache', () => {
    expect(workflow).toContain('retention-days: 1');
    expect(workflow).not.toMatch(/^\s*cache:/m);
    expect(workflow).toContain('release/*.dmg');
    expect(workflow).toContain('release/*.zip');
    expect(workflow).toContain('release/*.exe');
  });

  it('récupère le moteur WASM avant le build', () => {
    expect(workflow).toContain('gh release download engine-latest');
    expect(workflow).toContain('opentt3d-engine.wasm');
    expect(workflow).toContain('Vérifier les artefacts WASM');
    expect(workflow.indexOf('gh release download')).toBeLessThan(workflow.indexOf('npm run build'));
    expect(workflow).toContain('node-version: 22');
  });
});

describe('icônes desktop', () => {
  it('fournit un SVG source et un PNG 1024 × 1024 avec transparence', () => {
    const svgPath = path.join(root, 'build', 'icon.svg');
    const pngPath = path.join(root, 'build', 'icon.png');
    expect(existsSync(svgPath)).toBe(true);
    expect(existsSync(pngPath)).toBe(true);

    const svg = readFileSync(svgPath, 'utf8');
    expect(svg).toContain('width="1024"');
    expect(svg).toContain('height="1024"');
    expect(svg).toContain('viewBox="0 0 1024 1024"');

    const png = decodePng(readFileSync(pngPath));
    expect(png.width).toBe(1024);
    expect(png.height).toBe(1024);
    // Coin supérieur gauche transparent, centre opaque.
    expect(png.pixels[3]).toBe(0);
    const center = (512 * png.width + 512) * 4;
    expect(png.pixels[center + 3]).toBe(255);
  });

  it('conserve le script de génération', () => {
    const generator = read('build/generate-icon.cjs');
    expect(generator).toContain("require('electron')");
    expect(generator).toContain("path.join(__dirname, 'icon.svg')");
    expect(generator).toContain("path.join(__dirname, 'icon.png')");
  });
});
