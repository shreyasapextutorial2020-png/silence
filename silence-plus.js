/**
 * Silence Plus — renderer side of the upgrade pack.
 * Adds Chrome/Edge-grade settings sections (with sub-menus), fixes extension
 * removal, adds remove icons, repairs extension pop-ups, and keeps the old
 * settings panels in sync with the new ones.
 */

(function silencePlus() {
  const { ipcRenderer } = (typeof require === 'function') ? require('electron') : {};
  if (!ipcRenderer) { console.warn('[plus] no ipcRenderer — settings add-on disabled'); return; }

  const VERSION = '1.4';
  let S = null;
  let INFO = null;
  let VAULT = [];

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

  function getPath(obj, p) { return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
  function setPath(p, v) {
    const out = {};
    const parts = p.split('.');
    let cur = out;
    parts.forEach((k, i) => { cur = cur[k] = (i === parts.length - 1) ? v : {}; });
    return out;
  }
  async function save(patch) {
    const r = await ipcRenderer.invoke('silence:set-settings', patch);
    if (r && !r.error) S = r;
    return S;
  }

  /* ------------------------- visibility helpers ------------------------- */
  function ensureCss() {
    try {
      const loaded = [...document.styleSheets].some((ss) => (ss.href || '').includes('silence-plus.css'));
      if (loaded) return;
      const fs = require('fs');
      const p = require('path');
      const style = document.createElement('style');
      style.textContent = fs.readFileSync(p.join(__dirname, 'silence-plus.css'), 'utf8');
      document.head.appendChild(style);
      console.log('[plus] css injected from disk');
    } catch (e) { console.warn('[plus] css fallback failed:', e.message); }
  }

  function addToolbarButton() {
    try {
      if (document.getElementById('sp-plus-btn')) return;
      const anchor = document.getElementById('ext-menu-btn');
      if (!anchor || !anchor.parentNode) return;
      const btn = document.createElement('button');
      btn.id = 'sp-plus-btn';
      btn.className = anchor.className || 'icon-btn';
      btn.title = 'Silence Plus — privacy & settings (⚡)';
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>';
      btn.style.cssText = 'width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;color:#a5b4fc';
      btn.onclick = () => {
        try { toggleSettings(true); } catch (e) {}
        setTimeout(() => {
          const nav = document.querySelector('.settings-nav-item[data-sp-nav][data-target="panel-privacy-plus"]');
          if (nav) nav.click();
        }, 60);
      };
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    } catch (e) { console.warn('[plus] toolbar button failed:', e.message); }
  }

  function pill(msg, kind, ms) {
    try {
      let el = document.getElementById('sp-pill');
      if (!el) {
        el = document.createElement('div');
        el.id = 'sp-pill';
        el.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:99999;' +
          'background:#1c1c22;border:1px solid rgba(255,255,255,.12);color:#e8e9ef;padding:11px 16px;' +
          'border-radius:11px;font-size:12.6px;box-shadow:0 14px 40px rgba(0,0,0,.5);display:none;gap:10px;align-items:center';
        document.body.appendChild(el);
      }
      el.innerHTML = '<span style="color:' + (kind === 'error' ? '#f87171' : '#a5b4fc') + '">⚡</span><span>' + esc(msg) + '</span>';
      el.style.display = 'flex';
      clearTimeout(el.__t);
      if (ms !== 0) el.__t = setTimeout(() => { el.style.display = 'none'; }, ms || 9000);
    } catch (e) {}
  }

  /* ---------------------------- sub-menu nav ---------------------------- */
  function subNav(id) {
    const self = ALL_PANELS.find((p) => p.id === id);
    if (!self) return '';
    const root = self.parent ? ALL_PANELS.find((p) => p.id === self.parent) : self;
    if (!root) return '';
    const list = [root].concat(ALL_PANELS.filter((p) => p.parent === root.id));
    if (list.length < 2) return '';
    return '<div class="sp-subnav">' + list.map((p) =>
      '<button class="sp-pill-btn' + (p.id === id ? ' active' : '') + '" data-sp-nav data-target="' + p.id + '" data-label="' + esc(p.label) + '">' + esc(p.label) + '</button>'
    ).join('') + '</div>';
  }

  /* --------------------------- control markup --------------------------- */
  const toggle = (path, label, desc) => {
    const on = !!getPath(S, path);
    return '<div class="setting-card-row"><div><h4>' + esc(label) + '</h4>' +
      (desc ? '<p>' + esc(desc) + '</p>' : '') + '</div>' +
      '<label class="sp-switch"><input type="checkbox" data-sp-toggle="' + path + '"' + (on ? ' checked' : '') + '><span class="sp-slider"></span></label></div>';
  };
  const select = (path, label, desc, options) => {
    const val = getPath(S, path);
    return '<div class="setting-card-row"><div><h4>' + esc(label) + '</h4>' +
      (desc ? '<p>' + esc(desc) + '</p>' : '') + '</div>' +
      '<select class="sp-input" style="min-width:190px" data-sp-select="' + path + '">' +
      options.map((o) => '<option value="' + esc(o.v) + '"' + (String(val) === String(o.v) ? ' selected' : '') + '>' + esc(o.t) + '</option>').join('') +
      '</select></div>';
  };
  const input = (path, label, desc, placeholder) => {
    const val = getPath(S, path) || '';
    return '<div class="setting-card-row"><div><h4>' + esc(label) + '</h4>' +
      (desc ? '<p>' + esc(desc) + '</p>' : '') + '</div>' +
      '<input class="sp-input" data-sp-input="' + path + '" value="' + esc(val) + '" placeholder="' + esc(placeholder || '') + '" spellcheck="false" /></div>';
  };

  /* ------------------------- privacy & security ------------------------- */
  function panelBlocking() {
    const paused = (S.privacy && S.privacy.adBlockPause) || [];
    return subNav('panel-privacy-plus') + '<div class="setting-card">' +
      '<h4>Blocking</h4><p class="sp-desc">Applies instantly — no restart.</p>' +
      toggle('privacy.adBlock', 'Block ads & trackers', 'Ghostery engine when installed, otherwise the built-in filter list.') +
      '<div class="setting-card-row"><div><h4>Pause ad blocking on</h4><p>Sites you want to support — blocking pauses while you are on them.</p></div>' +
        '<div style="display:flex;gap:8px"><input class="sp-input" id="sp-pause-input" placeholder="example.com" style="min-width:170px" spellcheck="false" />' +
        '<button class="sp-btn" data-sp-action="pause-add">Add</button></div></div>' +
      '<div class="sp-chips">' + (paused.length
        ? paused.map((h) => '<span class="sp-chip">' + esc(h) + '<button data-sp-action="pause-del" data-host="' + esc(h) + '">×</button></span>').join('')
        : '<span class="sp-hint" style="margin:0">No paused sites.</span>') + '</div>' +
      toggle('privacy.blockPopups', 'Block pop-ups', 'Off by default. Turn on to stop ad popunders opening new tabs.') +
      '</div>';
  }

  function panelNet() {
    return subNav('panel-privacy-net') + '<div class="setting-card">' +
      '<h4>Network & DNS</h4>' +
      toggle('privacy.httpsFirst', 'HTTPS-First mode', 'Upgrades http:// navigations to https:// when a secure version exists.') +
      select('privacy.doh', 'Secure DNS (DoH)', 'Encrypts DNS lookups your ISP would otherwise see.', [
        { v: 'off', t: 'Off (system DNS)' }, { v: 'automatic', t: 'Automatic' }, { v: 'secure', t: 'Secure only' }
      ]) +
      select('privacy.dohProvider', 'DNS provider', '', [
        { v: 'cloudflare', t: 'Cloudflare' }, { v: 'google', t: 'Google' }, { v: 'quad9', t: 'Quad9' }, { v: 'adguard', t: 'AdGuard' }
      ]) +
      toggle('privacy.doNotTrack', 'Send Do-Not-Track & GPC', 'Adds DNT: 1 and Sec-GPC: 1 to every request.') +
      '</div>';
  }

  function panelData() {
    const items = (S.privacy && S.privacy.clearOnQuitItems) || [];
    return subNav('panel-privacy-data') + '<div class="setting-card">' +
      '<h4>Clear browsing data</h4>' +
      toggle('privacy.clearOnQuit', 'Clear when Silence closes', 'Runs automatically on quit.') +
      '<div class="setting-card-row"><div><h4>What to clear</h4></div><div class="sp-chips" style="margin-top:0">' +
        ['cache', 'storage', 'cookies'].map((k) =>
          '<label class="sp-chip" style="cursor:pointer"><input type="checkbox" data-sp-action="clear-item" value="' + k + '"' +
          (items.includes(k) ? ' checked' : '') + ' style="accent-color:#6366f1"> ' + k + '</label>').join('') +
      '</div></div>' +
      '<div style="margin-top:14px"><button class="sp-btn" data-sp-action="clear-now">Clear now…</button></div>' +
      '</div>';
  }

  /* ---------------------------- site settings --------------------------- */
  const PERMS = [
    ['camera', 'Camera'], ['microphone', 'Microphone'], ['geolocation', 'Location'],
    ['notifications', 'Notifications'], ['clipboard-sanitized-write', 'Clipboard'], ['display-capture', 'Screen capture']
  ];

  function panelPerms() {
    const log = (S.permissionLog || []).slice(0, 12);
    const defs = S.permissionDefaults || {};
    return subNav('panel-sites') + '<div class="setting-card"><h4>Default behaviour</h4>' +
      '<p class="sp-desc">What happens when a site asks. “Ask” blocks it and lists the request below so you can allow it.</p>' +
      PERMS.map(([k, label]) => {
        const cur = defs[k] || 'ask';
        return '<div class="setting-card-row"><div><h4>' + esc(label) + '</h4></div>' +
          '<select class="sp-input" style="min-width:130px" data-sp-action="perm-default" data-perm="' + k + '">' +
          ['ask', 'allow', 'deny'].map((v) => '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' +
            (v === 'ask' ? 'Ask (block + log)' : v === 'allow' ? 'Allow' : 'Block') + '</option>').join('') +
          '</select></div>';
      }).join('') + '</div>' +
      '<div class="setting-card"><h4>Recent permission requests</h4>' +
      (log.length
        ? '<table class="sp-table"><tr><th>Site</th><th>Permission</th><th style="text-align:right">Action</th></tr>' +
          log.map((r) => '<tr><td class="mono">' + esc(r.origin) + '</td><td>' + esc(r.permission) + '</td><td style="text-align:right">' +
            '<button class="sp-btn small" data-sp-action="perm-allow" data-origin="' + esc(r.origin) + '" data-perm="' + esc(r.permission) + '">Allow</button> ' +
            '<button class="sp-btn small danger" data-sp-action="perm-deny" data-origin="' + esc(r.origin) + '" data-perm="' + esc(r.permission) + '">Block</button></td></tr>').join('') + '</table>'
        : '<div class="sp-empty">Nothing blocked yet.</div>') + '</div>';
  }

  function panelZoom() {
    const zoom = (S.sites && S.sites.zoom) || {};
    const rows = Object.keys(zoom).map((h) =>
      '<tr><td class="mono">' + esc(h) + '</td><td>' + Math.round(zoom[h] * 100) + '%</td>' +
      '<td style="text-align:right"><button class="sp-btn small danger" data-sp-action="zoom-del" data-host="' + esc(h) + '">Remove</button></td></tr>').join('');
    return subNav('panel-sites-zoom') + '<div class="setting-card"><h4>Per-site zoom</h4>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<input class="sp-input" id="sp-zoom-host" placeholder="example.com" style="min-width:170px" spellcheck="false" />' +
        '<input class="sp-input" id="sp-zoom-val" type="number" min="25" max="500" step="5" value="125" style="min-width:90px" />' +
        '<button class="sp-btn" data-sp-action="zoom-add">Add</button></div>' +
      (rows ? '<table class="sp-table"><tr><th>Site</th><th>Zoom</th><th></th></tr>' + rows + '</table>'
            : '<div class="sp-hint">No per-site zoom levels.</div>') + '</div>';
  }

  /* ------------------------------- passwords ---------------------------- */
  function panelPasswords() {
    const items = VAULT || [];
    return '<div class="setting-card"><h4>Saved passwords</h4>' +
      '<p class="sp-desc">' + (INFO && INFO.encryption ? 'Encrypted with your OS keychain (safeStorage).'
        : '⚠️ OS encryption unavailable — passwords are stored as plain text.') + '</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
        '<input class="sp-input" id="sp-v-site" placeholder="Site (example.com)" style="min-width:170px" />' +
        '<input class="sp-input" id="sp-v-user" placeholder="Username" style="min-width:150px" />' +
        '<input class="sp-input" id="sp-v-pass" type="password" placeholder="Password" style="min-width:150px" />' +
        '<button class="sp-btn primary" data-sp-action="vault-add">Save</button></div>' +
      (items.length
        ? '<table class="sp-table"><tr><th>Site</th><th>Username</th><th style="text-align:right">Actions</th></tr>' +
          items.map((v) => '<tr><td class="mono">' + esc(v.site) + '</td><td>' + esc(v.username) + '</td><td style="text-align:right">' +
            '<button class="sp-btn small" data-sp-action="vault-fill" data-id="' + esc(v.id) + '">Fill</button> ' +
            '<button class="sp-btn small" data-sp-action="vault-copy" data-id="' + esc(v.id) + '">Copy</button> ' +
            '<button class="sp-btn small danger" data-sp-action="vault-del" data-id="' + esc(v.id) + '">Delete</button></td></tr>').join('') + '</table>'
        : '<div class="sp-empty">No saved passwords.</div>') +
      '<p class="sp-hint">“Fill” injects the credentials into the login form of the current tab.</p></div>';
  }

  const LANGS = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['hi-IN', 'हिन्दी'], ['de-DE', 'Deutsch'],
    ['fr-FR', 'Français'], ['es-ES', 'Español'], ['pt-BR', 'Português (BR)'], ['it-IT', 'Italiano'],
    ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['zh-CN', '中文 (简体)'], ['ru-RU', 'Русский']];

  function panelLanguages() {
    const sel = (S.languages && S.languages.languages) || ['en-US'];
    return '<div class="setting-card"><h4>Spell check</h4>' +
      toggle('languages.spellcheck', 'Check spelling while typing', 'Applied to text fields on web pages.') +
      '<div class="setting-card-row"><div><h4>Languages</h4><p>Dictionaries used for spell checking.</p></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:7px;max-width:420px;justify-content:flex-end">' +
      LANGS.map(([code, name]) =>
        '<label class="sp-chip" style="cursor:pointer"><input type="checkbox" data-sp-action="lang" value="' + code + '"' +
        (sel.includes(code) ? ' checked' : '') + ' style="accent-color:#6366f1"> ' + esc(name) + '</label>').join('') +
      '</div></div></div>';
  }

  function panelDownloads() {
    return '<div class="setting-card"><h4>Downloads</h4>' +
      input('downloads.path', 'Download location', 'Leave empty to use your system Downloads folder.', (INFO && INFO.downloads) || '') +
      '<div style="margin-top:-6px;margin-bottom:12px"><button class="sp-btn" data-sp-action="pick-folder">Choose folder…</button> ' +
      '<button class="sp-btn" data-sp-action="open-downloads">Open folder</button></div>' +
      toggle('downloads.ask', 'Ask where to save each file', 'Shows a save dialog instead of downloading automatically.') +
      '</div>';
  }

  const ENGINES = [
    ['https://www.google.com/search?q=', 'Google'], ['https://duckduckgo.com/?q=', 'DuckDuckGo'],
    ['https://www.bing.com/search?q=', 'Bing'], ['https://search.brave.com/search?q=', 'Brave'],
    ['https://lite.duckduckgo.com/lite/?q=', 'DuckDuckGo Lite'], ['https://www.startpage.com/sp/search?query=', 'Startpage'],
    ['https://www.ecosia.org/search?q=', 'Ecosia']
  ];
  const engineName = (u) => {
    const hit = ENGINES.find((e) => e[0] === u);
    return hit ? hit[1] : String(u || '').replace(/^https?:\/\//, '').split('/')[0] || '—';
  };
  function setEngineName(u) {
    const el = document.querySelector('.sp-engine-name');
    if (el) el.textContent = engineName(u != null ? u : (S.search && S.search.engine));
  }

  function panelSearch() {
    const engines = ENGINES;
    const legacy = document.getElementById('engine-select');
    const cur = (S.search && S.search.engine) || localStorage.getItem('silence_search_engine') || (legacy && legacy.value) || engines[0][0];
    return '<div class="setting-card"><h4>Search engine</h4>' +
      '<div class="setting-card-row"><div><p class="sp-desc">Used by the address bar and the new-tab search box.</p></div>' +
      '<select class="sp-input" style="min-width:200px" data-sp-action="engine">' +
      engines.map(([u, n]) => '<option value="' + esc(u) + '"' + (cur === u ? ' selected' : '') + '>' + n + '</option>').join('') +
      '</select></div></div>' +
      '<div class="setting-card"><h4>On startup</h4>' +
      select('search.startup', 'When Silence opens', '', [
        { v: 'blank', t: 'Open a new tab' }, { v: 'restore', t: 'Continue where you left off' }, { v: 'homepage', t: 'Open the homepage' }
      ]) +
      input('search.homepage', 'Homepage', 'Used by the home button and “Open the homepage”.', 'https://www.google.com') +
      '<div style="margin-top:10px"><button class="sp-btn" data-sp-action="restore-now">Restore saved session now</button></div></div>' +
      '<div class="setting-card"><h4>New tab</h4>' +
      select('search.newTab', 'New tabs show', '', [
        { v: 'home', t: 'Silence home screen' }, { v: 'blank', t: 'A blank page' }
      ]) + '</div>';
  }

  function panelPerf() {
    return subNav('panel-system') + '<div class="setting-card"><h4>Performance & system</h4>' +
      toggle('system.hardwareAcceleration', 'Use hardware acceleration', 'Turn off if you see flickering or black video. Needs a restart.') +
      '<div style="margin:10px 0 14px"><button class="sp-btn" data-sp-action="relaunch">Restart Silence</button></div>' +
      toggle('system.runInBackground', 'Keep running in the background', 'Silence stays alive after you close the window.') +
      toggle('system.animations', 'Interface animations', 'Off gives a snappier, more “silent” feel.') +
      '</div>' +
      '<div class="setting-card"><h4>Trackpad gestures</h4>' +
      select('gestures.swipe', 'Two-finger swipe to navigate', 'Swipe left/right with two fingers to go back and forward.', [
        { v: 'high', t: 'On — normal' }, { v: 'low', t: 'On — sensitive (shorter swipe)' }, { v: 'off', t: 'Off' }
      ]) +
      '<p class="sp-hint">The swipe is processed once per frame instead of once per wheel event, so it follows your fingers without stutter.</p></div>';
  }

  function panelDrm() {
    const wv = INFO && INFO.widevine;
    return subNav('panel-system-drm') + '<div class="setting-card"><h4>DRM & streaming</h4>' +
      '<div class="setting-card-row"><div>' +
      (wv ? '<span class="sp-badge ok">● Widevine ' + esc(wv.version) + ' — ' + esc(wv.source) + '</span>'
          : '<span class="sp-badge warn">● Widevine not found</span>') +
      '<div class="sp-hint">' + (wv ? esc(wv.path) : 'Install Google Chrome or Microsoft Edge, then restart Silence.') + '</div></div>' +
      toggle('drm.enabled', 'Enable DRM playback', '') + '</div>' +
      input('drm.path', 'Manual Widevine folder', 'Optional — the folder containing widevinecdm.dll.', 'C:\\…\\WidevineCdm\\4.10.2710.0\\_platform_specific\\win_x64') +
      '<div style="margin-top:10px"><button class="sp-btn" data-sp-action="pick-drm">Browse…</button></div>' +
      '<p class="sp-hint">Chrome only downloads Widevine the first time you play protected video, so play something on Netflix/Prime in Chrome once, then restart Silence.</p></div>' +
      '<div class="setting-card"><h4>Extensions</h4>' +
      toggle('extensions.advancedApis', 'Advanced extension APIs', 'Loads electron-chrome-extensions for chrome.tabs / contextMenus / windows support. Needs a restart.') +
      '<p class="sp-hint">Install with: <code>npm i electron-chrome-extensions</code></p></div>';
  }

  function panelReset() {
    const curVer = (INFO && INFO.version) || '2.1.0';
    const curArch = (INFO && INFO.platform && INFO.platform.includes('64')) ? '64-bit' : '32-bit';

    return '<div class="setting-card" id="sp-about-card">' +
      '<div style="display:flex; align-items:center; gap:16px;">' +
        '<img src="icon.jpg" onerror="this.src=\'icon.ico\'" style="width:44px; height:44px; border-radius:10px; object-fit:cover; box-shadow:0 0 14px var(--accent-glow);" />' +
        '<div style="flex:1;">' +
          '<h4 style="margin:0; font-size:15px; font-weight:600;">Silence</h4>' +
          '<p style="margin:2px 0 0; font-size:12.2px; color:var(--text-muted);">Version ' + esc(curVer) + ' (Official Build) (' + esc(curArch) + ')</p>' +
        '</div>' +
        '<button class="sp-btn primary" id="sp-check-update-btn" data-sp-action="check-update">Check for updates</button>' +
      '</div>' +
      '<div id="sp-update-status" style="margin-top:12px; font-size:12.4px; display:flex; align-items:center; gap:8px;">' +
        '<span class="sp-badge ok">✓ Silence is up to date</span>' +
      '</div>' +
      '</div>' +
            '<div class="setting-card" id="sp-engine-card"><h4>Browser engine</h4>' +
      '<div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">' +
        '<div style="flex:1; font-size:12.2px; color:var(--text-muted);">Chromium ' + esc(INFO && INFO.chrome) +
          ' · Electron ' + esc(INFO && INFO.electron) + '</div>' +
        '<button class="sp-btn" id="sp-engine-check-btn" data-sp-action="engine-check">Check for engine update</button>' +
      '</div>' +
      '<div id="sp-engine-status" style="margin-top:10px; font-size:12.4px;"></div>' +
      '</div>' +
      privacyCard() +
'<div class="setting-card"><h4>Reset</h4>' +
      '<div class="setting-card-row"><div><h4>Restore settings to defaults</h4><p>Keeps passwords, extensions and browsing data.</p></div>' +
      '<button class="sp-btn danger" data-sp-action="reset-settings">Reset settings</button></div>' +
      '<div class="setting-card-row"><div><h4>Clear all browsing data</h4><p>Cache, cookies, site storage and service workers.</p></div>' +
      '<button class="sp-btn danger" data-sp-action="clear-now">Clear data…</button></div></div>' +
      '<div class="setting-card"><h4>System Specifications</h4><div class="sp-grid2">' +
      [['Electron', INFO && INFO.electron], ['Chromium', INFO && INFO.chrome], ['Node', INFO && INFO.node],
       ['Platform', INFO && INFO.platform], ['Profile folder', INFO && INFO.userData], ['Downloads', INFO && INFO.downloads],
       ['Extensions', INFO && INFO.extensions], ['Encryption', INFO && (INFO.encryption ? 'available' : 'unavailable')]]
        .map(([k, v]) => '<div class="sp-fact"><label>' + esc(k) + '</label><div>' + esc(v || '—') + '</div></div>').join('') +
      '</div><div style="margin-top:14px;display:flex;gap:9px;flex-wrap:wrap">' +
      '<button class="sp-btn" data-sp-action="open-profile">Open profile folder</button>' +
      '<button class="sp-btn" data-sp-action="open-ext">Open extensions folder</button>' +
      '<button class="sp-btn" data-sp-action="open-store">Open Extension Store</button></div></div>';
  }

  /* ------------------------------ panel list ---------------------------- */
  const PANELS = [
    { id: 'panel-privacy-plus', icon: '🔒', label: 'Privacy & security', group: 'Browser', render: panelBlocking, children: [
      { id: 'panel-privacy-net', label: 'Network & DNS', render: panelNet },
      { id: 'panel-privacy-data', label: 'Clear data', render: panelData }
    ] },
    { id: 'panel-sites', icon: '🌐', label: 'Site settings', group: 'Browser', render: panelPerms, children: [
      { id: 'panel-sites-zoom', label: 'Zoom', render: panelZoom }
    ] },
    { id: 'panel-autofill', icon: '🔑', label: 'Passwords', group: 'You', render: panelPasswords },
    { id: 'panel-languages', icon: '🌍', label: 'Languages', group: 'Browser', render: panelLanguages },
    { id: 'panel-downloads', icon: '⬇️', label: 'Downloads', group: 'Browser', render: panelDownloads },
    { id: 'panel-search-plus', icon: '🔎', label: 'Search & startup', group: 'Browser', render: panelSearch },
    { id: 'panel-system', icon: '⚙️', label: 'System', group: 'Advanced', render: panelPerf, children: [
      { id: 'panel-system-drm', label: 'DRM & streaming', render: panelDrm }
    ] },
    { id: 'panel-reset', icon: '🔄', label: 'Reset & about', group: 'Advanced', render: panelReset }
  ];
  PANELS.forEach((p) => (p.children || []).forEach((c) => { c.parent = p.id; c.group = p.group; c.icon = p.icon; }));
  const ALL_PANELS = PANELS.concat(...PANELS.map((p) => p.children || []));

  /* -------------------------------- build ------------------------------- */
  function buildNav() {
    const sidebar = $('.settings-sidebar');
    if (!sidebar || sidebar.querySelector('[data-sp-nav]')) return;
    let html = '';
    let group = '';
    PANELS.forEach((p) => {
      if (p.group !== group) { group = p.group; html += '<div class="sp-nav-sep">' + esc(group) + '</div>'; }
      html += '<button class="settings-nav-item" data-sp-nav data-target="' + p.id + '" data-label="' + esc(p.label) + '"><span>' + p.icon + '</span>' + esc(p.label) + '</button>';
      (p.children || []).forEach((c) => {
        html += '<button class="settings-nav-item sp-sub" data-sp-nav data-parent="' + p.id + '" data-target="' + c.id + '" data-label="' + esc(c.label) + '">' + esc(c.label) + '</button>';
      });
    });
    const search = '<div id="sp-nav-search-wrap"><input class="sp-input" id="sp-nav-search" placeholder="Search settings" spellcheck="false" /></div>';
    sidebar.insertAdjacentHTML('afterbegin', search);
    sidebar.insertAdjacentHTML('beforeend', html);
  }

  function buildPanels() {
    const area = $('.settings-content-area');
    if (area) { area.classList.add('sp-area'); }
    if (!area) return;
    ALL_PANELS.forEach((p) => {
      let el = document.getElementById(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'settings-panel-section sp-panel';
        el.id = p.id;
        area.appendChild(el);
      }
      try { el.innerHTML = p.render(); }
      catch (e) { el.innerHTML = '<div class="setting-card"><h4>This section failed to render</h4><p class="sp-desc">' + esc(e.message) + '</p></div>'; }
    });
  }

  function refresh() {
    buildPanels();
    const active = document.querySelector('.settings-nav-item.active[data-sp-nav]');
    if (active) showPanel(active.dataset.target);
    else updateSubVisibility('');
  }

  function rootOf(id) {
    const p = ALL_PANELS.find((x) => x.id === id);
    return (p && p.parent) || id;
  }

  /** sub-pages are only shown for the section you are actually in (Chrome-style) */
  function updateSubVisibility(activeId) {
    const root = rootOf(activeId);
    document.querySelectorAll('.settings-nav-item.sp-sub').forEach((b) => {
      b.style.display = (b.dataset.parent === root || b.dataset.target === activeId) ? '' : 'none';
    });
  }

  function showPanel(id) {
    document.querySelectorAll('.settings-panel-section').forEach((x) => x.classList.remove('active'));
    updateSubVisibility(id);
    const panel = document.getElementById(id);
    if (panel) panel.classList.add('active');
    const btn = document.querySelector('.settings-nav-item[data-sp-nav][data-target="' + id + '"]');
    if (btn) {
      document.querySelectorAll('.settings-nav-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const title = document.getElementById('settings-panel-title');
      if (title) { title.textContent = btn.dataset.label; try { title.innerText = btn.dataset.label; } catch (e) {} }
    }
    document.querySelectorAll('.sp-pill-btn[data-sp-nav]').forEach((b) => b.classList.toggle('active', b.dataset.target === id));
    const area = $('.settings-content-area');
    if (area) area.scrollTop = 0;
  }

  /* ------------------------------ actions ------------------------------- */
  /* ======================================================================
     App updater UI — the Chrome "About" flow:
       Checking for updates…  ->  Downloading… 47%  ->  Relaunch to update
     ====================================================================== */
  var UPD_ELL = String.fromCharCode(8230);

  function updSize(bytes) {
    var n = Number(bytes) || 0;
    if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n > 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function updAgo(ts) {
    if (!ts) return '';
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  function updSpin(text) {
    return '<span class="sp-badge" style="background:rgba(99,102,241,.15); border-color:rgba(99,102,241,.3); color:#a5b4fc;">' +
      '<span style="display:inline-block; animation:spSpin 1s linear infinite;">' + String.fromCharCode(9203) + '</span> ' +
      esc(text) + '</span>';
  }

  function updBar() {
    return '<div id="sp-update-bar" style="display:none; margin-top:10px; height:6px; border-radius:99px; background:rgba(255,255,255,.08); overflow:hidden;">' +
      '<div id="sp-update-fill" style="height:100%; width:0%; border-radius:99px; background:linear-gradient(90deg, var(--accent, #6366f1), #7dd3fc); transition:width .2s ease;"></div></div>';
  }

  function renderUpdateStatus(box, r, silent) {
    if (!box) return;
    var res = r || {};
    if (res.status === 'update-available') {
      var notes = String(res.notes || '').trim();
      box.innerHTML =
        '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">' +
          '<span class="sp-badge warn">' + String.fromCharCode(9650) + ' Silence ' + esc(res.latestVersion || '') + ' is available</span>' +
          '<span style="color:var(--text-muted); font-size:11.6px;">you have ' + esc(res.currentVersion || '') +
            (res.asset && res.asset.size ? ' · ' + esc(updSize(res.asset.size)) : '') + '</span>' +
        '</div>' +
        (notes ? '<div style="margin-top:8px; max-height:120px; overflow:auto; font-size:11.8px; line-height:1.5; color:var(--text-muted); white-space:pre-wrap;">' + esc(notes) + '</div>' : '') +
        updBar() +
        '<div style="margin-top:10px; display:flex; gap:8px; align-items:center;">' +
          '<button class="sp-btn small primary" data-sp-action="update-now" data-url="' + esc(String((res.asset && res.asset.url) || '')) +
            '" data-name="' + esc(String((res.asset && res.asset.name) || '')) + '">Update now</button>' +
          '<button class="sp-btn small" data-sp-action="check-update">Check again</button>' +
        '</div>';
      if (!silent) pill('Silence ' + (res.latestVersion || '') + ' is available', 'ok', 5000);
      return;
    }
    if (res.status === 'error') {
      box.innerHTML =
        '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">' +
          '<span class="sp-badge danger">' + esc(res.error || 'Could not check for updates') + '</span>' +
          '<button class="sp-btn small" data-sp-action="check-update">Retry</button>' +
        '</div>';
      return;
    }
    box.innerHTML =
      '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">' +
        '<span class="sp-badge ok">' + String.fromCharCode(10003) + ' Silence is up to date</span>' +
        '<span style="color:var(--text-muted); font-size:11.6px;">Version ' + esc(res.currentVersion || '') +
          (res.checkedAt ? ' · checked ' + esc(updAgo(res.checkedAt)) : '') + '</span>' +
      '</div>' +
      (res.note ? '<div style="margin-top:6px; font-size:11.4px; color:var(--text-muted);">' + esc(res.note) + '</div>' : '');
  }


  /* ---- engine card rendering (Chromium / Electron) ---------------------- */
  function renderEngineStatus(box, r) {
    if (!box) return;
    var res = r || {};
    if (res.status === 'update-available') {
      box.innerHTML =
        '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">' +
          '<span class="sp-badge warn">' + String.fromCharCode(9650) + ' Electron ' + esc(res.latestElectron || '') + ' is available</span>' +
          '<span style="color:var(--text-muted); font-size:11.6px;">you have ' + esc(res.currentElectron || '') +
            (res.currentChromium ? ' · Chromium ' + esc(res.currentChromium) : '') + '</span>' +
        '</div>' +
        '<div style="margin-top:6px; font-size:11.6px; color:var(--text-muted);">' +
          (res.packaged
            ? 'Engine updates run from the source folder — an installed copy updates through the release above.'
            : 'Brings a newer Chromium with its security fixes. Downloads about 110 MB, then Silence restarts.') +
        '</div>' +
        '<div id="sp-engine-bar" style="display:none; margin-top:10px; height:6px; border-radius:99px; background:rgba(255,255,255,.08); overflow:hidden;">' +
          '<div id="sp-engine-fill" style="height:100%; width:8%; border-radius:99px; background:linear-gradient(90deg, var(--accent, #6366f1), #7dd3fc); transition:width .3s ease;"></div>' +
        '</div>' +
        '<div id="sp-engine-log" style="display:none; margin-top:8px; max-height:64px; overflow:auto; white-space:pre-wrap; font-size:11px; line-height:1.45; color:var(--text-muted); font-family:ui-monospace, SFMono-Regular, Menlo, monospace;"></div>' +
        '<div style="margin-top:10px; display:flex; gap:8px; align-items:center;">' +
          '<button class="sp-btn small primary" data-sp-action="engine-update" data-version="' + esc(String(res.latestElectron || '')) + '">Update engine</button>' +
          '<button class="sp-btn small" data-sp-action="engine-check">Check again</button>' +
        '</div>';
      return;
    }
    if (res.status === 'error') {
      box.innerHTML =
        '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">' +
          '<span class="sp-badge danger">' + esc(res.error || 'Could not check the engine') + '</span>' +
          '<button class="sp-btn small" data-sp-action="engine-check">Retry</button>' +
        '</div>';
      return;
    }
    box.innerHTML =
      '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">' +
        '<span class="sp-badge ok">' + String.fromCharCode(10003) + ' Engine is up to date</span>' +
        '<span style="color:var(--text-muted); font-size:11.6px;">Electron ' + esc(res.currentElectron || '') +
          (res.currentChromium ? ' · Chromium ' + esc(res.currentChromium) : '') + '</span>' +
      '</div>' +
      (res.note ? '<div style="margin-top:6px; font-size:11.4px; color:var(--text-muted);">' + esc(res.note) + '</div>' : '');
  }


  /* ======================================================================
     Chrome system surfaces — task manager (Shift+Esc), web capture
     (Ctrl+Shift+S) and the downloads manager (Ctrl+J).
     ====================================================================== */
  var SYSPANEL = null;
  var SYSTIMER = null;
  var SYSKIND = '';
  var SYSQUERY = '';

  function fmtMB(kb) {
    var n = Number(kb) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' GB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' MB';
    if (n > 0) return Math.max(1, Math.round(n)) + ' KB';
    return String.fromCharCode(8212);
  }

  function fmtBytes(b) {
    var n = Number(b) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function sysPanelEl() {
    if (SYSPANEL && document.body.contains(SYSPANEL)) return SYSPANEL;
    SYSPANEL = document.createElement('div');
    SYSPANEL.id = 'sp-syspanel';
    SYSPANEL.setAttribute('style',
      'position:fixed; inset:0; z-index:10050; display:flex; align-items:center; justify-content:center;' +
      'background:rgba(0,0,0,.5);');
    SYSPANEL.innerHTML =
      '<div style="width:min(780px, 93vw); max-height:82vh; display:flex; flex-direction:column;' +
        'background:var(--panel-bg, #15161a); color:var(--text, #e8eaed);' +
        'border:1px solid rgba(255,255,255,.10); border-radius:14px; overflow:hidden;' +
        'box-shadow:0 24px 70px rgba(0,0,0,.6);">' +
        '<div style="display:flex; align-items:center; gap:10px; padding:14px 16px; border-bottom:1px solid rgba(255,255,255,.07);">' +
          '<h3 id="sp-syspanel-title" style="margin:0; font-size:14px; font-weight:600;"></h3>' +
          '<input id="sp-syspanel-search" type="text" placeholder="Search" ' +
            'style="flex:1; min-width:120px; margin:0 8px; padding:7px 10px; font-size:12.4px;' +
            'border-radius:8px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.05);' +
            'color:inherit; outline:none; display:none;" />' +
          '<button class="sp-btn small" data-sys-action="refresh">Refresh</button>' +
          '<button class="sp-btn small" data-sys-action="close">Close</button>' +
        '</div>' +
        '<div id="sp-syspanel-body" style="padding:12px 16px; overflow:auto; font-size:12.4px;"></div>' +
        '<div id="sp-syspanel-foot" style="padding:10px 16px; border-top:1px solid rgba(255,255,255,.07); display:flex; align-items:center; gap:10px; color:var(--text-muted, #9aa0aa); font-size:11.6px;"></div>' +
      '</div>';
    document.body.appendChild(SYSPANEL);
    SYSPANEL.addEventListener('input', function (ev) {
      if (ev.target && ev.target.id === 'sp-syspanel-search') {
        SYSQUERY = String(ev.target.value || '');
        renderSysList();
      }
    });
    SYSPANEL.addEventListener('click', function (ev) {
      if (ev.target === SYSPANEL) { closeSysPanel(); return; }
      var act = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-sys-action');
      if (act) sysPanelAction(act, ev.target);
    });
    return SYSPANEL;
  }

  function renderTasks(data) {
    var rows = ((data && data.rows) || []).slice();
    rows.sort(function (a, b) { return (b.memory || 0) - (a.memory || 0); });
    var total = rows.reduce(function (n, r) { return n + (r.memory || 0); }, 0);
    var html = '<table style="width:100%; border-collapse:collapse;">' +
      '<thead><tr style="text-align:left; color:var(--text-muted,#8b909a); font-size:10.5px; text-transform:uppercase; letter-spacing:.05em;">' +
      '<th style="padding:6px 8px;">Task</th><th style="padding:6px 8px; width:104px;">Type</th>' +
      '<th style="padding:6px 8px; width:92px; text-align:right;">Memory</th>' +
      '<th style="padding:6px 8px; width:74px; text-align:right;">CPU</th>' +
      '<th style="padding:6px 8px; width:76px;"></th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var label = r.title || (r.url ? String(r.url).replace(/^https?:\/\//, '').slice(0, 52) : '') || (r.type || 'process');
      html += '<tr style="border-top:1px solid rgba(255,255,255,.05);">' +
        '<td style="padding:7px 8px;">' + esc(label) +
          (r.url ? '<div style="font-size:10.5px; color:var(--text-muted,#6f7480);">' + esc(String(r.url).slice(0, 66)) + '</div>' : '') +
        '</td>' +
        '<td style="padding:7px 8px; color:var(--text-muted,#9aa0aa);">' + esc(r.type || '') + '</td>' +
        '<td style="padding:7px 8px; text-align:right;">' + fmtMB(r.memory) + '</td>' +
        '<td style="padding:7px 8px; text-align:right;">' + (r.cpu ? Number(r.cpu).toFixed(1) + '%' : String.fromCharCode(8212)) + '</td>' +
        '<td style="padding:7px 8px; text-align:right;"><button class="sp-btn small danger" data-sys-action="kill" ' +
          'data-pid="' + esc(String(r.pid || 0)) + '" data-wcid="' + esc(String(r.id || 0)) + '">End</button></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    if (!rows.length) html = '<div style="padding:18px; text-align:center; color:var(--text-muted,#9aa0aa);">Nothing to report.</div>';
    return { html: html, foot: rows.length + ' processes · ' + fmtMB(total) + ' total' };
  }

  function renderDownloads(items) {
    var rows = items || [];
    var html = '';
    if (!rows.length) {
      html = '<div style="padding:22px; text-align:center; color:var(--text-muted,#9aa0aa);">No downloads yet.</div>';
    } else {
      rows.forEach(function (d) {
        var badge = d.state === 'done' ? 'ok' : (d.state === 'failed' || d.state === 'cancelled' ? 'danger' : '');
        html += '<div style="display:flex; align-items:center; gap:10px; padding:9px 0; border-top:1px solid rgba(255,255,255,.05);">' +
          '<div style="flex:1; min-width:0;">' +
            '<div style="font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(d.name || 'download') + '</div>' +
            '<div style="font-size:10.8px; color:var(--text-muted,#8b909a);">' + esc(d.state || '') +
              (d.total ? ' · ' + fmtBytes(d.bytes) + ' of ' + fmtBytes(d.total) : (d.bytes ? ' · ' + fmtBytes(d.bytes) : '')) + '</div>' +
          '</div>' +
          (d.state === 'done' ? '<button class="sp-btn small" data-sys-action="dl-open" data-id="' + esc(d.id) + '">Open</button>' : '') +
          (d.state === 'done' || d.state === 'failed' ? '<button class="sp-btn small" data-sys-action="dl-folder" data-id="' + esc(d.id) + '">Show</button>' : '') +
          (d.state === 'failed' || d.state === 'cancelled' ? '<button class="sp-btn small" data-sys-action="dl-retry" data-id="' + esc(d.id) + '">Retry</button>' : '') +
          (d.state === 'progressing' ? '<button class="sp-btn small danger" data-sys-action="dl-cancel" data-id="' + esc(d.id) + '">Cancel</button>' : '') +
          '<button class="sp-btn small" data-sys-action="dl-remove" data-id="' + esc(d.id) + '">Remove</button>' +
        '</div>';
      });
    }
    return { html: html, foot: rows.length + ' download' + (rows.length === 1 ? '' : 's') };
  }


  function dayLabel(ts) {
    var d = new Date(ts);
    var today = new Date();
    var yest = new Date(Date.now() - 86400000);
    var same = function (a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); };
    if (same(d, today)) return 'Today';
    if (same(d, yest)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }
  function clockLabel(ts) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function faviconImg(f) {
    return f ? '<img src="' + esc(String(f)) + '" style="width:15px; height:15px; border-radius:3px; flex:none;" />'
             : '<span style="width:15px; height:15px; border-radius:3px; flex:none; background:rgba(255,255,255,.10);"></span>';
  }

  function renderHistory(items) {
    var rows = items || [];
    if (!rows.length) return { html: '<div style="padding:22px; text-align:center; color:var(--text-muted,#9aa0aa);">No history yet' +
      (SYSQUERY ? ' matching that search' : '') + '.</div>', foot: '0 visits' };
    var html = '';
    var day = '';
    rows.forEach(function (h) {
      var d = dayLabel(h.visitedAt || h.at || 0);
      if (d !== day) {
        day = d;
        html += '<div style="margin:12px 0 4px; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted,#8b909a);">' + esc(d) + '</div>';
      }
      html += '<div style="display:flex; align-items:center; gap:10px; padding:6px 0;">' +
        faviconImg(h.favicon) +
        '<div style="flex:1; min-width:0;">' +
          '<div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(h.title || h.url || '') + '</div>' +
          '<div style="font-size:10.6px; color:var(--text-muted,#8b909a); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' +
            esc(String(h.url || '')) + '</div>' +
        '</div>' +
        '<span style="font-size:10.6px; color:var(--text-muted,#8b909a);">' + esc(clockLabel(h.visitedAt || h.at || 0)) + '</span>' +
        '<button class="sp-btn small" data-sys-action="hist-open" data-url="' + esc(String(h.url || '')) + '">Open</button>' +
        '<button class="sp-btn small danger" data-sys-action="hist-del" data-id="' + esc(String(h.id || '')) + '">Remove</button>' +
        '</div>';
    });
    return { html: html, foot: rows.length + ' visit' + (rows.length === 1 ? '' : 's') };
  }

  function renderBookmarks(items) {
    var rows = items || [];
    if (!rows.length) return { html: '<div style="padding:22px; text-align:center; color:var(--text-muted,#9aa0aa);">No bookmarks yet.</div>', foot: '0 bookmarks' };
    var byFolder = {};
    rows.forEach(function (b) {
      var f = b.folder || 'Bookmarks';
      (byFolder[f] = byFolder[f] || []).push(b);
    });
    var html = '';
    Object.keys(byFolder).forEach(function (f) {
      html += '<div style="margin:12px 0 4px; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted,#8b909a);">' +
        esc(f) + ' (' + byFolder[f].length + ')</div>';
      byFolder[f].forEach(function (b) {
        html += '<div style="display:flex; align-items:center; gap:10px; padding:6px 0;">' +
          faviconImg(b.favicon) +
          '<div style="flex:1; min-width:0;">' +
            '<div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(b.title || b.url || '') + '</div>' +
            '<div style="font-size:10.6px; color:var(--text-muted,#8b909a); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' +
              esc(String(b.url || '')) + '</div>' +
          '</div>' +
          '<button class="sp-btn small" data-sys-action="bm-open" data-url="' + esc(String(b.url || '')) + '">Open</button>' +
          '<button class="sp-btn small" data-sys-action="bm-move" data-id="' + esc(String(b.id || '')) + '">Move</button>' +
          '<button class="sp-btn small danger" data-sys-action="bm-del" data-id="' + esc(String(b.id || '')) + '">Remove</button>' +
          '</div>';
      });
    });
    return { html: html, foot: rows.length + ' bookmark' + (rows.length === 1 ? '' : 's') };
  }

  async function renderSysList() {
    var body = document.getElementById('sp-syspanel-body');
    var foot = document.getElementById('sp-syspanel-foot');
    if (!body) return;
    try {
      if (SYSKIND === 'tasks') {
        var d = await ipcRenderer.invoke('silence:task-manager');
        var t = renderTasks(d);
        body.innerHTML = t.html; if (foot) foot.textContent = t.foot;
      } else if (SYSKIND === 'history') {
        var h = await ipcRenderer.invoke('silence:history-list', { query: SYSQUERY, limit: 500 });
        var hr = renderHistory((h && h.items) || []);
        body.innerHTML = hr.html;
        if (foot) {
          foot.innerHTML = '<span style="flex:1;">' + esc(hr.foot) + '</span>' +
            '<button class="sp-btn small danger" data-sys-action="hist-clear">Clear history</button>';
        }
      } else if (SYSKIND === 'bookmarks') {
        var b = await ipcRenderer.invoke('silence:bookmarks-list');
        var all = (b && b.items) || [];
        var q = String(SYSQUERY || '').trim().toLowerCase();
        var hits = q ? all.filter(function (x) {
          return (String(x.title || '') + ' ' + String(x.url || '') + ' ' + String(x.folder || '')).toLowerCase().indexOf(q) >= 0;
        }) : all;
        var br = renderBookmarks(hits);
        body.innerHTML = br.html;
        if (foot) {
          foot.innerHTML = '<span style="flex:1;">' + esc(br.foot) + '</span>' +
            '<button class="sp-btn small" data-sys-action="bm-add">Bookmark this page</button>';
        }
      } else {
        var dl = await ipcRenderer.invoke('silence:downloads-list');
        var r = renderDownloads((dl && dl.items) || []);
        body.innerHTML = r.html;
        if (foot) {
          foot.innerHTML = '<span style="flex:1;">' + esc(r.foot) + '</span>' +
            '<button class="sp-btn small" data-sys-action="dl-clear">Clear all</button>';
        }
      }
    } catch (e) {}
  }

  async function refreshSysPanel() { await renderSysList(); }

  async function openSysPanel(kind) {
    SYSKIND = kind;
    var p = sysPanelEl();
    var title = document.getElementById('sp-syspanel-title');
    var names = { tasks: 'Task manager', downloads: 'Downloads', history: 'History', bookmarks: 'Bookmarks' };
    if (title) title.textContent = names[kind] || 'Silence';
    var search = document.getElementById('sp-syspanel-search');
    if (search) {
      search.style.display = (kind === 'history' || kind === 'bookmarks') ? 'block' : 'none';
      search.placeholder = (kind === 'history') ? 'Search history' : 'Search bookmarks';
      search.value = '';
    }
    SYSQUERY = '';
    p.style.display = 'flex';
    await renderSysList();
    if (SYSTIMER) clearInterval(SYSTIMER);
    if (kind === 'tasks' || kind === 'downloads') SYSTIMER = setInterval(renderSysList, kind === 'tasks' ? 2000 : 1500);
  }

  function closeSysPanel() {
    if (SYSTIMER) { clearInterval(SYSTIMER); SYSTIMER = null; }
    if (SYSPANEL) SYSPANEL.style.display = 'none';
    SYSKIND = '';
  }

  async function sysPanelAction(act, el) {
    if (act === 'close') { closeSysPanel(); return; }
    if (act === 'refresh') { await refreshSysPanel(); return; }
    if (act === 'kill') {
      await ipcRenderer.invoke('silence:kill-process', {
        pid: Number(el.getAttribute('data-pid')) || 0,
        id: Number(el.getAttribute('data-wcid')) || 0
      });
      setTimeout(refreshSysPanel, 400);
      return;
    }
    if (act === 'hist-open') {
      var u = el.getAttribute('data-url');
      if (u && typeof createTab === 'function') { createTab(u, true); closeSysPanel(); }
      return;
    }
    if (act === 'hist-del') {
      await ipcRenderer.invoke('silence:history-delete', { id: el.getAttribute('data-id') });
      await renderSysList();
      return;
    }
    if (act === 'hist-clear') {
      await ipcRenderer.invoke('silence:history-clear', {});
      await renderSysList();
      return;
    }
    if (act === 'bm-open') {
      var bu = el.getAttribute('data-url');
      if (bu && typeof createTab === 'function') { createTab(bu, true); closeSysPanel(); }
      return;
    }
    if (act === 'bm-del') {
      await ipcRenderer.invoke('silence:bookmark-remove', { id: el.getAttribute('data-id') });
      await renderSysList();
      return;
    }
    if (act === 'bm-move') {
      var folder = window.prompt('Move to folder:', 'Bookmarks bar');
      if (folder) {
        await ipcRenderer.invoke('silence:bookmark-update', { id: el.getAttribute('data-id'), patch: { folder: folder } });
        await renderSysList();
      }
      return;
    }
    if (act === 'bm-add') {
      try {
        var tab = (typeof tabs !== 'undefined' && typeof activeTabId !== 'undefined')
          ? tabs.filter(function (t) { return t.id === activeTabId; })[0] : null;
        if (!tab || !tab.url) { pill('That tab has no page to bookmark', 'error', 3500); return; }
        await ipcRenderer.invoke('silence:bookmark-add', { url: tab.url, title: tab.title, favicon: tab.favicon });
        pill('Bookmarked', 'ok', 2500);
        await renderSysList();
      } catch (e) {}
      return;
    }
    if (act.indexOf('dl-') === 0) {
      await ipcRenderer.invoke('silence:download-action', {
        action: act.slice(3), id: el.getAttribute('data-id')
      });
      await refreshSysPanel();
    }
  }

  /* Web capture — Ctrl+Shift+S grabs the whole page, not just what is visible. */
  async function runCapture(full) {
    var wcid = 0;
    try {
      var tab = (typeof tabs !== 'undefined' && typeof activeTabId !== 'undefined')
        ? tabs.filter(function (t) { return t.id === activeTabId; })[0] : null;
      if (tab && tab.webview && tab.webview.getWebContentsId) wcid = tab.webview.getWebContentsId();
    } catch (e) {}
    try {
      var r = await ipcRenderer.invoke('silence:capture-page', { id: wcid, full: !!full });
      if (!r || !r.success) {
        if (r && r.canceled) return;
        pill((r && r.error) || 'Capture failed', 'error', 4500);
        return;
      }
      pill('Saved ' + fmtBytes(r.bytes) + (full ? ' (full page)' : ' (visible area)'), 'ok', 4500);
    } catch (e) {
      pill('Capture failed: ' + ((e && e.message) || e), 'error', 4500);
    }
  }


  /* ======================================================================
     Two Chrome affordances:
       * the fullscreen bar that slides in when you move the mouse to the top,
         with an X that leaves fullscreen (Chrome's "hover for the close button")
       * tab search, Chrome's Ctrl+Shift+A
     ====================================================================== */
  var FSBAR = null;
  var FSBAR_TIMER = null;
  var TABSEARCH = null;

  function fsBarEl() {
    if (FSBAR && document.body.contains(FSBAR)) return FSBAR;
    FSBAR = document.createElement('div');
    FSBAR.id = 'sp-fs-bar';
    FSBAR.setAttribute('style',
      'position:fixed; top:0; left:0; right:0; height:42px; z-index:10060;' +
      'display:flex; align-items:center; gap:12px; padding:0 14px;' +
      'background:linear-gradient(180deg, rgba(10,10,12,.94), rgba(10,10,12,.72));' +
      'color:#f2f3f5; font-size:12.4px; transform:translateY(-100%);' +
      'transition:transform .18s ease; backdrop-filter:blur(10px);');
    FSBAR.innerHTML =
      '<span id="sp-fs-host" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.9;"></span>' +
      '<span style="opacity:.55; font-size:11.4px;">Press Esc to exit full screen</span>' +
      '<button id="sp-fs-exit" title="Exit full screen" ' +
        'style="width:30px; height:30px; border-radius:8px; border:1px solid rgba(255,255,255,.14);' +
        'background:rgba(255,255,255,.06); color:#f2f3f5; font-size:15px; line-height:1; cursor:pointer;">' +
        String.fromCharCode(215) + '</button>';
    document.body.appendChild(FSBAR);
    FSBAR.addEventListener('click', function (ev) {
      if (ev.target && ev.target.id === 'sp-fs-exit') exitFullscreenNow();
    });
    return FSBAR;
  }

  function inHtmlFullscreen() {
    try {
      return document.body.classList.contains('html-fs-active') ||
             document.body.classList.contains('html-fullscreen') ||
             !!document.querySelector('.browser-webview.html-fullscreen');
    } catch (e) { return false; }
  }

  function showFsBar() {
    if (!inHtmlFullscreen()) return;
    var bar = fsBarEl();
    var host = document.getElementById('sp-fs-host');
    try {
      var tab = (typeof tabs !== 'undefined' && typeof activeTabId !== 'undefined')
        ? tabs.filter(function (t) { return t.id === activeTabId; })[0] : null;
      if (host) host.textContent = (tab && (tab.title || tab.url)) ? String(tab.title || tab.url) : 'Full screen';
    } catch (e) {}
    bar.style.transform = 'translateY(0)';
    if (FSBAR_TIMER) clearTimeout(FSBAR_TIMER);
    FSBAR_TIMER = setTimeout(hideFsBar, 2600);
  }

  function hideFsBar() {
    if (FSBAR) FSBAR.style.transform = 'translateY(-100%)';
    if (FSBAR_TIMER) { clearTimeout(FSBAR_TIMER); FSBAR_TIMER = null; }
  }

  async function exitFullscreenNow() {
    hideFsBar();
    try {
      var wv = document.querySelector('.browser-webview.html-fullscreen');
      if (!wv) {
        var tab = (typeof tabs !== 'undefined' && typeof activeTabId !== 'undefined')
          ? tabs.filter(function (t) { return t.id === activeTabId; })[0] : null;
        wv = tab && tab.webview;
      }
      if (wv && typeof wv.executeJavaScript === 'function') {
        wv.executeJavaScript('if (document.fullscreenElement) { document.exitFullscreen(); }').catch(function () {});
      }
    } catch (e) {}
    try { await ipcRenderer.invoke('silence:exit-fullscreen'); } catch (e) {}
  }

  /* ------------------------------------------------------------ tab search */
  function tabSearchEl() {
    if (TABSEARCH && document.body.contains(TABSEARCH)) return TABSEARCH;
    TABSEARCH = document.createElement('div');
    TABSEARCH.id = 'sp-tabsearch';
    TABSEARCH.setAttribute('style',
      'position:fixed; top:64px; left:50%; transform:translateX(-50%); width:min(620px, 92vw);' +
      'z-index:10055; background:var(--panel-bg, #15161a); color:var(--text, #e8eaed);' +
      'border:1px solid rgba(255,255,255,.10); border-radius:12px; overflow:hidden;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.55); display:none;');
    TABSEARCH.innerHTML =
      '<input id="sp-tabsearch-input" type="text" placeholder="Search tabs" ' +
        'style="width:100%; padding:13px 15px; font-size:13.5px; background:transparent;' +
        'border:none; outline:none; color:inherit; box-sizing:border-box;" />' +
      '<div id="sp-tabsearch-list" style="max-height:46vh; overflow:auto; border-top:1px solid rgba(255,255,255,.07);"></div>';
    document.body.appendChild(TABSEARCH);
    TABSEARCH.addEventListener('click', function (ev) {
      var id = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-tab-id');
      if (id) tabSearchPick(id);
    });
    TABSEARCH.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        var rows = [].slice.call(TABSEARCH.querySelectorAll('[data-tab-id]'));
        if (!rows.length) return;
        var cur = rows.indexOf(document.activeElement);
        var next = (ev.key === 'ArrowDown') ? Math.min(rows.length - 1, cur + 1) : Math.max(0, cur - 1);
        if (cur < 0) next = 0;
        rows[next].focus();
      } else if (ev.key === 'Enter') {
        var rows2 = [].slice.call(TABSEARCH.querySelectorAll('[data-tab-id]'));
        if (rows2.length) tabSearchPick(rows2[0].getAttribute('data-tab-id'));
      } else if (ev.key === 'Escape') {
        closeTabSearch();
      }
    });
    return TABSEARCH;
  }

  function renderTabSearch(q) {
    var list = document.getElementById('sp-tabsearch-list');
    if (!list) return;
    var all = (typeof tabs !== 'undefined') ? tabs.slice() : [];
    var needle = String(q || '').trim().toLowerCase();
    var hits = needle ? all.filter(function (t) {
      return String(t.title || '').toLowerCase().indexOf(needle) >= 0 ||
             String(t.url || '').toLowerCase().indexOf(needle) >= 0;
    }) : all;
    if (!hits.length) {
      list.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-muted,#9aa0aa);">No matching tabs</div>';
      return;
    }
    list.innerHTML = hits.slice(0, 40).map(function (t, i) {
      var active = (typeof activeTabId !== 'undefined' && t.id === activeTabId);
      return '<div tabindex="0" data-tab-id="' + esc(String(t.id)) + '" ' +
        'style="display:flex; align-items:center; gap:10px; padding:9px 14px; cursor:pointer;' +
        'border-top:' + (i ? '1px solid rgba(255,255,255,.05)' : 'none') + ';' +
        'background:' + (active ? 'rgba(99,102,241,.14)' : 'transparent') + '; outline:none;">' +
        (t.favicon ? '<img src="' + esc(String(t.favicon)) + '" style="width:15px; height:15px; border-radius:3px;" />' : '') +
        '<div style="flex:1; min-width:0;">' +
          '<div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(t.title || 'New Tab') + '</div>' +
          '<div style="font-size:10.6px; color:var(--text-muted,#8b909a); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' +
            esc(String(t.url || '')) + '</div>' +
        '</div>' +
        (active ? '<span style="font-size:10.5px; color:var(--text-muted,#9aa0aa);">current</span>' : '') +
        '</div>';
    }).join('');
  }

  function openTabSearch() {
    var el = tabSearchEl();
    el.style.display = 'block';
    var input = document.getElementById('sp-tabsearch-input');
    if (input) { input.value = ''; input.focus(); }
    renderTabSearch('');
  }

  function closeTabSearch() {
    if (TABSEARCH) TABSEARCH.style.display = 'none';
  }

  function tabSearchPick(id) {
    try { if (typeof switchTab === 'function') switchTab(id); } catch (e) {}
    closeTabSearch();
  }


  /* ======================================================================
     Tab groups, on the horizontal strip: colour, name, collapse.
     The strip is owned by index.html and re-rendered often, so this decorates
     whatever it finds (a MutationObserver re-applies on every change) instead
     of trying to take over rendering.
     ====================================================================== */
  var TABGROUP_KEY = 'silence_tab_groups';
  var GROUP_COLORS = ['#9aa0a6', '#4f8cff', '#f4706a', '#f6c75a', '#5fc98a', '#f07fb6', '#a97bff', '#4fd1e0'];
  var tabGroups = { groups: [], members: {} };

  function hexToRgba(hex, alpha) {
    var h = String(hex || '#888888').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16) || 0;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function loadTabGroups() {
    try {
      var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(TABGROUP_KEY) : null;
      if (raw) {
        var d = JSON.parse(raw);
        if (d && Array.isArray(d.groups)) tabGroups = { groups: d.groups, members: d.members || {} };
      }
    } catch (e) {}
  }
  function saveTabGroups() {
    try { localStorage.setItem(TABGROUP_KEY, JSON.stringify(tabGroups)); } catch (e) {}
  }

  function groupById(id) {
    var hit = null;
    tabGroups.groups.forEach(function (g) { if (g.id === id) hit = g; });
    return hit;
  }
  function groupOfTab(tabId) { return groupById(tabGroups.members[tabId]); }

  function pruneEmptyGroups() {
    var used = {};
    Object.keys(tabGroups.members).forEach(function (k) { used[tabGroups.members[k]] = true; });
    tabGroups.groups = tabGroups.groups.filter(function (g) { return !!used[g.id]; });
  }

  function newGroup() {
    var g = {
      id: 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: 'Group ' + (tabGroups.groups.length + 1),
      color: GROUP_COLORS[tabGroups.groups.length % GROUP_COLORS.length],
      collapsed: false
    };
    tabGroups.groups.push(g);
    return g;
  }

  /* Chrome-ish: grouping a tab next to an existing group joins that group. */
  function toggleTabGroup(tabId) {
    if (groupOfTab(tabId)) {
      delete tabGroups.members[tabId];
      pruneEmptyGroups();
      saveTabGroups();
      applyTabGroups();
      return false;
    }
    var order = (typeof tabs !== 'undefined') ? tabs : [];
    var idx = -1;
    order.forEach(function (t, i) { if (t.id === tabId) idx = i; });
    var neighbour = null;
    if (idx > 0) neighbour = groupOfTab(order[idx - 1].id);
    if (!neighbour && idx >= 0 && idx < order.length - 1) neighbour = groupOfTab(order[idx + 1].id);
    var g = neighbour || newGroup();
    tabGroups.members[tabId] = g.id;
    saveTabGroups();
    applyTabGroups();
    return true;
  }

  function injectGroupStyles() {
    if (document.getElementById('sp-tabgroup-style')) return;
    var st = document.createElement('style');
    st.id = 'sp-tabgroup-style';
    st.textContent =
      '.sp-tabgroup-chip{display:flex;align-items:center;gap:6px;height:24px;margin:0 3px;' +
        'padding:0 9px;border-radius:9px;cursor:pointer;flex:none;user-select:none;font-size:11px;font-weight:600;}' +
      '.sp-tabgroup-chip .sp-chip-dot{width:9px;height:9px;border-radius:50%;flex:none;}' +
      '.sp-tabgroup-chip .sp-chip-name{max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.sp-tabgroup-chip .sp-chip-count{opacity:.65;font-weight:500;}' +
      '.sp-tabgroup-chip .sp-chip-caret{opacity:.75;font-size:9px;}' +
      '.tab-item.sp-grouped{border-bottom:2px solid var(--sp-group-color,#9aa0a6) !important;}';
    document.head.appendChild(st);
  }

  function applyTabGroups() {
    var list = document.getElementById('open-tabs-list');
    if (!list) return;
    injectGroupStyles();

    var chips = list.querySelectorAll('.sp-tabgroup-chip');
    Array.prototype.slice.call(chips).forEach(function (c) { if (c.parentNode) c.parentNode.removeChild(c); });

    var items = Array.prototype.slice.call(list.children).filter(function (el) {
      return el.classList && el.classList.contains('tab-item');
    });

    /* renderTabs walks the tabs array in order, so position maps to identity */
    items.forEach(function (el, i) {
      var t = (typeof tabs !== 'undefined') ? tabs[i] : null;
      if (t) el.setAttribute('data-tab-id', t.id);
      el.classList.remove('sp-grouped');
      el.style.removeProperty('--sp-group-color');
      el.style.display = '';
    });

    tabGroups.groups.forEach(function (g) {
      var members = items.filter(function (el) { return tabGroups.members[el.getAttribute('data-tab-id')] === g.id; });
      if (!members.length) return;
      members.forEach(function (el) {
        el.classList.add('sp-grouped');
        el.style.setProperty('--sp-group-color', g.color);
        if (g.collapsed && !el.classList.contains('active')) el.style.display = 'none';
      });

      var chip = document.createElement('div');
      chip.className = 'sp-tabgroup-chip';
      chip.setAttribute('data-group-id', g.id);
      chip.style.background = hexToRgba(g.color, 0.20);
      chip.style.color = g.color;
      chip.innerHTML =
        '<span class="sp-chip-dot" style="background:' + esc(g.color) + '"></span>' +
        '<span class="sp-chip-name">' + esc(g.name) + '</span>' +
        '<span class="sp-chip-count">' + members.length + '</span>' +
        '<span class="sp-chip-caret">' + String.fromCharCode(g.collapsed ? 9656 : 9662) + '</span>';
      list.insertBefore(chip, members[0]);
    });
  }

  function groupMenu(g, chip) {
    var old = document.getElementById('sp-tabgroup-menu');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var menu = document.createElement('div');
    menu.id = 'sp-tabgroup-menu';
    menu.setAttribute('style',
      'position:fixed; z-index:10070; min-width:186px; padding:6px; border-radius:11px;' +
      'background:var(--panel-bg,#15161a); color:var(--text,#e8eaed);' +
      'border:1px solid rgba(255,255,255,.10); box-shadow:0 16px 44px rgba(0,0,0,.55); font-size:12.2px;');
    var rect = chip.getBoundingClientRect();
    menu.style.left = Math.max(8, rect.left) + 'px';
    menu.style.top = (rect.bottom + 6) + 'px';
    var opts = [
      ['rename', 'Rename group'],
      ['colour', 'Change colour'],
      [g.collapsed ? 'expand' : 'collapse', g.collapsed ? 'Expand group' : 'Collapse group'],
      ['add', 'Add current tab'],
      ['ungroup', 'Ungroup tabs'],
      ['delete', 'Close group']
    ];
    menu.innerHTML = opts.map(function (o) {
      return '<div data-gact="' + o[0] + '" style="padding:8px 10px; border-radius:7px; cursor:pointer;">' + esc(o[1]) + '</div>';
    }).join('');
    document.body.appendChild(menu);
    menu.addEventListener('click', function (ev) {
      var act = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-gact');
      if (!act) return;
      if (act === 'rename') {
        var name = window.prompt('Group name:', g.name);
        if (name) { g.name = String(name).slice(0, 40); saveTabGroups(); }
      } else if (act === 'colour') {
        var i = GROUP_COLORS.indexOf(g.color);
        g.color = GROUP_COLORS[(i + 1) % GROUP_COLORS.length];
        saveTabGroups();
      } else if (act === 'collapse' || act === 'expand') {
        g.collapsed = (act === 'collapse');
        saveTabGroups();
      } else if (act === 'add') {
        if (typeof activeTabId !== 'undefined' && activeTabId) {
          tabGroups.members[activeTabId] = g.id;
          saveTabGroups();
        }
      } else if (act === 'ungroup') {
        Object.keys(tabGroups.members).forEach(function (k) { if (tabGroups.members[k] === g.id) delete tabGroups.members[k]; });
        pruneEmptyGroups();
        saveTabGroups();
      } else if (act === 'delete') {
        closeGroup(g);
      }
      if (menu.parentNode) menu.parentNode.removeChild(menu);
      applyTabGroups();
    });
    var away = function (ev) {
      if (menu.parentNode && !menu.contains(ev.target)) {
        menu.parentNode.removeChild(menu);
        document.removeEventListener('mousedown', away);
      }
    };
    setTimeout(function () { document.addEventListener('mousedown', away); }, 10);
  }

  function closeGroup(g) {
    var ids = Object.keys(tabGroups.members).filter(function (k) { return tabGroups.members[k] === g.id; });
    ids.forEach(function (id) {
      delete tabGroups.members[id];
      try { if (typeof closeTab === 'function') closeTab(id); } catch (e) {}
    });
    pruneEmptyGroups();
    saveTabGroups();
  }


  /* ======================================================================
     Private browsing and DNS: the controls, and the honest small print.
     ====================================================================== */
  var PRIV_KEY = 'silence_privacy_prefs';
  var PRIV_DEFAULTS = { dnsEnabled: true, dnsThreshold: 8000, proxy: '', leakGuard: true };
  var privPrefs = null;
  var privCount = 0;

  function loadPrivPrefs() {
    if (privPrefs) return privPrefs;
    privPrefs = PRIV_DEFAULTS;
    try {
      var raw = localStorage.getItem(PRIV_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        Object.keys(PRIV_DEFAULTS).forEach(function (k) { if (d[k] !== undefined) privPrefs[k] = d[k]; });
      }
    } catch (e) {}
    return privPrefs;
  }
  function savePrivPrefs() {
    try { localStorage.setItem(PRIV_KEY, JSON.stringify(privPrefs)); } catch (e) {}
  }

  function pushDnsConfig() {
    try {
      ipcRenderer.invoke('silence:dns-config', { enabled: privPrefs.dnsEnabled, threshold: privPrefs.dnsThreshold });
    } catch (e) {}
  }

  /* A private tab runs on its own partition with no persist: prefix, so its
     cookies, cache and storage exist in memory only and are gone on close. */
  async function openPrivateTab() {
  try {
    privCount += 1;
    var partition = 'private-' + Date.now() + '-' + privCount;
    var created = (typeof createTab === 'function')
      ? createTab('about:blank', false, null, 'Private', true, partition) : null;
    if (!created) return;
    var tab = (typeof created === 'object' && created.id) ? created : (typeof tabs !== 'undefined' ? tabs.find(function (t) { return t.id === created; }) : null);
    if (tab) { 
      tab.isPrivate = true; 
      tab.partition = partition; 
    }	
      var r = await ipcRenderer.invoke('silence:private-init', { partition: partition, proxy: loadPrivPrefs().proxy });
      if (r && r.proxied) pill('Private tab · routed through ' + privPrefs.proxy, 'ok', 4500);
      else if (r && r.success) pill('Private tab · nothing is written to disk', 'ok', 4000);
      else pill((r && r.error) || 'Could not open a private tab', 'error', 4000);
      applyPrivateMarks();
    } catch (e) {
      pill('Could not open a private tab: ' + ((e && e.message) || e), 'error', 4000);
    }
  }

  function applyPrivateMarks() {
    var list = document.getElementById('open-tabs-list');
    if (!list || typeof tabs === 'undefined') return;
    var items = [].slice.call(list.children).filter(function (el) {
      return el.classList && el.classList.contains('tab-item');
    });
    items.forEach(function (el, i) {
      var t = tabs[i];
      var isPriv = !!(t && t.isPrivate);
      el.classList.toggle('sp-private', isPriv);
      var mark = el.querySelector('.sp-private-mark');
      if (isPriv && !mark) {
        mark = document.createElement('span');
        mark.className = 'sp-private-mark';
        mark.textContent = 'PRIVATE';
        mark.setAttribute('style',
          'margin-left:6px; padding:1px 5px; border-radius:5px; font-size:8.5px; font-weight:700;' +
          'letter-spacing:.04em; background:rgba(120,90,255,.28); color:#c9bcff; flex:none;');
        var title = el.querySelector('.tab-title') || el;
        title.appendChild(mark);
      } else if (!isPriv && mark && mark.parentNode) {
        mark.parentNode.removeChild(mark);
      }
    });
  }

  function privacyCard() {
    var p = loadPrivPrefs();
    return '<div class="setting-card" id="sp-privacy-card"><h4>Private browsing &amp; DNS</h4>' +
      '<div class="setting-card-row"><div><h4>Switch DNS when a site is slow</h4>' +
        '<p>If a page hangs or fails to resolve, Silence moves to the next provider ' +
        '(Cloudflare to Google to Quad9) and retries once.</p></div>' +
        '<label class="sp-switch"><input type="checkbox" data-sp-action="priv-dns-toggle"' +
          (p.dnsEnabled ? ' checked' : '') + ' /><span>Auto</span></label></div>' +
      '<div class="setting-card-row"><div><h4>Give up after</h4>' +
        '<p>How long a page may hang before the switch.</p></div>' +
        '<input class="sp-input" type="number" min="2" max="60" style="width:88px" ' +
          'data-sp-action="priv-dns-threshold" value="' + esc(String(Math.round(p.dnsThreshold / 1000))) + '" /> seconds</div>' +
      '<div class="setting-card-row"><div><h4>Private tabs</h4>' +
        '<p>Cookies, cache and storage stay in memory and vanish when the tab closes. ' +
        'History is not recorded. <strong>A browser cannot change the IP your provider gave you</strong> ' +
        '— only routing through a proxy or VPN does that, so Silence can use yours.</p></div>' +
        '<button class="sp-btn primary" data-sp-action="priv-new">New private tab</button></div>' +
      '<div class="setting-card-row"><div><h4>Route private tabs through</h4>' +
        '<p>Optional. <code>socks5://127.0.0.1:9050</code> for Tor, or any proxy/VPN you trust. ' +
        'Leave empty to use your normal connection.</p></div>' +
        '<div style="display:flex; gap:6px; align-items:center;">' +
          '<input class="sp-input" type="text" id="sp-priv-proxy" style="width:190px" placeholder="socks5://127.0.0.1:9050" ' +
            'value="' + esc(String(p.proxy || '')) + '" />' +
          '<button class="sp-btn small" data-sp-action="priv-proxy-apply">Apply</button></div></div>' +
      '<div class="setting-card-row"><div><h4>Block WebRTC IP leaks</h4>' +
        '<p>Stops WebRTC sending traffic around the proxy, which is how a real address escapes. ' +
        'Applies to every window from the next start.</p></div>' +
        '<label class="sp-switch"><input type="checkbox" data-sp-action="priv-leak"' +
          (p.leakGuard ? ' checked' : '') + ' /><span>On</span></label></div>' +
      '</div>';
  }


  /* ======================================================================
     One front door for every feature this pack adds.

     These live in this file's own scope, so nothing outside could see them —
     which is how the menu ended up opening one history panel and the keyboard
     another.  Publishing them here means the ⋮ menu, the command palette and
     the keyboard all reach the same code, whatever loads first.
     ====================================================================== */
  window.__silenceCommands = window.__silenceCommands || {};
  Object.assign(window.__silenceCommands, {
    'task-manager': function () { return openSysPanel('tasks'); },
    'downloads':    function () { return openSysPanel('downloads'); },
    'history':      function () { return openSysPanel('history'); },
    'bookmarks':    function () { return openSysPanel('bookmarks'); },
    'capture':      function () { return runCapture(true); },
    'tab-search':   function () { return openTabSearch(); },
    'group-tab':    function () { return toggleTabGroup(); },
    'private-tab':  function () { return openPrivateTab(); }
  });

  async function action(a, el) {
    switch (a) {
      case 'pause-add': {
        const inp = document.getElementById('sp-pause-input');
        const h = ((inp && inp.value) || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (!h) return;
        const list = ((S.privacy && S.privacy.adBlockPause) || []).filter((x) => x !== h);
        list.push(h);
        await save({ privacy: { adBlockPause: list } });
        refresh();
        break;
      }
      case 'pause-del':
        await save({ privacy: { adBlockPause: ((S.privacy && S.privacy.adBlockPause) || []).filter((x) => x !== el.dataset.host) } });
        refresh();
        break;
      case 'clear-item':
        await save({ privacy: { clearOnQuitItems: [...document.querySelectorAll('[data-sp-action="clear-item"]:checked')].map((x) => x.value) } });
        break;
      case 'clear-now': openClearModal(); break;
      case 'perm-default':
        await ipcRenderer.invoke('silence:permission-default', { permission: el.dataset.perm, value: el.value });
        S = (await ipcRenderer.invoke('silence:get-settings')) || S;
        break;
      case 'perm-allow':
      case 'perm-deny':
        await ipcRenderer.invoke('silence:permission-set', { origin: el.dataset.origin, permission: el.dataset.perm, value: a === 'perm-allow' ? 'allow' : 'deny' });
        S = (await ipcRenderer.invoke('silence:get-settings')) || S;
        refresh();
        break;
      case 'zoom-add': {
        const host = ((document.getElementById('sp-zoom-host') || {}).value || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const val = parseFloat((document.getElementById('sp-zoom-val') || {}).value || '125');
        if (!host) return;
        const zoom = Object.assign({}, ((S.sites && S.sites.zoom) || {}));
        zoom[host] = Math.max(0.25, Math.min(5, val / 100));
        await save({ sites: { zoom } });
        refresh();
        break;
      }
      case 'zoom-del': {
        const zoom = Object.assign({}, ((S.sites && S.sites.zoom) || {}));
        delete zoom[el.dataset.host];
        await save({ sites: { zoom } });
        refresh();
        break;
      }
      case 'vault-add': {
        const site = (document.getElementById('sp-v-site') || {}).value || '';
        const username = (document.getElementById('sp-v-user') || {}).value || '';
        const password = (document.getElementById('sp-v-pass') || {}).value || '';
        if (!site || !username) return;
        const r = await ipcRenderer.invoke('silence:vault-save', { site, username, password });
        VAULT = (r && r.items) || VAULT;
        refresh();
        break;
      }
      case 'vault-del': {
        const r = await ipcRenderer.invoke('silence:vault-delete', { id: el.dataset.id });
        VAULT = (r && r.items) || VAULT;
        refresh();
        break;
      }
      case 'vault-copy': {
        const r = await ipcRenderer.invoke('silence:vault-reveal', { id: el.dataset.id });
        try { await navigator.clipboard.writeText((r && r.password) || ''); } catch (e) {}
        pill('Password copied', 'ok', 2500);
        break;
      }
      case 'vault-fill': await fillCredentials(el.dataset.id); break;
      case 'lang': {
        const langs = [...document.querySelectorAll('[data-sp-action="lang"]:checked')].map((x) => x.value);
        await save({ languages: { languages: langs.length ? langs : ['en-US'] } });
        break;
      }
      case 'check-update': {
        var cbtn = document.getElementById('sp-check-update-btn');
        var cbox = document.getElementById('sp-update-status');
        if (!cbox) break;
        if (cbtn) cbtn.disabled = true;
        cbox.innerHTML = updSpin('Checking for updates' + UPD_ELL);
        var cres = null;
        try { cres = await ipcRenderer.invoke('silence:check-app-update'); }
        catch (e) { cres = { status: 'error', error: (e && e.message) || String(e) }; }
        if (cbtn) cbtn.disabled = false;
        renderUpdateStatus(cbox, cres, true);
        /* Chrome's button checks everything the browser is made of, so a single
         * click also refreshes the engine card below. */
        var engBox = document.getElementById('sp-engine-status');
        if (engBox) {
          var engRes = null;
          try { engRes = await ipcRenderer.invoke('silence:check-engine-update'); } catch (e) { engRes = null; }
          if (engRes) renderEngineStatus(engBox, engRes);
        }
        break;
      }
      case 'update-now': {
        var ubox = document.getElementById('sp-update-status');
        var ubar = document.getElementById('sp-update-bar');
        var ufill = document.getElementById('sp-update-fill');
        el.disabled = true;
        el.textContent = 'Downloading' + UPD_ELL;
        if (ubar) ubar.style.display = 'block';
        var onProg = function (_e, p) {
          var pct = Math.max(0, Math.min(100, (p && p.pct) || 0));
          if (ufill) ufill.style.width = pct + '%';
          el.textContent = 'Downloading' + UPD_ELL + ' ' + pct + '%';
        };
        ipcRenderer.on('silence:app-update-progress', onProg);
        var ures = await ipcRenderer.invoke('silence:download-app-update', { url: el.dataset.url, name: el.dataset.name });
        ipcRenderer.removeListener('silence:app-update-progress', onProg);
        if (!ures || !ures.success) {
          el.disabled = false;
          el.textContent = 'Update now';
          if (ubar) ubar.style.display = 'none';
          if (ubox) ubox.insertAdjacentHTML('beforeend',
            ' <span class="sp-badge danger">' + esc((ures && ures.error) || 'Download failed') + '</span>');
          break;
        }
        el.textContent = 'Downloaded';
        if (ufill) ufill.style.width = '100%';
        if (ubox) {
          ubox.insertAdjacentHTML('beforeend',
            '<div style="margin-top:10px; display:flex; gap:8px; align-items:center;">' +
              '<button class="sp-btn small primary" data-sp-action="relaunch-update" data-path="' +
                esc(String(ures.path).replace(/"/g, '')) + '">Relaunch to update</button>' +
              '<span style="color:var(--text-muted); font-size:11.6px;">Silence will close and reopen on ' +
                'the new version.</span>' +
            '</div>');
        }
        break;
      }
      case 'relaunch-update': {
        el.disabled = true;
        el.textContent = 'Installing' + UPD_ELL;
        var rres = await ipcRenderer.invoke('silence:install-app-update', { path: el.dataset.path });
        if (rres && rres.success === false) {
          el.disabled = false;
          el.textContent = 'Relaunch to update';
          pill(rres.error || 'Could not start the installer', 'error', 4000);
        }
        break;
      }

      case 'engine-check': {
        var nebox = document.getElementById('sp-engine-status');
        var nebtn = document.getElementById('sp-engine-check-btn');
        if (!nebox) break;
        if (nebtn) nebtn.disabled = true;
        nebox.innerHTML = updSpin('Checking the engine' + UPD_ELL);
        var neres = null;
        try { neres = await ipcRenderer.invoke('silence:check-engine-update'); }
        catch (e) { neres = { status: 'error', error: (e && e.message) || String(e) }; }
        if (nebtn) nebtn.disabled = false;
        renderEngineStatus(nebox, neres);
        break;
      }
      case 'engine-update': {
        var uebox = document.getElementById('sp-engine-status');
        var uelog = document.getElementById('sp-engine-log');
        var uebar = document.getElementById('sp-engine-bar');
        var uefill = document.getElementById('sp-engine-fill');
        el.disabled = true;
        el.textContent = 'Updating' + UPD_ELL;
        if (uebar) uebar.style.display = 'block';
        if (uelog) uelog.style.display = 'block';
        var onLog = function (_e, line) {
          if (uelog) { uelog.textContent = String(line).slice(0, 300); }
          if (uefill) {
            var w = parseInt(uefill.style.width, 10) || 8;
            uefill.style.width = Math.min(94, w + 6) + '%';
          }
        };
        ipcRenderer.on('silence:engine-update-log', onLog);
        var ures3 = await ipcRenderer.invoke('silence:update-engine', { version: el.dataset.version });
        ipcRenderer.removeListener('silence:engine-update-log', onLog);
        if (!ures3 || !ures3.success) {
          el.disabled = false;
          el.textContent = 'Update engine';
          if (uebar) uebar.style.display = 'none';
          /* Show what npm actually said, not just its last line — "a complete log
           * can be found in ..." is useless on its own. */
          var detailLines = (ures3 && ures3.errorLines && ures3.errorLines.length)
            ? ures3.errorLines.slice(0, 8)
            : ((ures3 && ures3.lines) || []).slice(-12);
          if (uelog) {
            uelog.style.display = 'block';
            uelog.textContent = detailLines.join('\n');
          }
          if (uebox) {
            uebox.insertAdjacentHTML('beforeend',
              '<div style="margin-top:8px; display:flex; flex-wrap:wrap; gap:8px; align-items:center;">' +
                '<span class="sp-badge danger">' + esc((ures3 && ures3.error) || 'Update failed') + '</span>' +
                '<button class="sp-btn small primary" data-sp-action="engine-update-offline" data-version="' +
                  esc(String(el.dataset.version || '')) + '">Install after restart</button>' +
              '</div>' +
              '<div style="margin-top:6px; font-size:11.4px; color:var(--text-muted);">' +
                'Windows locks the files Silence is running from, so npm cannot swap them live. ' +
                'This closes Silence, installs with nothing locked, and starts it again.' +
              '</div>');
          }
          break;
        }
        if (uefill) uefill.style.width = '100%';
        el.textContent = 'Installed';
        if (uebox) {
          uebox.insertAdjacentHTML('beforeend',
            '<div style="margin-top:10px; display:flex; gap:8px; align-items:center;">' +
              '<button class="sp-btn small primary" data-sp-action="engine-relaunch">Relaunch to finish</button>' +
              '<span style="color:var(--text-muted); font-size:11.6px;">Silence restarts on Electron ' +
                esc(String(el.dataset.version || '')) + '.</span>' +
            '</div>');
        }
        break;
      }
      case 'engine-relaunch': {
        el.disabled = true;
        el.textContent = 'Restarting' + UPD_ELL;
        await ipcRenderer.invoke('silence:relaunch-app');
        break;
      }
      case 'engine-update-offline': {
        el.disabled = true;
        el.textContent = 'Restarting' + UPD_ELL;
        var r4 = await ipcRenderer.invoke('silence:update-engine-offline', { version: el.dataset.version });
        if (r4 && r4.success === false) {
          el.disabled = false;
          el.textContent = 'Install after restart';
          pill(r4.error || 'Could not start the update', 'error', 5000);
        }
        break;
      }

      case 'priv-new': {
        await openPrivateTab();
        break;
      }
      case 'priv-dns-toggle': {
        loadPrivPrefs();
        privPrefs.dnsEnabled = !!el.checked;
        savePrivPrefs();
        pushDnsConfig();
        pill(privPrefs.dnsEnabled ? 'Automatic DNS switching on' : 'Automatic DNS switching off', 'ok', 3000);
        break;
      }
      case 'priv-dns-threshold': {
        loadPrivPrefs();
        var secs = Math.max(2, Math.min(60, Number(el.value) || 8));
        privPrefs.dnsThreshold = secs * 1000;
        savePrivPrefs();
        pushDnsConfig();
        break;
      }
      case 'priv-proxy-apply': {
        loadPrivPrefs();
        var box = document.getElementById('sp-priv-proxy');
        privPrefs.proxy = String((box && box.value) || '').trim();
        savePrivPrefs();
        var r = await ipcRenderer.invoke('silence:private-proxy', { partition: 'private-current', proxy: privPrefs.proxy });
        if (r && r.success === false) pill(r.error || 'That proxy was not accepted', 'error', 4500);
        else pill(privPrefs.proxy ? 'Private tabs will use ' + privPrefs.proxy : 'Private tabs use your normal connection', 'ok', 4000);
        break;
      }
      case 'priv-leak': {
        loadPrivPrefs();
        privPrefs.leakGuard = !!el.checked;
        savePrivPrefs();
        try { ipcRenderer.invoke('silence:privacy-prefs', privPrefs); } catch (e) {}
        pill(privPrefs.leakGuard ? 'WebRTC leak guard on — takes effect next start' : 'WebRTC leak guard off', 'ok', 4000);
        break;
      }

      case 'pick-drm': {
        const r = await ipcRenderer.invoke('silence:browse-folder');
        if (r && r.path) { await save({ drm: { path: r.path } }); refresh(); }
        break;
      }
      case 'open-downloads': ipcRenderer.invoke('silence:open-path', { target: 'downloads' }); break;
      case 'open-profile': ipcRenderer.invoke('silence:open-path', { target: 'userData' }); break;
      case 'open-ext': ipcRenderer.invoke('silence:open-path', { target: 'extensions' }); break;
      case 'open-store': if (typeof createTab === 'function') createTab('silence://store', false, null, 'Extension Store', true); break;
      case 'engine': {
        await save({ search: { engine: el.value } });
        try { localStorage.setItem('silence_search_engine', el.value); } catch (e) {}
        try { if (typeof searchEngine !== 'undefined') searchEngine = el.value; } catch (e) {}
        const legacy = document.getElementById('engine-select');
        if (legacy) legacy.value = el.value;
        setEngineName(el.value);
        break;
      }
      case 'restore-now': try { restoreSession(); } catch (e) { console.warn('[plus] restore failed', e.message); } break;
      case 'reset-settings': S = (await ipcRenderer.invoke('silence:reset-settings')) || S; refresh(); break;
      case 'relaunch': ipcRenderer.invoke('silence:relaunch'); break;
    }
  }

  async function fillCredentials(id) {
    try {
      const rec = (VAULT || []).find((v) => v.id === id);
      const r = await ipcRenderer.invoke('silence:vault-reveal', { id });
      const tab = (typeof tabs !== 'undefined') ? tabs.find((t) => t.id === activeTabId) : null;
      if (!tab || !tab.webview) return;
      const js = '(function(){var u=document.querySelector("input[type=email],input[name*=user i],input[name*=email i],input#username,input#email");' +
        'var p=document.querySelector("input[type=password]");' +
        'if(u){u.value=' + JSON.stringify(rec ? rec.username : '') + ';u.dispatchEvent(new Event("input",{bubbles:true}));}' +
        'if(p){p.value=' + JSON.stringify((r && r.password) || '') + ';p.dispatchEvent(new Event("input",{bubbles:true}));}return !!(u||p);})()';
      const ok = await tab.webview.executeJavaScript(js);
      pill(ok ? 'Credentials filled' : 'No login form found on this page', ok ? 'ok' : 'error', 2600);
    } catch (e) { console.warn('[plus] fill failed', e.message); }
  }

  function openClearModal() {
    let m = document.getElementById('sp-clear-modal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'sp-scrim';
      m.id = 'sp-clear-modal';
      m.innerHTML = '<div class="sp-modal"><h3>Clear browsing data</h3><p class="sp-desc">Choose what Silence should delete.</p>' +
        ['cache', 'storage', 'cookies'].map((k) =>
          '<label class="sp-chip" style="cursor:pointer;margin-top:10px"><input type="checkbox" data-clear="' + k + '" checked style="accent-color:#6366f1"> ' + k + '</label>').join('') +
        '<div class="row-end"><button class="sp-btn" data-close="1">Cancel</button><button class="sp-btn primary" id="sp-clear-go">Clear</button></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close) m.classList.remove('open'); });
      m.querySelector('#sp-clear-go').onclick = async () => {
        const opts = {};
        m.querySelectorAll('[data-clear]').forEach((x) => { opts[x.dataset.clear] = x.checked; });
        await ipcRenderer.invoke('silence:clear-data', opts);
        m.classList.remove('open');
        pill('Browsing data cleared', 'ok', 2600);
      };
    }
    m.classList.add('open');
  }

  /* --------------------------- extension fixes -------------------------- */
  function hookExtensions() {
    if (window.__spExtHooked) return;
    if (typeof loadExtensionsUI !== 'function') return;
    window.__spExtHooked = true;

    const origLoad = loadExtensionsUI;
    loadExtensionsUI = async function () {
      try { await origLoad.apply(this, arguments); } catch (e) {}
      try { enhanceExtCards(); } catch (e) {}
    };

    // removing must delete the files too, otherwise it returns on restart
    removeExtension = async function (id) {
      try { await ipcRenderer.invoke('silence-store:uninstall', { id }); } catch (e) {}
      try { await ipcRenderer.invoke('remove-extension', id); } catch (e) {}
      try {
        pinnedExtensions = pinnedExtensions.filter((x) => x !== id);
        localStorage.setItem('silence_pinned_exts', JSON.stringify(pinnedExtensions));
      } catch (e) {}
      try { await loadExtensionsUI(); } catch (e) {}
      pill('Extension removed', 'ok', 2600);
    };

    // pop-ups: the inline webview often cannot load chrome-extension:// URLs,
    // so fall back to a frameless window when it fails
    triggerExtensionAction = function (ext, triggerEl) {
      if (!ext || !ext.popupUrl) return;
      const rect = triggerEl.getBoundingClientRect();
      let failed = false;
      const onFail = () => {
        if (failed) return;
        failed = true;
        try { extPopupBubble.classList.remove('open'); } catch (e) {}
        ipcRenderer.send('silence:ext-popup', { url: ext.popupUrl, x: rect.left, y: rect.bottom, width: 400, height: 560 });
      };
      try {
        extPopupWebview.addEventListener('did-fail-load', onFail);
        setTimeout(() => extPopupWebview.removeEventListener('did-fail-load', onFail), 10000);
        extPopupBubble.style.top = (rect.bottom + 6) + 'px';
        extPopupBubble.style.left = Math.max(10, rect.left - 140) + 'px';
        extPopupWebview.src = ext.popupUrl;
        extPopupBubble.classList.add('open');
        extMenuDropdown.classList.remove('open');
        // if nothing rendered in 1.2s, use the window instead
        setTimeout(() => {
          try {
            if (extPopupBubble.classList.contains('open') && !extPopupWebview.getURL()) onFail();
          } catch (e) {}
        }, 1200);
      } catch (e) { onFail(); }
    };
  }

  /** add a trash icon to every extension row so removal is obvious */
  function enhanceExtCards() {
    const list = document.getElementById('extensions-manager-list');
    if (list) {
      list.querySelectorAll('.ext-card').forEach((card) => {
        if (card.querySelector('.sp-ext-del')) return;
        const rm = card.querySelector('.action-btn.danger');
        const match = rm && rm.getAttribute('onclick') && rm.getAttribute('onclick').match(/removeExtension\(['"]([^'"]+)['"]\)/);
        const btn = document.createElement('button');
        btn.className = 'sp-ext-del';
        btn.title = 'Remove this extension';
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
        btn.onclick = async (e) => {
          e.stopPropagation();
          if (btn.dataset.busy) return;
          btn.dataset.busy = '1';
          btn.style.opacity = '.45';
          if (match) await removeExtension(match[1]);
          else await loadExtensionsUI();
        };
        const actions = card.lastElementChild;
        if (actions) actions.insertBefore(btn, actions.firstChild);
        else card.appendChild(btn);
      });
    }
    const menu = document.getElementById('ext-menu-dropdown');
    if (menu) {
      menu.querySelectorAll(':scope > div').forEach((item) => {
        if (item.querySelector('.sp-ext-del')) return;
        const pinBtn = item.querySelector('button');
        const del = document.createElement('button');
        del.className = 'sp-ext-del';
        del.title = 'Remove';
        del.style.cssText = 'width:20px;height:20px;margin-left:4px';
        del.innerHTML = '✕';
        del.onclick = async (e) => {
          e.stopPropagation();
          item.style.opacity = '.4';
          const list = await ipcRenderer.invoke('silence-store:list');
          const rows = (list && list.extensions) || [];
          const name = item.querySelector('span') && item.querySelector('span').textContent.trim();
          const row = rows.find((r) => r.name === name);
          if (row) await removeExtension(row.id);
        };
        if (pinBtn && pinBtn.parentNode) pinBtn.parentNode.insertBefore(del, pinBtn.nextSibling);
      });
    }
  }

  /* --------------------- keep old & new settings in sync ---------------- */
  function syncLegacy() {
    try {
      const sel = document.getElementById('engine-select');
      if (sel && !sel.__spSynced) {
        sel.__spSynced = true;
        if (S.search && S.search.engine) sel.value = S.search.engine;
        else save({ search: { engine: sel.value } });
        sel.addEventListener('change', () => {
          S.search = S.search || {};
          S.search.engine = sel.value;
          save({ search: { engine: sel.value } });
          try { localStorage.setItem('silence_search_engine', sel.value); } catch (e) {}
          const mine = document.querySelector('[data-sp-action="engine"]');
          if (mine) mine.value = sel.value;
          setEngineName(sel.value);
        });

        // the same drop-down was also in Appearance — keep exactly one copy
        const dupe = sel.closest('.setting-card');
        if (dupe && dupe.querySelectorAll('select, input, button').length === 1) {
          const card = document.createElement('div');
          card.className = 'setting-card';
          card.innerHTML = '<div class="setting-card-row"><div><h4>Search engine</h4>' +
            '<p>Moved to <b>Search &amp; startup</b> so there is only one copy. Current: <b class="sp-engine-name">' +
            esc(engineName((S.search && S.search.engine) || sel.value)) + '</b></p></div></div>';
          const btn = document.createElement('button');
          btn.className = 'action-btn';
          btn.textContent = 'Change';
          btn.onclick = () => showPanel('panel-search-plus');
          card.querySelector('.setting-card-row').appendChild(btn);
          dupe.parentNode.replaceChild(card, dupe);
        }
      }
    } catch (e) {}

    // the old "Privacy & Ads" panel: make its badge honest and link to the new panel
    try {
      const rows = [...document.querySelectorAll('#panel-privacy .setting-card-row')];
      rows.forEach((row) => {
        const h = row.querySelector('h4');
        if (!h || !/ad\s*&\s*tracker/i.test(h.textContent)) return;
        if (row.__spSynced) return;
        row.__spSynced = true;
        const badge = row.querySelector('span');
        const on = !!(S.privacy && S.privacy.adBlock);
        const paused = ((S.privacy && S.privacy.adBlockPause) || []).length;
        if (badge) {
          badge.textContent = on ? ('Active' + (paused ? ' · ' + paused + ' paused' : '')) : 'Off';
          badge.style.color = on ? 'var(--accent)' : '#8b8f9e';
        }
        const p = row.querySelector('p');
        if (p) p.textContent = 'Managed in Privacy & security → Blocking.';
        if (!row.querySelector('[data-sp-goto]')) {
          const btn = document.createElement('button');
          btn.className = 'action-btn';
          btn.textContent = 'Manage';
          btn.setAttribute('data-sp-goto', 'panel-privacy-plus');
          btn.onclick = () => showPanel('panel-privacy-plus');
          row.appendChild(btn);
        }
      });
    } catch (e) {}
  }

  /* ------------------------------ wiring -------------------------------- */
  function wire() {
    const sidebar = $('.settings-sidebar');
    const area = $('.settings-content-area');

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sp-nav]');
      if (btn) { showPanel(btn.dataset.target); return; }
    });

    const search = document.getElementById('sp-nav-search');
    if (search) {
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        if (!q) {
          const active = document.querySelector('.settings-nav-item.active[data-sp-nav]');
          updateSubVisibility(active ? active.dataset.target : '');
          document.querySelectorAll('.settings-nav-item:not(.sp-sub)').forEach((b) => { b.style.display = ''; });
          return;
        }
        document.querySelectorAll('.settings-nav-item').forEach((b) => {
          b.style.display = b.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      });
    }

    area.addEventListener('change', async (e) => {
      const t = e.target;
      if (t.dataset.spToggle) { await save(setPath(t.dataset.spToggle, t.checked)); if (t.dataset.spToggle === 'system.animations') document.body.classList.toggle('no-anim', !t.checked); }
      else if (t.dataset.spSelect) {
        await save(setPath(t.dataset.spSelect, t.value));
        if (t.dataset.spSelect === 'gestures.swipe') applySwipeMode();
      }
      else if (t.dataset.spAction) await action(t.dataset.spAction, t);
    });
    area.addEventListener('blur', async (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.spInput) await save(setPath(t.dataset.spInput, t.value));
    }, true);
    area.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-sp-action]');
      if (el && el.tagName === 'BUTTON') await action(el.dataset.spAction, el);
    });
  }

  /* --------------------- runtime behaviour in the shell ----------------- */
  /** tell every tab (and any tab opened later) how sensitive the swipe should be */
  function applySwipeMode(tab) {
    try {
      const mode = ((S.gestures && S.gestures.swipe) || 'high');
      const wire = mode === 'off' ? 'disabled' : mode;
      const send = (t) => { try { if (t && t.webview && t.webview.send) t.webview.send('set-trackpad-nav-config', wire); } catch (e) {} };
      if (tab) { send(tab); return; }
      if (typeof tabs !== 'undefined') tabs.forEach(send);
    } catch (e) {}
  }

  function applyRuntime() {
    document.body.classList.toggle('no-anim', !(S.system && S.system.animations));
    hookTabs();
    hookExtensions();
    syncLegacy();
    applySwipeMode();
    try { tabs.forEach((t) => { if (t.url) applySiteRules(t, t.url); }); } catch (e) {}
    try { loadExtensionsUI(); } catch (e) {}
  }

  function applySiteRules(tab, url) {
    try {
      const host = hostOf(url);
      if (!host) return;
      const z = (S.sites && S.sites.zoom && S.sites.zoom[host]);
      if (z && tab.webview && tab.webview.setZoomFactor) tab.webview.setZoomFactor(z);
      ipcRenderer.send('silence:adblock-sync', { url });
    } catch (e) {}
  }

  function hookTabs() {
    if (typeof createTab !== 'function' || window.__spHooked) return;
    window.__spHooked = true;
    const original = createTab;
    createTab = function () {
      const tab = original.apply(this, arguments);
      try {
        if (tab && tab.webview) {
          setTimeout(() => applySwipeMode(tab), 900);
          tab.webview.addEventListener('did-navigate', (e) => applySiteRules(tab, e.url));
          tab.webview.addEventListener('did-frame-navigate', (e) => { if (e.isMainFrame) applySiteRules(tab, e.url); });
        }
        if ((!arguments[0]) && S.search && S.search.newTab === 'blank') {
          setTimeout(() => { try { hideHomeOverlay(); } catch (e) {} }, 60);
        }
      } catch (e) {}
      return tab;
    };
  }

  async function startupBehaviour() {
    const mode = (S.search && S.search.startup) || 'blank';
    if (mode === 'restore') setTimeout(() => { try { restoreSession(); } catch (e) {} }, 400);
    else if (mode === 'homepage') {
      const url = (S.search && S.search.homepage) || 'https://www.google.com';
      setTimeout(() => { try { createTab(url, false, null, null, true); } catch (e) {} }, 400);
    }
  }

  /* -------------------------------- boot ------------------------------- */
  async function boot() {
    /* Chrome notices an update on its own. When Silence finds one in the
     * background, fill the About card if it is open, otherwise show a pill. */
    ipcRenderer.on('silence:app-update-available', function (_e, r) {
      try {
        var b = document.getElementById('sp-update-status');
        if (b) { renderUpdateStatus(b, r); return; }
        pill('Silence ' + (r && r.latestVersion ? r.latestVersion : '') + ' is available ' +
             String.fromCharCode(8212) + ' open Settings ' + String.fromCharCode(8594) + ' About', 'ok', 9000);
      } catch (e) {}
    });

    /* Chrome's system shortcuts. Installed here, after silence-pro.js has put its
     * own dispatcher in place, so every other combo still falls through to it. */
    (function () {
      var prevShortcut = window.__silenceShortcut;
      window.__silenceShortcut = function (combo) {
        try {
          if (combo === 'shift+esc' || combo === 'shift+escape') { openSysPanel('tasks'); return; }
          if (combo === 'ctrl+alt+s') { runCapture(true); return; }
          if (combo === 'ctrl+j') { openSysPanel('downloads'); return; }
          if (combo === 'ctrl+h') { openSysPanel('history'); return; }
          if (combo === 'ctrl+shift+o') { openSysPanel('bookmarks'); return; }
        } catch (e) {}
        if (typeof prevShortcut === 'function') return prevShortcut(combo);
      };
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && SYSPANEL && SYSPANEL.style.display === 'flex') closeSysPanel();
      });
      /* "End process" on a tab: close the tab so the strip stays in step. */
      ipcRenderer.on('silence:close-tab-contents', function (_e, id) {
        try {
          var t = (typeof tabs !== 'undefined') ? tabs.filter(function (x) {
            return x.webview && x.webview.getWebContentsId && x.webview.getWebContentsId() === id;
          })[0] : null;
          if (!t) return;
          if (typeof closeTab === 'function') { closeTab(t.id); return; }
          var el = document.querySelector('[data-tab-id="' + t.id + '"] .close-action');
          if (el) el.click();
        } catch (e) {}
      });
    })();

    /* Chrome slides a bar in when you move the mouse to the top of a fullscreen
     * page, with an X that leaves fullscreen. Silence had no way out but Esc. */
    (function () {
      document.addEventListener('mousemove', function (ev) {
        if (!inHtmlFullscreen()) { if (FSBAR && FSBAR.style.transform === 'translateY(0)') hideFsBar(); return; }
        if (ev.clientY <= 46) showFsBar();
        else if (ev.clientY > 110) hideFsBar();
      }, true);
      document.addEventListener('mouseleave', hideFsBar);
    })();

    /* Tab search lives on Chrome's own shortcut. */
    (function () {
      var prevCombo = window.__silenceShortcut;
      window.__silenceShortcut = function (combo) {
        try { if (combo === 'ctrl+shift+a') { openTabSearch(); return; } } catch (e) {}
        if (typeof prevCombo === 'function') return prevCombo(combo);
      };
      var inputHandler = function () {
        var box = document.getElementById('sp-tabsearch-input');
        if (box) renderTabSearch(box.value);
      };
      document.addEventListener('input', function (ev) {
        if (ev.target && ev.target.id === 'sp-tabsearch-input') inputHandler();
      });
    })();

    /* Tab groups: load, decorate the strip, and keep the decoration in step
       with index.html, which re-renders the strip on every tab change. */
    (function () {
      loadTabGroups();
      applyTabGroups();
      var list = document.getElementById('open-tabs-list');
      if (list && typeof MutationObserver === 'function') {
        var pending = false;
        new MutationObserver(function () {
          if (pending) return;
          pending = true;
          setTimeout(function () { pending = false; applyTabGroups(); }, 40);
        }).observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      }
      setInterval(applyTabGroups, 900);
      document.addEventListener('click', function (ev) {
        var chip = (ev.target && ev.target.closest) ? ev.target.closest('.sp-tabgroup-chip') : null;
        if (!chip) return;
        var g = groupById(chip.getAttribute('data-group-id'));
        if (!g) return;
        if (ev.target.classList && ev.target.classList.contains('sp-chip-caret')) {
          g.collapsed = !g.collapsed;
          saveTabGroups();
          applyTabGroups();
        } else {
          groupMenu(g, chip);
        }
      });
    })();

    /* Ctrl+Shift+G groups the tab you are on — or ungroups it. */
    (function () {
      var prevG = window.__silenceShortcut;
      window.__silenceShortcut = function (combo) {
        try { if (combo === 'ctrl+alt+g') { toggleTabGroup(activeTabId); return; } } catch (e) {}
        if (typeof prevG === 'function') return prevG(combo);
      };
    })();

    /* Private browsing + DNS: restore the preferences, tell the main process,
       and keep the PRIVATE badges in step with the strip. */
    (function () {
      loadPrivPrefs();
      pushDnsConfig();
      setInterval(applyPrivateMarks, 900);
      ipcRenderer.on('silence:dns-switched', function (_e, info) {
        try {
          pill('Slow or unreachable — switched DNS to ' + (info && info.provider ? info.provider : 'the next provider'), 'ok', 5000);
        } catch (e) {}
      });
    })();

    /* Ctrl+Shift+N — Chrome's key for a private window. */
    (function () {
      var prevN = window.__silenceShortcut;
      window.__silenceShortcut = function (combo) {
        try { if (combo === 'ctrl+alt+n') { openPrivateTab(); return; } } catch (e) {}
        if (typeof prevN === 'function') return prevN(combo);
      };
    })();

    try {
      S = await ipcRenderer.invoke('silence:get-settings');
      INFO = await ipcRenderer.invoke('silence:app-info');
      const v = await ipcRenderer.invoke('silence:vault-list');
      VAULT = (v && v.items) || [];
      ensureCss();
      buildNav();
      buildPanels();
      wire();
      addToolbarButton();
      applyRuntime();
      startupBehaviour();
      window.__silencePlus = { version: VERSION, panels: ALL_PANELS.map((p) => p.id) };
      console.log('[plus] settings add-on ready (v' + VERSION + ')');
      if (S && S.error) pill('Silence core did not load (' + S.error + ') — restart Silence', 'error', 0);
      else if (localStorage.getItem('sp_seen_version') !== VERSION) {
        try { localStorage.setItem('sp_seen_version', VERSION); } catch (e) {}
        pill('<b>Silence Plus v' + VERSION + '</b> — removal & pop-ups fixed, sub-menus added, pop-up blocking now off by default.', 'ok');
      }
    } catch (e) {
      console.error('[plus] failed to start:', e);
      pill('Silence Plus failed to start: ' + ((e && e.message) || e), 'error', 0);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
