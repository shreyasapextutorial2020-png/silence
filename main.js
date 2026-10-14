const { app, BrowserWindow, ipcMain, dialog, session, shell, protocol } = require('electron');
const { initExtensionStore, extractZip, cmpVersion } = require('./extension-store-backend');
const { applyStartupSwitches, initSilenceCore, runClearOnQuit, getSettings, readSettingsSync } = require('./silence-core');
const { initSilencePro } = require('./silence-pro-core');
const path = require('path');
const fs = require('fs');

applyStartupSwitches();
/* Chromium only accepts this before app ready, so it is read from disk. */
try {
  const pp = JSON.parse(require('fs').readFileSync(
    require('path').join(app.getPath('userData'), 'silence_privacy_prefs.json'), 'utf8'));
  if (pp && pp.leakGuard !== false) app.commandLine.appendSwitch('webrtc-ip-handling-policy', 'disable_non_proxied_udp');
} catch (e) {}


try {
  app.commandLine.appendSwitch('disable-features',
    'ThirdPartyStoragePartitioning,StoragePartitioning,ThirdPartyCookieDeprecationMetadata,' +
    'TpcdHeuristicsGrants,TpcdMetadataGrants,TpcdSupportSettings,TrackingProtection3pcd');
} catch (e) {
  console.error('[silence] could not disable storage partitioning:', e && e.message);
}

try {
  if (process.env.SILENCE_USERDATA) {
    app.setPath('userData', process.env.SILENCE_USERDATA);
  } else {
    app.setPath('userData', path.join(app.getPath('appData'), app.isPackaged ? 'Silence-App' : 'Silence'));
  }
} catch (e) {
  console.error('[silence] could not relocate userData:', e && e.message);
}

(function bridgeExtensionApi() {
  try {
    const s = session.defaultSession;
    if (!s || !s.extensions || s.__extApiBridged) return;
    s.__extApiBridged = true;
    ['loadExtension', 'removeExtension', 'getExtension', 'getAllExtensions'].forEach((m) => {
      if (typeof s.extensions[m] === 'function') s[m] = s.extensions[m].bind(s.extensions);
    });
  } catch (e) {
    console.warn('[silence] extension API bridge skipped:', e && e.message);
  }
})();

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'silence',
    privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: false }
  }
]);

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('enable-pdf-viewer');
app.commandLine.appendSwitch('renderer-process-limit', '6');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512 --optimize-for-size');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('enable-aggressive-domstorage-flushing');
app.userAgentFallback = CHROME_UA;

let win;
const extensionsConfigFile = path.join(app.getPath('userData'), 'silence_extensions.json');

function loadSavedExtensionPaths() {
  try {
    if (fs.existsSync(extensionsConfigFile)) {
      const saved = JSON.parse(fs.readFileSync(extensionsConfigFile, 'utf8'));
      return Array.isArray(saved) ? saved.filter(p => typeof p === 'string' && path.isAbsolute(p)) : [];
    }
  } catch (e) {}
  return [];
}

function saveExtensionPaths(paths) {
  try {
    fs.writeFileSync(extensionsConfigFile, JSON.stringify(paths, null, 2), 'utf8');
  } catch (e) {}
}

let loadedExtensions = [];

const SAFE_REMOTE_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'file:', 'blob:', 'data:', 'silence:']);
const TRUSTED_AUTH_HOSTS = new Set(['accounts.google.com', 'myaccount.google.com', 'google.com']);

function linkDebug() {
  try {
    return !!(process.env.SILENCE_LINK_DEBUG && process.env.SILENCE_LINK_DEBUG !== '0');
  } catch (e) {
    return false;
  }
}

function askBeforeNewTab() {
  try {
    const s = readSettingsSync();
    return !!(s && s.tabs && s.tabs.askBeforeNewTab);
  } catch (e) {
    return false;
  }
}

function checkElectronCurrency() {
  try {
    const { net } = require('electron');
    const req = net.request('https://registry.npmjs.org/electron/latest');
    let body = '';
    req.setHeader('accept', 'application/json');
    req.on('response', (res) => {
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => {
        try {
          const latest = String(JSON.parse(body).version || '');
          const cur = parseInt(String(process.versions.electron).split('.')[0], 10) || 0;
          if (latest && (parseInt(latest.split('.')[0], 10) - cur) >= 2 && win && win.webContents) {
            win.webContents.send('electron-outdated', { current: process.versions.electron, latest });
          }
        } catch (e) {}
      });
    });
    req.on('error', () => {});
    req.end();
  } catch (e) {}
}

function isSafeRemoteUrl(value, { authOnly = false } = {}) {
  if (!value || value === 'about:blank' || value.startsWith('about:')) return true;
  try {
    const parsed = new URL(String(value));
    if (!SAFE_REMOTE_PROTOCOLS.has(parsed.protocol)) return false;
    if (authOnly && ![...TRUSTED_AUTH_HOSTS].some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) return false;
    return true;
  } catch {
    return false;
  }
}

function isDownloadUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();
    const fileExts = [
      '.zip', '.rar', '.7z', '.tar', '.gz', '.iso', '.exe', '.msi',
      '.apk', '.dmg', '.bin', '.torrent', '.pdf', '.mp4', '.mkv',
      '.mp3', '.wav', '.ogg', '.epub', '.csv', '.xlsx', '.docx'
    ];
    if (fileExts.some(ext => pathname.endsWith(ext))) return true;
    if (pathname.endsWith('/download') || pathname.endsWith('/dl') || search.includes('download') || search.includes('dl=')) return true;
    if (parsed.hostname.includes('buzzheavier.com') && (pathname.includes('/download') || pathname.includes('/f/'))) return true;
    if (parsed.hostname.includes('pixeldrain.com') && pathname.includes('/api/file/')) return true;
    if (parsed.hostname.includes('datanodes.to') && (pathname.includes('/download') || search.includes('op=download'))) return true;
    if (parsed.hostname.includes('vikingfile.com') && pathname.includes('/download')) return true;
    if (parsed.hostname.includes('mega.nz') && pathname.includes('/file/')) return false;
    return false;
  } catch {
    return false;
  }
}

function isAdOrPopunderUrl(url) {
  if (!url) return false;
  const adKeywords = [
    'adsterra', 'propellerads', 'popads', 'monetag', 'exoclick',
    'onclick', 'bet365', '1xbet', 'trafficjunky', 'hilltopads',
    'clickadu', 'ad-maven', 'adnxs', 'doubleclick', 'googleadservices',
    'popunder', 'redirecting', 'go.ad', 'track.ad'
  ];
  const lower = url.toLowerCase();
  return adKeywords.some(keyword => lower.includes(keyword));
}

