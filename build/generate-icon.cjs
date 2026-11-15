'use strict';
// Rasterise build/icon.svg en build/icon.png (1024 × 1024, coins transparents).
// Utilise Chromium via Electron : aucune dépendance de dessin supplémentaire,
// rendu identique à celui de l'application.
//
//   npx electron build/generate-icon.cjs

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, 'icon.svg');
const TARGET = path.join(__dirname, 'icon.png');
const SIZE = 1024;
const WINDOW = 1100;

app.disableHardwareAcceleration();

function wrapperHtml(svg) {
  const data = Buffer.from(svg).toString('base64');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
    img{display:block;width:100%;height:100%;object-fit:contain}
  </style></head><body><img alt="" src="data:image/svg+xml;base64,${data}"></body></html>`;
}

app
  .whenReady()
  .then(async () => {
    const svg = fs.readFileSync(SOURCE, 'utf8');
    const win = new BrowserWindow({
      width: WINDOW,
      height: WINDOW,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: false },
    });
    const html = wrapperHtml(svg);
    await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const [width, height] = win.getContentSize();
    const side = Math.min(width, height);
    const image = await win.webContents.capturePage({
      x: Math.round((width - side) / 2),
      y: Math.round((height - side) / 2),
      width: side,
      height: side,
    });
    fs.writeFileSync(TARGET, image.resize({ width: SIZE, height: SIZE }).toPNG());
    console.log(`[icon] ${TARGET} (${width}×${height} → ${SIZE}×${SIZE})`);
    app.quit();
  })
  .catch((error) => {
    console.error('[icon] échec :', error);
    app.exit(1);
  });