function safeDownloadName(name) {
  const cleaned = path.basename(String(name || 'download')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return cleaned || 'download';
}

function crxToZip(buf) {
  if (buf.slice(0, 4).toString() === 'Cr24') {
    const version = buf.readUInt32LE(4);
    if (version === 3) {
      const headerLength = buf.readUInt32LE(8);
      return buf.slice(12 + headerLength);
    } else if (version === 2) {
      const pubKeyLen = buf.readUInt32LE(8);
      const sigLen = buf.readUInt32LE(12);
      return buf.slice(16 + pubKeyLen + sigLen);
    }
  }
  if (buf[0] === 0x50 && buf[1] === 0x4B) return buf;
  throw new Error('Invalid CRX format');
}

async function registerExtension(extensionPath) {
  const manifestPath = path.join(extensionPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('manifest.json not found');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const ext = await session.defaultSession.loadExtension(extensionPath, { allowFileAccess: true });

  let iconDataUrl = null;
  const icons = manifest.icons || (manifest.action && manifest.action.default_icon) || (manifest.browser_action && manifest.browser_action.default_icon);
  if (icons) {
    const iconRel = typeof icons === 'string' ? icons : (icons['32'] || icons['48'] || icons['128'] || Object.values(icons)[0]);
    if (iconRel) {
      const fullIconPath = path.join(extensionPath, iconRel);
      if (fs.existsSync(fullIconPath)) {
        const extName = path.extname(fullIconPath).slice(1);
        iconDataUrl = `data:image/${extName};base64,` + fs.readFileSync(fullIconPath).toString('base64');
      }
    }
  }

  const popupHtml = (manifest.action && manifest.action.default_popup) ||
                    (manifest.browser_action && manifest.browser_action.default_popup) || null;

  const optionsHtml = manifest.options_ui && manifest.options_ui.page
                    ? manifest.options_ui.page
                    : (manifest.options_page || null);

  const extInfo = {
    id: ext.id,
    name: manifest.name || ext.name,
    version: manifest.version || ext.version,
    description: manifest.description || '',
    path: extensionPath,
    icon: iconDataUrl,
    popupUrl: popupHtml ? `chrome-extension://${ext.id}/${popupHtml}` : null,
    optionsUrl: optionsHtml ? `chrome-extension://${ext.id}/${optionsHtml}` : null
  };

  loadedExtensions = loadedExtensions.filter(e => e.id !== ext.id);
  loadedExtensions.push(extInfo);
  return extInfo;
}

function popupBlockingEnabled() {
  try {
    return !!(getSettings() && getSettings().privacy && getSettings().privacy.blockPopups);
  } catch (e) {
    return false;
  }
}

function broadcastStoreChange() {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send('silence-store:changed', { action: 'removed' });
    } catch (e) {}
  }
}

function registerSilencePages() {
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
  };
  protocol.handle('silence', (request) => {
    try {
      const url = new URL(request.url);
      const host = url.hostname;
      const rel = (url.pathname || '/').replace(/^\/+/, '');
      if (!['store', 'extensions', ''].includes(host)) return new Response('Not found', { status: 404 });
      const file = rel === 'catalog.json' ? 'catalog.json' : 'store.html';
      const full = path.join(__dirname, file);
      if (!full.startsWith(__dirname) || !fs.existsSync(full)) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(full), {
        status: 200,
        headers: { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' }
      });
    } catch (e) {
      return new Response('Bad request', { status: 400 });
    }
  });
}

function createWindow() {
  registerSilencePages();

  try {
    initSilenceCore({ getWindow: () => win });
    setTimeout(checkElectronCurrency, 15000);
  } catch (e) {
    console.error('[core] failed to start:', e);
  }

  try {
    initSilencePro({ getWindow: () => win });
  } catch (e) {
    console.error('[pro] failed to start:', e);
  }

  try {
    initExtensionStore({
      appDir: __dirname,
      registerExtension,
      persistPath: (dir) => {
        const saved = loadSavedExtensionPaths();
        if (!saved.includes(dir)) { saved.push(dir); saveExtensionPaths(saved); }
      },
      forgetPath: (dir) => saveExtensionPaths(loadSavedExtensionPaths().filter(p => p !== dir))
    });
  } catch (e) {
    console.error('[store] extension store failed to start:', e);
  }

  const defaultSession = session.defaultSession;
defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
  if (permission === 'fullscreen' || permission === 'pointerLock' || permission === 'storage-access' || permission === 'clipboard-sanitized-write') {
    return callback(true);
  }
  callback(false);
});
defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
  if (permission === 'fullscreen' || permission === 'pointerLock' || permission === 'clipboard-sanitized-write') {
    return true;
  }
  return false;
});

  defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const h = details.requestHeaders;
    h['User-Agent'] = CHROME_UA;
    h['Sec-CH-UA'] = '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"';
    h['Sec-CH-UA-Mobile'] = '?0';
    h['Sec-CH-UA-Platform'] = '"Windows"';
    if (/google\.(com|co\.[a-z]{2}|co\.in|co\.uk)|gstatic\.com|googleusercontent\.com|youtube\.com/.test(details.url)) {
      h['Sec-CH-UA-Full-Version-List'] = '"Chromium";v="128.0.0.0", "Not;A=Brand";v="24.0.0.0", "Google Chrome";v="128.0.0.0"';
      h['Sec-CH-UA-Arch'] = '"x86"';
      h['Sec-CH-UA-Bitness'] = '"64"';
      h['Sec-CH-UA-Platform-Version'] = '"15.0.0"';
      h['Sec-CH-UA-Form-Factors'] = '"Desktop"';
    }
    if ((details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') && !h['Upgrade-Insecure-Requests']) {
      h['Upgrade-Insecure-Requests'] = '1';
    }
    callback({ cancel: false, requestHeaders: h });
  });

  const SIGNIN_SPOOF = `(function () {
    try {
      var BRANDS = [{ brand: 'Not;A=Brand', version: '24' }, { brand: 'Chromium', version: '128' }, { brand: 'Google Chrome', version: '128' }];
      var HIGH = { architecture: 'x86', bitness: '64', model: '', platformVersion: '15.0.0', uaFullVersion: '128.0.0.0', fullVersionList: BRANDS, wow64: false };
      var uad = {
        brands: BRANDS, mobile: false, platform: 'Windows',
        getHighEntropyValues: function (hints) {
          var out = {};
          var keys = hints || ['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion', 'fullVersionList'];
          for (var i = 0; i < keys.length; i++) out[keys[i]] = HIGH[keys[i]];
          return Promise.resolve(out);
        },
        toJSON: function () { return { brands: BRANDS, mobile: false, platform: 'Windows' }; }
      };
      try { Object.defineProperty(navigator, 'userAgentData', { get: function () { return uad; }, configurable: true }); } catch (e) {}
      try { Object.defineProperty(navigator, 'webdriver', { get: function () { return false; }, configurable: true }); } catch (e) {}
      try {
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) window.chrome.runtime = { id: undefined, connect: function () { return { onDisconnect: { addListener: function () {} }, onMessage: { addListener: function () {} }, postMessage: function () {}, disconnect: function () {} }; }, sendMessage: function () {}, onMessage: { addListener: function () {} }, onConnect: { addListener: function () {} } };
        if (!window.chrome.app) window.chrome.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
        if (!window.chrome.csi) window.chrome.csi = function () { return { startE: Date.now(), onloadT: Date.now(), pageT: (performance && performance.now ? performance.now() : 0), tran: 15 }; };
      } catch (e) {}
    } catch (e) {}
  })();`;

  const GOOGLE_FRAME_RE = /^https:\/\/[a-z0-9.-]*(google\.com|gstatic\.com|googleusercontent\.com)/i;

  function spoofSignInFrames(contents) {
    if (!contents || contents.isDestroyed() || !contents.mainFrame) return;
    const walk = (frame) => {
      try {
        if (GOOGLE_FRAME_RE.test(frame.url || '')) frame.executeJavaScript(SIGNIN_SPOOF, false).catch(() => {});
      } catch (e) {}
      try { (frame.frames || []).forEach(walk); } catch (e) {}
    };
    walk(contents.mainFrame);
  }

  function watchSignIn(contents) {
    if (!contents || contents.isDestroyed()) return;
    const check = () => { try { spoofSignInFrames(contents); } catch (e) {} };
    contents.on('did-finish-load', () => setTimeout(check, 500));
    contents.on('did-navigate', () => setTimeout(check, 1200));
    contents.on('did-frame-finish-load', () => setTimeout(check, 400));
  }

  function attachChromeIdentity(contents) {
    if (!contents || contents.isDestroyed() || !contents.debugger) return;
    try {
      const dbg = contents.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      dbg.sendCommand('Page.enable').catch(() => {});
      dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: SIGNIN_SPOOF }).catch(() => {});
      dbg.sendCommand('Target.enable').catch(() => {});
      dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
      dbg.on('message', (ev, method, params, sessionId) => {
        if (method === 'Target.attachedToTarget' && params && params.sessionId) {
          const sid = params.sessionId;
          dbg.sendCommand('Page.enable', {}, sid).catch(() => {});
          dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: SIGNIN_SPOOF }, sid).catch(() => {});
        }
      });
    } catch (e) {}
  }

  app.on('web-contents-created', (event, contents) => {
    try {
      const type = contents.getType && contents.getType();
      if (type === 'webview' || type === 'window') watchSignIn(contents);
      if (type === 'webview') attachChromeIdentity(contents);
    } catch (e) {}
  });

  win = new BrowserWindow({
    title: 'Silence',
    width: 1380,
    height: 870,
    minWidth: 840,
    minHeight: 540,
    frame: false,
    backgroundColor: '#0b0b0b',
    hasShadow: true,
    webPreferences: {
      webviewTag: true,
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: true,
      plugins: true
    },
  });

  const htmlEntry = fs.existsSync(path.join(__dirname, 'index.html'))
    ? 'index.html'
    : (fs.existsSync(path.join(__dirname, 'index_2.html')) ? 'index_2.html' : 'electron-index.html');
  win.loadFile(path.join(__dirname, htmlEntry));

  ipcMain.handle('open-media-file-dialog', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Open PDF, Video, or Audio File',
      properties: ['openFile'],
      filters: [
        { name: 'All Supported Media', extensions: ['pdf', 'mp4', 'webm', 'mkv', 'mp3', 'wav', 'ogg', 'm4a'] },
        { name: 'PDF Documents', extensions: ['pdf'] },
        { name: 'Video Files', extensions: ['mp4', 'webm', 'mkv'] },
        { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'm4a'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('save-page', async (event, arg) => {
    try {
      const { webContents } = require('electron');
      const wc = webContents.fromId((arg && arg.id) || 0);
      if (!wc) return { ok: false, error: 'no page' };
      const res = await dialog.showSaveDialog(win, {
        title: 'Save page as',
        defaultPath: safeDownloadName((arg && arg.suggested) || 'page.html'),
        filters: [
          { name: 'Webpage, Complete', extensions: ['html'] },
          { name: 'Webpage, HTML Only', extensions: ['htm'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      await wc.savePage(res.filePath, /\.htm$/i.test(res.filePath) ? 'HTMLOnly' : 'HTMLComplete');
      return { ok: true, path: res.filePath };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'save failed' };
    }
  });

  ipcMain.handle('open-file-dialog', async () => {
    try {
      const result = await dialog.showOpenDialog(win, { title: 'Open file', properties: ['openFile'] });
      if (result.canceled || !result.filePaths.length) return null;
      return result.filePaths[0];
    } catch (e) {
      return null;
    }
  });

  ipcMain.handle('purge-memory', async () => {
    try {
      await session.defaultSession.clearCache();
      return { success: true };
    } catch (e) {
      return { success: false };
    }
  });

  win.on('enter-full-screen', () => win.webContents.send('fullscreen-state', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen-state', false));

  ipcMain.on('window-min', (event) => {
    const targetWin = BrowserWindow.fromWebContents(event.sender) || win;
    if (targetWin) targetWin.minimize();
  });
  ipcMain.on('window-max', (event) => {
    const targetWin = BrowserWindow.fromWebContents(event.sender) || win;
    if (targetWin) targetWin.isMaximized() ? targetWin.unmaximize() : targetWin.maximize();
  });
  ipcMain.on('window-close', (event) => {
    const targetWin = BrowserWindow.fromWebContents(event.sender) || win;
    if (targetWin) targetWin.close();
  });
  ipcMain.on('window-fullscreen-toggle', (event) => {
    const targetWin = BrowserWindow.fromWebContents(event.sender) || win;
    if (targetWin) {
      const nextFS = !targetWin.isFullScreen();
      targetWin.setFullScreen(nextFS);
      targetWin.webContents.send('fullscreen-state', nextFS);
    }
  });

  ipcMain.on('window-enter-fullscreen', () => {
    if (win && !win.isFullScreen()) win.setFullScreen(true);
  });
  ipcMain.on('window-leave-fullscreen', () => {
    if (win && win.isFullScreen()) win.setFullScreen(false);
  });
  ipcMain.on('enter-html-fullscreen', () => {
    if (win && !win.isFullScreen()) win.setFullScreen(true);
  });
  ipcMain.on('leave-html-fullscreen', () => {
    if (win && win.isFullScreen()) win.setFullScreen(false);
  });
 function createDetachedWindow(initialUrl, x, y) {
    const newWin = new BrowserWindow({
      title: 'Silence',
      width: 1200,
      height: 800,
      x: x !== undefined ? Math.max(0, x) : undefined,
      y: y !== undefined ? Math.max(0, y) : undefined,
      minWidth: 840,
      minHeight: 540,
      frame: false,
      backgroundColor: '#0b0b0b',
      hasShadow: true,
      webPreferences: {
        webviewTag: true,
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        webSecurity: true,
        plugins: true
      },
    });

    const htmlEntry = fs.existsSync(path.join(__dirname, 'index.html'))
      ? 'index.html'
      : (fs.existsSync(path.join(__dirname, 'index_2.html')) ? 'index_2.html' : 'electron-index.html');
    
    newWin.loadFile(path.join(__dirname, htmlEntry), {
      query: initialUrl ? { initialUrl } : {}
    });

    newWin.on('enter-full-screen', () => newWin.webContents.send('fullscreen-state', true));
    newWin.on('leave-full-screen', () => newWin.webContents.send('fullscreen-state', false));
    return newWin;
  }

  ipcMain.on('detach-tab-to-new-window', (event, { url, x, y }) => {
    if (url && !url.startsWith('about:')) {
      createDetachedWindow(url, x, y);
    }
  });
  const activeDownloads = new Map();
  let pendingUpdateUrl = '';

  app.on('web-contents-created', (event, contents) => {
    if (contents.getType() === 'webview') {
      contents.on('will-navigate', (e, url) => {
        if (!url || url === 'about:blank' || url.startsWith('about:')) return;
        if (!isSafeRemoteUrl(url)) {
          console.warn('[silence] link blocked, unsafe target:', String(url).slice(0, 120));
          e.preventDefault();
          return;
        }
        if (linkDebug()) console.log('[silence] link -> same tab:', String(url).slice(0, 120));
      });

      contents.setWindowOpenHandler(({ url, disposition, features }) => {
        if (linkDebug()) console.log('[silence] link click:', String(url).slice(0, 160));
        if (!isSafeRemoteUrl(url)) return { action: 'deny' };

        if (popupBlockingEnabled() && isAdOrPopunderUrl(url)) {
          return { action: 'deny' };
        }

        if (isDownloadUrl(url)) {
          if (linkDebug()) console.log('[silence]   ↳ file link, downloading');
          contents.downloadURL(url);
          if (win && win.webContents) win.webContents.send('download-started', { url });
          return { action: 'deny' };
        }

        if (url.includes('accounts.google.com')) {
          if (linkDebug()) console.log('[silence]   -> Google sign-in, real pop-up window');
          return {
            action: 'allow',
            overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, backgroundColor: '#0b0b0b' }
          };
        }

        const isPresentation = disposition === 'new-window' ||
          (features && /\b(width|height|left|top|screenx|screeny|toolbar|menubar|location|status|resizable|scrollbars|popup)\b/i.test(features)) ||
          url.includes('presentation');

        if (isPresentation) {
          if (linkDebug()) console.log('[silence]   ↳ presentation window allowed');
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              title: 'Silence',
              width: 1280,
              height: 800,
              backgroundColor: '#0b0b0b',
              autoHideMenuBar: true,
              webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                plugins: true
              }
            }
          };
        }

        const isPrivate = !contents.session.isPersistent();
const currentPartition = isPrivate ? contents.session.__partitionName : null;

if (win && win.webContents) {
  const ask = askBeforeNewTab();
  if (linkDebug()) console.log('[silence]   ↳', ask ? 'confirmation pill' : 'new tab');
  win.webContents.send(ask ? 'request-new-tab-prompt' : 'open-url-in-tab', { url, partition: currentPartition });
}
return { action: 'deny' };
      });

      contents.on('console-message', (event, level, message) => {
        if (typeof message === 'string' && message.indexOf('[silence:page]') === 0) console.log(message);
      });
      contents.on('did-finish-load', () => {
        contents.executeJavaScript("(function () {\n  if (window.__silenceFsDiag) return;\n  window.__silenceFsDiag = true;\n  var tag = '[silence:page] ';\n  function send(m) { try { console.log(tag + m); } catch (e) {} }\n  var interesting = /docs\\.google|office\\.com|officeapps|canva|prezi|slides|powerpoint|youtube|vimeo|netflix|loom|figma|miro/i.test(location.hostname);\n  if (interesting) send('ready on ' + location.hostname + ' | fullscreenEnabled=' + document.fullscreenEnabled);\n  var orig = Element.prototype.requestFullscreen;\n  Element.prototype.requestFullscreen = function () {\n    var el = this;\n    send('requestFullscreen() called on <' + (el.tagName || '?') + '> by ' + location.hostname);\n    var r;\n    try { r = orig.apply(el, arguments); }\n    catch (e) { send('THREW: ' + e.message); throw e; }\n    if (r && typeof r.then === 'function') {\n      r.then(function () {\n        send('GRANTED -> fullscreenElement=' + (document.fullscreenElement ? document.fullscreenElement.tagName : 'null'));\n      }, function (err) {\n        send('DENIED: ' + (err && err.name ? err.name + ': ' + err.message : String(err)));\n      });\n    } else { send('returned a non-promise (legacy fullscreen)'); }\n    return r;\n  };\n  var wk = Element.prototype.webkitRequestFullscreen || Element.prototype.webkitRequestFullScreen;\n  if (wk) {\n    Element.prototype.webkitRequestFullscreen = function () { send('webkitRequestFullscreen() called'); return wk.apply(this, arguments); };\n  }\n  document.addEventListener('fullscreenchange', function () {\n    send('fullscreenchange -> ' + (document.fullscreenElement ? '<' + document.fullscreenElement.tagName + '>' : 'null'));\n  });\n  document.addEventListener('fullscreenerror', function () { send('fullscreenerror fired'); });\n  var origOpen = window.open;\n  window.open = function (u, n, f) {\n    send('window.open(' + String(u).slice(0, 90) + ') name=' + n + ' features=' + (f ? '\"' + f + '\"' : 'none'));\n    return origOpen.apply(window, arguments);\n  };\n})();\n").catch(() => {});
      });

      contents.on('will-attach-webview', (event, webPreferences, params) => {
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.webSecurity = true;
        webPreferences.plugins = true;
      });

      contents.on('enter-html-full-screen', () => {
        if (win && !win.isFullScreen()) win.setFullScreen(true);
        if (win && win.webContents) win.webContents.send('html-fullscreen', { id: contents.id, on: true });
      });
      contents.on('leave-html-full-screen', () => {
        if (win && win.isFullScreen()) win.setFullScreen(false);
        if (win && win.webContents) win.webContents.send('html-fullscreen', { id: contents.id, on: false });
      });
    }
  });

  session.defaultSession.on('will-download', (event, item) => {
    const filename = safeDownloadName(item.getFilename());
    const downloadUrl = item.getURL();
    if (!isSafeRemoteUrl(downloadUrl)) {
      event.preventDefault();
      return;
    }

    for (let [existingId, existingItem] of activeDownloads) {
      if (existingItem.getFilename() === filename && existingItem.getState() === 'progressing') {
        event.preventDefault();
        return;
      }
    }

    const id = Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    activeDownloads.set(id, item);

    const totalBytes = item.getTotalBytes();
    const dlSettings = (getSettings() && getSettings().downloads) || {};
    const downloadDir = dlSettings.path || app.getPath('downloads');
    const savePath = path.join(downloadDir, filename);
    if (dlSettings.ask) {
      item.setSaveDialogOptions({ defaultPath: savePath });
    } else {
      try { fs.mkdirSync(downloadDir, { recursive: true }); } catch (e) {}
      item.setSavePath(savePath);
    }

    win.webContents.send('download-start', { id, filename, totalBytes, savePath });
    win.webContents.send('download-cleanup-tab', { url: downloadUrl });

    item.on('updated', (event, state) => {
      if (state === 'progressing') {
        const received = item.getReceivedBytes();
        const percent = totalBytes > 0 ? Math.round((received / totalBytes) * 100) : 0;
        win.webContents.send('download-progress', { id, filename, received, totalBytes, percent });
      } else if (state === 'interrupted') {
        win.webContents.send('download-failed', { id, filename, reason: 'Interrupted' });
      }
    });

    item.once('done', (event, state) => {
      activeDownloads.delete(id);
      const isAppUpdate = (downloadUrl === pendingUpdateUrl);

      if (state === 'completed') {
        win.webContents.send('download-complete', { id, filename, savePath });
        if (isAppUpdate) {
          pendingUpdateUrl = '';
          setTimeout(() => {
            shell.openPath(savePath).catch(() => {});
            app.quit();
          }, 1000);
        }
      } else if (state === 'cancelled') {
        win.webContents.send('download-cancelled', { id, filename });
      } else {
        win.webContents.send('download-failed', { id, filename, reason: state });
      }
    });
  });

  ipcMain.on('cancel-download', (event, id) => {
    const item = activeDownloads.get(id);
    if (item) {
      item.cancel();
      activeDownloads.delete(id);
    }
  });

  ipcMain.on('show-in-folder', (event, filePath) => {
    if (fs.existsSync(filePath)) shell.showItemInFolder(filePath);
    else shell.openPath(app.getPath('downloads'));
  });

  ipcMain.handle('install-cws-extension', async (event, extensionId) => {
    try {
      const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130.0.6723.70&acceptformat=crx2,crx3&x=id%3D${extensionId}%26uc`;
      const response = await fetch(crxUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        }
      });
      if (!response.ok) throw new Error('Download failed: HTTP ' + response.status);

      const arrayBuf = await response.arrayBuffer();
      const zipBuffer = crxToZip(Buffer.from(arrayBuf));

      if (!/^[a-z0-9]{32}$/i.test(String(extensionId || ''))) throw new Error('malformed extension id');
      const targetDir = path.join(app.getPath('userData'), 'installed_extensions', extensionId);

      extractZip(zipBuffer, targetDir);

      const extInfo = await registerExtension(targetDir);
      const saved = loadSavedExtensionPaths();
      if (!saved.includes(targetDir)) {
        saved.push(targetDir);
        saveExtensionPaths(saved);
      }
      return { success: true, extension: extInfo };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('load-extension-dialog', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Unpacked Extension Folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    try {
      const extInfo = await registerExtension(result.filePaths[0]);
      const saved = loadSavedExtensionPaths();
      if (!saved.includes(result.filePaths[0])) {
        saved.push(result.filePaths[0]);
        saveExtensionPaths(saved);
      }
      return { success: true, extension: extInfo };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-extensions', () => loadedExtensions);

  ipcMain.handle('remove-extension', (event, id) => {
    const ext = loadedExtensions.find(e => e.id === id);
    if (ext) {
      try { session.defaultSession.removeExtension(id); } catch (e) {}
      loadedExtensions = loadedExtensions.filter(e => e.id !== id);
      const saved = loadSavedExtensionPaths().filter(p => p !== ext.path);
      saveExtensionPaths(saved);
      try {
        const installedRoot = path.join(app.getPath('userData'), 'installed_extensions');
        if (ext.path && fs.existsSync(ext.path) && path.resolve(ext.path).startsWith(path.resolve(installedRoot))) {
          fs.rmSync(ext.path, { recursive: true, force: true });
        }
      } catch (e) {}
    } else {
      try { session.defaultSession.removeExtension(id); } catch (e) {}
    }
    try { if (typeof broadcastStoreChange === 'function') broadcastStoreChange(); } catch (e) {}
    return true;
  });


  /* ======================================================================
     Durability for things that used to live in memory.
     History and bookmarks are already stored by silence-pro-core.js — this
     block deliberately does NOT re-register those channels (Electron ignores
     a second handler for the same name). It only makes the downloads list
     survive a restart.
     ====================================================================== */
  function storePath(name) { return path.join(app.getPath('userData'), name); }
  function loadStore(name, fallback) {
    try {
      const data = JSON.parse(fs.readFileSync(storePath(name), 'utf8'));
      if (Array.isArray(data)) return data;
      if (data && typeof data === 'object' && Array.isArray(data.items)) return data.items;
    } catch (e) {}
    return fallback;
  }
  function saveStore(name, data) {
    try { fs.writeFileSync(storePath(name), JSON.stringify(data), 'utf8'); return true; }
    catch (e) { return false; }
  }


  /* ======================================================================
     Chrome system surfaces: task manager, web capture, downloads manager.
     These are the pages Chrome reaches with Shift+Esc, Ctrl+Shift+S and Ctrl+J.
     ====================================================================== */
  const DOWNLOAD_STORE = 'silence_downloads.json';
  const downloadHistory = loadStore(DOWNLOAD_STORE, []);
  function persistDownloads() { saveStore(DOWNLOAD_STORE, downloadHistory.slice(0, 200)); }
  function recordDownload(rec) {
    downloadHistory.unshift(rec);
    if (downloadHistory.length > 200) downloadHistory.pop();
    persistDownloads();
  }

  /* A second will-download listener: it only observes, so it cannot disturb the
     download pipeline that already works. */
  session.defaultSession.on('will-download', (event, item) => {
    try {
      const rec = {
        id: 'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: safeDownloadName(item.getFilename()),
        url: item.getURL(), path: '', state: 'progressing',
        bytes: 0, total: 0, startedAt: Date.now()
      };
      recordDownload(rec);
      item.on('updated', () => { rec.bytes = item.getReceivedBytes(); rec.total = item.getTotalBytes(); });
      item.once('done', (e, state) => {
        rec.state = (state === 'completed') ? 'done' : (state === 'cancelled' ? 'cancelled' : 'failed');
        try { rec.path = item.getSavePath() || ''; } catch (err) { rec.path = ''; }
        rec.bytes = item.getReceivedBytes();
        rec.total = item.getTotalBytes();
        persistDownloads();
      });
    } catch (e) {}
  });

  ipcMain.handle('silence:task-manager', async () => {
    try {
      const { webContents } = require('electron');
      const metrics = app.getAppMetrics();
      const byPid = new Map();
      metrics.forEach((m) => { if (m && m.pid) byPid.set(m.pid, m); });
      const rows = [];
      const seen = new Set();
      (webContents.getAllWebContents() || []).forEach((wc) => {
        if (!wc || wc.isDestroyed()) return;
        let pid = 0, url = '', title = '', type = 'page';
        try { pid = wc.getOSProcessId(); } catch (e) {}
        try { url = wc.getURL() || ''; } catch (e) {}
        try { title = wc.getTitle() || ''; } catch (e) {}
        try { type = wc.getType() || 'page'; } catch (e) {}
        const m = byPid.get(pid);
        if (pid) seen.add(pid);
        rows.push({
          id: wc.id, pid: pid, type: type, url: url, title: title,
          memory: (m && m.memory && m.memory.workingSetSize) || 0,
          cpu: (m && m.cpu && m.cpu.percentCPUUsage) || 0
        });
      });
      metrics.forEach((m) => {
        if (!m || seen.has(m.pid)) return;
        rows.push({
          id: 0, pid: m.pid, type: m.type || 'process', url: '', title: '',
          memory: (m.memory && m.memory.workingSetSize) || 0,
          cpu: (m.cpu && m.cpu.percentCPUUsage) || 0
        });
      });
      return { success: true, rows: rows };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err), rows: [] };
    }
  });

  ipcMain.handle('silence:kill-process', async (event, arg) => {
    const pid = Number(arg && arg.pid) || 0;
    const id = Number(arg && arg.id) || 0;
    if (id) {
      /* A tab: ask the UI to close it so the tab strip stays in step. */
      try { if (win && win.webContents) win.webContents.send('silence:close-tab-contents', id); } catch (e) {}
      return { success: true, closedTab: true };
    }
    if (pid > 0) {
      try { process.kill(pid); return { success: true }; } catch (e) {
        return { success: false, error: 'Could not end process ' + pid + ': ' + (e && e.message) };
      }
    }
    return { success: false, error: 'Nothing to end.' };
  });

  ipcMain.handle('silence:capture-page', async (event, arg) => {
    const id = Number(arg && arg.id) || 0;
    const full = !!(arg && arg.full);
    try {
      const { webContents, dialog } = require('electron');
      const wc = (id && webContents.fromId(id)) || (win && win.webContents);
      if (!wc || wc.isDestroyed()) return { success: false, error: 'That tab is gone.' };
      let buffer = null;
      if (full) {
        const dbg = wc.debugger;
        const wasAttached = dbg.isAttached();
        if (!wasAttached) dbg.attach('1.3');
        try {
          const shot = await dbg.sendCommand('Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: true, fromSurface: false
          });
          buffer = Buffer.from((shot && shot.data) || '', 'base64');
        } finally {
          if (!wasAttached) { try { dbg.detach(); } catch (e) {} }
        }
      } else {
        const img = await wc.capturePage();
        buffer = img.toPNG();
      }
      if (!buffer || !buffer.length) return { success: false, error: 'Nothing came back from the capture.' };
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const save = await dialog.showSaveDialog(win, {
        defaultPath: path.join(app.getPath('downloads'), 'Silence capture ' + stamp + '.png'),
        filters: [{ name: 'PNG image', extensions: ['png'] }]
      });
      if (!save || save.canceled || !save.filePath) return { success: false, canceled: true };
      fs.writeFileSync(save.filePath, buffer);
      return { success: true, path: save.filePath, bytes: buffer.length };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('silence:downloads-list', async () => ({ success: true, items: downloadHistory.slice(0, 100) }));

  ipcMain.handle('silence:download-action', async (event, arg) => {
    const act = String((arg && arg.action) || '');
    const rec = downloadHistory.filter((d) => d.id === (arg && arg.id))[0];
    try {
      const { shell } = require('electron');
      if (act === 'open') {
        if (!rec) return { success: false, error: 'That download is no longer listed.' };
        if (rec.path && fs.existsSync(rec.path)) shell.openPath(rec.path);
        else if (rec.url) shell.openExternal(rec.url);
      } else if (act === 'folder') {
        if (rec && rec.path) shell.showItemInFolder(rec.path);
      } else if (act === 'retry') {
        if (!rec || !rec.url) return { success: false, error: 'No source URL to retry.' };
        session.defaultSession.downloadURL(rec.url);
      } else if (act === 'cancel') {
        const item = rec && activeDownloads.get(rec.id);
        if (item) item.cancel();
      } else if (act === 'remove') {
        const i = downloadHistory.findIndex((d) => d.id === arg.id);
        if (i >= 0) { downloadHistory.splice(i, 1); persistDownloads(); }
      } else if (act === 'clear') {
        downloadHistory.length = 0;
        persistDownloads();
      } else {
        return { success: false, error: 'Unknown action: ' + act.slice(0, 30) };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  });


  ipcMain.handle('silence:exit-fullscreen', async () => {
    try {
      if (win && win.isFullScreen()) {
        win.setFullScreen(false);
        win.webContents.send('fullscreen-state', false);
      }
      if (win && win.webContents) win.webContents.send('html-fullscreen', { id: 0, on: false });
    } catch (e) {}
    return { success: true };
  });

  /* ======================================================================
     Auto DNS switching, and private tabs.
     ====================================================================== */
  const DNS_PROVIDERS = [
    { id: 'cloudflare', label: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
    { id: 'google',     label: 'Google',     url: 'https://dns.google/dns-query' },
    { id: 'quad9',      label: 'Quad9',      url: 'https://dns.quad9.net/dns-query' }
  ];
  let dnsIndex = 0;
  let dnsUntil = 0;
  let dnsConfig = { enabled: true, threshold: 8000 };
  const pendingLoads = new Map();

  function dnsProvider(i) {
    const n = DNS_PROVIDERS.length;
    return DNS_PROVIDERS[(((i % n) + n) % n)];
  }

  function applyDnsProvider(i, target) {
    const p = dnsProvider(i);
    try {
      const s = target || session.defaultSession;
      if (s && s.configureHostResolver) {
        s.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: [p.url] });
      }
    } catch (e) {}
    return p;
  }

  function switchDns(reason, contents) {
    const now = Date.now();
    if (now < dnsUntil) return null;                 /* never thrash between servers */
    dnsUntil = now + 30000;
    dnsIndex += 1;
    const p = applyDnsProvider(dnsIndex);
    try {
      if (win && win.webContents) win.webContents.send('silence:dns-switched', { provider: p.label, reason: String(reason || '') });
    } catch (e) {}
    try { if (contents && !contents.isDestroyed() && contents.reload) contents.reload(); } catch (e) {}
    return p;
  }

  const DNS_FAILURES = /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_FAILED|ERR_INTERNET_DISCONNECTED|ERR_DNS_|ERR_PROXY_CONNECTION_FAILED/;

  app.on('web-contents-created', (event, contents) => {
    const track = (url) => {
      try {
        if (contents.getType && contents.getType() !== 'webview') return;
        const prev = pendingLoads.get(contents.id);
        if (prev && prev.timer) clearTimeout(prev.timer);
        const timer = setTimeout(() => {
          pendingLoads.delete(contents.id);
          if (!dnsConfig.enabled) return;
          switchDns('took longer than ' + Math.round(dnsConfig.threshold / 1000) + 's', contents);
        }, Math.max(2000, Number(dnsConfig.threshold) || 8000));
        pendingLoads.set(contents.id, { url: url, timer: timer });
      } catch (e) {}
    };
    const clear = () => {
      const p = pendingLoads.get(contents.id);
      if (p && p.timer) clearTimeout(p.timer);
      pendingLoads.delete(contents.id);
    };
    contents.on('did-start-navigation', (e, url) => { if (url && url !== 'about:blank') track(url); });
    contents.on('did-finish-load', clear);
    contents.on('did-fail-load', (e, code, desc, failedUrl, isMainFrame) => {
      clear();
      if (!isMainFrame || !dnsConfig.enabled) return;
      if (DNS_FAILURES.test(String(desc || '')) || code === -105 || code === -106 || code === -109) {
        switchDns(desc || 'name not resolved', contents);
      }
    });
  });

  ipcMain.handle('silence:dns-config', async (event, arg) => {
    if (arg && typeof arg.enabled === 'boolean') dnsConfig.enabled = !!arg.enabled;
    if (arg && arg.threshold) dnsConfig.threshold = Math.max(2000, Math.min(60000, Number(arg.threshold) || 8000));
    return { success: true, config: dnsConfig, current: dnsProvider(dnsIndex) };
  });

  ipcMain.handle('silence:dns-apply', async (event, arg) => {
    const want = String((arg && arg.provider) || '').toLowerCase();
    let idx = dnsIndex;
    DNS_PROVIDERS.forEach((p, i) => { if (p.id === want) idx = i; });
    dnsIndex = idx;
    const p = applyDnsProvider(dnsIndex);
    return { success: true, current: p, providers: DNS_PROVIDERS };
  });

  /* --------------------------------------------------------- private tabs */
  function privateSession(partition) {
    try {
      const { session } = require('electron');
      return session.fromPartition(String(partition || ''), { cache: false });
    } catch (e) { return null; }
  }

  ipcMain.handle('silence:private-init', async (event, arg) => {
  const partition = String((arg && arg.partition) || '');
  if (!/^private-[\w-]+$/.test(partition)) return { success: false, error: 'Not a private partition name' };
  const ses = privateSession(partition);
  if (!ses) return { success: false, error: 'Could not create a private session' };
  try {
    ses.__partitionName = partition;
    ses.setUserAgent(CHROME_UA);

    ses.setPermissionRequestHandler((wc, permission, cb) => {
      cb(permission === 'fullscreen' || permission === 'pointerLock' || permission === 'clipboard-sanitized-write' || permission === 'storage-access');
    });
    ses.setPermissionCheckHandler((wc, permission) => {
      return permission === 'fullscreen' || permission === 'pointerLock' || permission === 'clipboard-sanitized-write';
    });

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const h = details.requestHeaders;
      h['User-Agent'] = CHROME_UA;
      h['Sec-CH-UA'] = '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"';
      h['Sec-CH-UA-Mobile'] = '?0';
      h['Sec-CH-UA-Platform'] = '"Windows"';
      callback({ cancel: false, requestHeaders: h });
    });

    if (ses.configureHostResolver) {
      ses.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: [dnsProvider(dnsIndex).url] });
    }
  } catch (e) {}

  const proxy = String((arg && arg.proxy) || '').trim();
  let proxied = false;
  if (proxy && /^(socks5|socks4|http|https):\/\/[^\s]+$/.test(proxy)) {
    try { await ses.setProxy({ proxyRules: proxy, proxyBypassRules: '<-loopback>' }); proxied = true; } catch (e) {}
  }
  return { success: true, partition: partition, proxied: proxied, dns: dnsProvider(dnsIndex).label };
});
ipcMain.handle('silence:freeze-tab', async (event, webContentsId) => {
  try {
    const { webContents } = require('electron');
    const wc = webContents.fromId(webContentsId);
    if (wc && wc.debugger && wc.debugger.isAttached()) {
      await wc.debugger.sendCommand('Page.setWebLifecycleState', { state: 'frozen' });
      return { success: true };
    }
  } catch (e) {}
  return { success: false };
});

ipcMain.handle('silence:unfreeze-tab', async (event, webContentsId) => {
  try {
    const { webContents } = require('electron');
    const wc = webContents.fromId(webContentsId);
    if (wc && wc.debugger && wc.debugger.isAttached()) {
      await wc.debugger.sendCommand('Page.setWebLifecycleState', { state: 'active' });
      return { success: true };
    }
  } catch (e) {}
  return { success: false };
});

  ipcMain.handle('silence:private-proxy', async (event, arg) => {
    const partition = String((arg && arg.partition) || '');
    if (!/^private-[\w-]+$/.test(partition)) return { success: false, error: 'Not a private partition name' };
    const ses = privateSession(partition);
    const proxy = String((arg && arg.proxy) || '').trim();
    try {
      if (!proxy) { await ses.setProxy({ mode: 'system' }); return { success: true, proxied: false }; }
      if (!/^(socks5|socks4|http|https):\/\/[^\s]+$/.test(proxy)) return { success: false, error: 'Proxy must look like socks5://127.0.0.1:9050' };
      await ses.setProxy({ proxyRules: proxy, proxyBypassRules: '<-loopback>' });
      return { success: true, proxied: true };
    } catch (e) { return { success: false, error: (e && e.message) || String(e) }; }
  });


  /* Kept on disk only so the leak guard can be applied before app ready,
     which is the only moment Chromium accepts the switch. */
  ipcMain.handle('silence:privacy-prefs', async (event, arg) => {
    try { saveStore('silence_privacy_prefs.json', arg || {}); } catch (e) {}
    return { success: true };
  });
  /* ======================================================================
     App updater — Chrome's flow, end to end.
     Poll a version feed -> download the new build in the background while
     showing real progress -> "Relaunch to update".
     The feed is the GitHub Releases API of the project repo.  Point it
     somewhere else with SILENCE_UPDATE_REPO (owner/repo) or SILENCE_UPDATE_URL
     (any JSON feed shaped like { tag_name, assets:[{name,browser_download_url}] }).
     ====================================================================== */
  const UPDATE_REPO = process.env.SILENCE_UPDATE_REPO || 'Shreyas2006-oss/browser';
  const UPDATE_HEADERS = { 'User-Agent': 'Silence-Browser', 'Accept': 'application/vnd.github+json' };
  const UPDATE_PAGE = 'github.com/' + UPDATE_REPO + '/releases';
  const NO_RELEASE = { __noRelease: true };

  async function fetchLatestRelease() {
    const { net } = require('electron');
    const custom = process.env.SILENCE_UPDATE_URL;
    if (custom) {
      const r = await net.fetch(custom, { headers: UPDATE_HEADERS }).catch(() => null);
      if (r && r.ok) return await r.json().catch(() => null);
    }
    const res = await net.fetch('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest', { headers: UPDATE_HEADERS }).catch(() => null);
    if (res && res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.tag_name) return data;
    }
    if (res && res.status === 404) {
      /* Nothing published as a release. Fall back to a version.json sitting in
       * the repo, which is much lighter to ship: upload one small file instead
       * of creating a tag and attaching an installer. */
      const raw = process.env.SILENCE_VERSION_JSON ||
                  ('https://raw.githubusercontent.com/' + UPDATE_REPO + '/main/version.json');
      const r2 = await net.fetch(raw, { headers: { 'User-Agent': 'Silence-Browser' } }).catch(() => null);
      if (r2 && r2.ok) {
        const j = await r2.json().catch(() => null);
        if (j && j.version) {
          return {
            tag_name: String(j.version),
            body: j.notes || '',
            published_at: j.publishedAt || null,
            assets: j.url ? [{ name: j.file || 'Silence-Setup.exe', browser_download_url: j.url, size: j.size || 0 }] : []
          };
        }
      }
      return NO_RELEASE;
    }
    return null;
  }

  async function checkAppUpdate() {
    const currentVersion = app.getVersion();
    try {
      const data = await fetchLatestRelease();
      if (!data) {
        return { status: 'error', currentVersion, error: 'Could not reach the update feed (' + UPDATE_REPO + ')' };
      }
      if (data.__noRelease) {
        return { status: 'up-to-date', currentVersion, latestVersion: currentVersion, checkedAt: Date.now(),
                 note: 'No update published yet — publish a GitHub release at ' + UPDATE_PAGE +
                       ', or upload a version.json to the repo.' };
      }
      if (!data.tag_name) {
        return { status: 'error', currentVersion, error: 'The update feed replied, but without a version tag.' };
      }
      const latestVersion = String(data.tag_name).replace(/^v/, '');
      const assets = data.assets || [];
      const asset = assets.find((a) => /\.exe$/i.test(a.name)) ||
                    assets.find((a) => /\.msi$/i.test(a.name)) ||
                    assets.find((a) => /\.zip$/i.test(a.name)) || null;
      if (cmpVersion(latestVersion, currentVersion) <= 0) {
        return { status: 'up-to-date', currentVersion, latestVersion, checkedAt: Date.now() };
      }
      if (!asset) {
        return { status: 'error', currentVersion, latestVersion,
                 error: 'Version ' + latestVersion + ' is published, but no Windows installer is attached to the release.' };
      }
      return {
        status: 'update-available', currentVersion, latestVersion, checkedAt: Date.now(),
        notes: String(data.body || '').replace(/\r/g, '').slice(0, 1200),
        publishedAt: data.published_at || null,
        asset: { name: asset.name, url: asset.browser_download_url, size: asset.size || 0 }
      };
    } catch (err) {
      return { status: 'error', currentVersion, error: (err && err.message) || String(err) };
    }
  }

  ipcMain.handle('silence:check-app-update', async () => checkAppUpdate());

  async function autoCheckAppUpdate() {
    try {
      const r = await checkAppUpdate();
      if (r && r.status === 'update-available' && win && win.webContents) {
        win.webContents.send('silence:app-update-available', r);
      }
    } catch (e) { /* silent — a failed background check must never nag */ }
  }

  ipcMain.handle('silence:download-app-update', async (event, arg) => {
    const url = arg && arg.url;
    if (!url) return { success: false, error: 'No download URL' };
    try {
      const { net } = require('electron');
      const dir = path.join(app.getPath('temp'), 'Silence-Update');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, String((arg && arg.name) || 'Silence-Setup.exe').replace(/[^\w.\- ]/g, '_'));
      const res = await net.fetch(url, { headers: { 'User-Agent': 'Silence-Browser' }, redirect: 'follow' });
      if (!res || !res.ok || !res.body) return { success: false, error: 'Download failed (' + ((res && res.status) || 'no response') + ')' };
      const total = Number(res.headers.get('content-length')) || 0;
      const out = fs.createWriteStream(file);
      const reader = res.body.getReader();
      let got = 0;
      let tick = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        out.write(Buffer.from(chunk.value));
        got += chunk.value.length;
        const now = Date.now();
        if (now - tick > 150 && win && win.webContents) {
          tick = now;
          const pct = total ? Math.min(100, Math.round((got * 100) / total))
                            : Math.max(5, Math.min(95, Math.round(got / 1048576)));
          win.webContents.send('silence:app-update-progress', { received: got, total: total, pct: pct });
        }
      }
      out.end();
      await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
      if (win && win.webContents) win.webContents.send('silence:app-update-progress', { received: got, total: got, pct: 100 });
      return { success: true, path: file, size: got };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('silence:install-app-update', async (event, arg) => {
    const filePath = arg && arg.path;
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: 'The download is gone — please run the update again.' };
    }
    try {
      const { shell } = require('electron');
      if (/\.(exe|msi)$/i.test(filePath)) {
        const { spawn } = require('child_process');
        const child = spawn(filePath, ['/SILENT', '/NORESTART'], { detached: true, stdio: 'ignore' });
        child.on('error', () => { try { shell.openPath(filePath); } catch (e) {} });
        child.unref();
        setTimeout(() => { try { app.quit(); } catch (e) {} }, 1500);
        return { success: true };
      }
      shell.showItemInFolder(filePath);
      return { success: true, opened: true };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  });

  /* Chrome checks on its own: once shortly after launch, then every 6 hours. */
  try {
    setTimeout(autoCheckAppUpdate, 25000);
    setInterval(autoCheckAppUpdate, 6 * 60 * 60 * 1000);
  } catch (e) {}


  /* ======================================================================
     Engine updates — Chromium / Electron.
     Chrome's "Check for updates" upgrades the rendering engine too, and that
     is where security fixes live.  Silence warns "Electron 44.2.0 is out with
     security fixes" — these are the handlers that actually install it.

     Two Windows facts shape this code:
       * npm is a .cmd, which cannot be spawned without a shell. Where npm-cli.js
         can be found we drive node directly instead, which also gives clean exit
         codes and works when npm is not on PATH.
       * you cannot overwrite the Electron you are running from: the files are
         locked. So a failed install offers "Install after restart", which drops
         a batch file, closes Silence, installs, and starts it again.
     ====================================================================== */
  function resolveNpm() {
    const roots = [];
    const push = (d) => { if (d && roots.indexOf(d) < 0) roots.push(d); };
    const env = process.env || {};
    push(env.ProgramFiles ? path.join(env.ProgramFiles, 'nodejs') : '');
    push(env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'nodejs') : '');
    push(env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'nodejs') : '');
    push(env.APPDATA ? path.join(env.APPDATA, 'nvm') : '');
    (String(env.PATH || '').split(path.delimiter) || []).forEach(push);

    for (const root of roots) {
      const cli = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (fs.existsSync(cli)) {
        const node = path.join(root, 'node.exe');
        if (fs.existsSync(node)) return { cmd: node, prefix: [cli], shell: false, how: 'node + npm-cli.js' };
      }
      if (fs.existsSync(path.join(root, 'npm.cmd'))) {
        return { cmd: path.join(root, 'npm.cmd'), prefix: [], shell: true, how: 'npm.cmd' };
      }
    }
    return { cmd: 'npm', prefix: [], shell: process.platform === 'win32', how: 'npm from PATH' };
  }

  function engineInstallArgs(version) {
    return ['install', 'electron@' + version, '--save-exact', '--no-audit', '--no-fund'];
  }

  ipcMain.handle('silence:check-engine-update', async () => {
    const currentElectron = process.versions.electron || '0.0.0';
    const currentChromium = process.versions.chrome || '';
    try {
      const { net } = require('electron');
      const res = await net.fetch('https://registry.npmjs.org/electron', {
        headers: { 'User-Agent': 'Silence-Browser', 'Accept': 'application/json' }
      }).catch(() => null);
      if (!res || !res.ok) return { status: 'error', currentElectron, currentChromium, error: 'Could not reach the npm registry' };
      const data = await res.json().catch(() => null);
      const latest = data && data['dist-tags'] && data['dist-tags'].latest;
      if (!latest) return { status: 'error', currentElectron, currentChromium, error: 'The npm registry did not name a latest version' };
      const newer = cmpVersion(latest, currentElectron) > 0;
      return {
        status: newer ? 'update-available' : 'up-to-date',
        currentElectron, currentChromium, latestElectron: latest,
        packaged: !!app.isPackaged,
        note: app.isPackaged
          ? 'Engine updates run from the source folder. An installed copy updates through the app update above.'
          : ''
      };
    } catch (err) {
      return { status: 'error', currentElectron, currentChromium, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('silence:update-engine', async (event, arg) => {
    const version = String((arg && arg.version) || '').trim();
    if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
      return { success: false, error: 'Not a version I would install: ' + version.slice(0, 40) };
    }
    if (app.isPackaged) {
      return { success: false, error: 'Run this from the source folder — an installed copy cannot replace its own engine.' };
    }
    const cwd = app.getAppPath();
    const npm = resolveNpm();
    const args = npm.prefix.concat(engineInstallArgs(version));
    return await new Promise((resolve) => {
      const { spawn } = require('child_process');
      const child = spawn(npm.cmd, args, { cwd: cwd, shell: npm.shell, windowsHide: true });
      const lines = [];
      const errs = [];
      const pump = (buf) => {
        String(buf).split(/\r?\n/).forEach((line) => {
          const s = line.replace(/\s+$/, '');
          if (!s) return;
          lines.push(s);
          if (lines.length > 400) lines.shift();
          if (/^npm (error|ERR!)/i.test(s)) errs.push(s.replace(/^npm (error|ERR!)\s*/i, ''));
          if (win && win.webContents) win.webContents.send('silence:engine-update-log', s);
        });
      };
      child.stdout.on('data', pump);
      child.stderr.on('data', pump);
      child.on('error', (e) => resolve({
        success: false, error: 'Could not start ' + npm.how + ': ' + ((e && e.message) || e),
        lines: lines.slice(-25), errorLines: errs.slice(0, 10)
      }));
      child.on('close', (code) => {
        if (code === 0) return resolve({ success: true, lines: lines.slice(-25) });
        resolve({
          success: false,
          error: (npm.how === 'node + npm-cli.js' ? 'npm' : npm.cmd) + ' exited with code ' + code +
                 (errs.length ? ' — ' + errs[0].slice(0, 160) : ''),
          lines: lines.slice(-25), errorLines: errs.slice(0, 10)
        });
      });
    });
  });

  /* Windows cannot overwrite a running Electron, so the fallback writes a small
   * batch file, closes Silence, lets npm do its work with everything unlocked,
   * then starts the browser again. It runs in a visible window so you can watch. */
  ipcMain.handle('silence:update-engine-offline', async (event, arg) => {
    const version = String((arg && arg.version) || '').trim();
    if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
      return { success: false, error: 'Not a version I would install: ' + version.slice(0, 40) };
    }
    if (app.isPackaged) {
      return { success: false, error: 'Run this from the source folder — an installed copy cannot replace its own engine.' };
    }
    try {
      const { shell } = require('electron');
      const cwd = app.getAppPath();
      const dir = path.join(app.getPath('temp'), 'Silence-Update');
      fs.mkdirSync(dir, { recursive: true });
      const logFile = path.join(dir, 'engine-update.log');
      const bat = path.join(dir, 'Silence-Engine-Update.bat');
      const drive = cwd.slice(0, 2);
      fs.writeFileSync(bat,
        '@echo off\r\n' +
        'title Silence engine update\r\n' +
        'echo Updating Silence to Electron ' + version + '\r\n' +
        'timeout /t 4 /nobreak >nul\r\n' +
        drive + '\r\n' +
        'cd /d "' + cwd + '"\r\n' +
        'call npm install electron@' + version + ' --save-exact --no-audit --no-fund > "' + logFile + '" 2>&1\r\n' +
        'if errorlevel 1 (\r\n' +
        '  echo.\r\n' +
        '  echo The install failed. The log is at:\r\n' +
        '  echo   ' + logFile + '\r\n' +
        '  echo To go back to the old engine run:  npm install electron@' + (process.versions.electron || '') + ' --save-exact\r\n' +
        '  pause\r\n' +
        ') else (\r\n' +
        '  echo Done. Starting Silence on Electron ' + version + '\r\n' +
        '  call npm start\r\n' +
        ')\r\n', 'utf8');
      shell.openPath(bat);
      setTimeout(() => {
        try { app.exit(0); } catch (e) {}
      }, 1200);
      return { success: true, bat: bat, log: logFile };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('silence:relaunch-app', () => {
    setTimeout(() => {
      try { app.relaunch(); } catch (e) {}
      try { app.exit(0); } catch (e) {}
    }, 400);
    return { success: true };
  });

  ipcMain.handle('silence:download-update', async (event, { url }) => {
    if (!url) return { success: false, error: 'No download URL provided' };
    try {
      pendingUpdateUrl = url;
      session.defaultSession.downloadURL(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  loadSavedExtensionPaths()
    .filter(p => fs.existsSync(p))
    .forEach(p => registerExtension(p).catch(() => {}));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  if (process.platform === 'darwin') return;
  const s = (typeof getSettings === 'function') ? getSettings() : null;
  if (s && s.system && s.system.runInBackground) return;
  if (s && s.privacy && s.privacy.clearOnQuit) {
    try { await runClearOnQuit(); } catch (e) {}
  }
  app.quit();
});