'use strict';
const {app, BrowserWindow, WebContentsView, ipcMain, protocol, session, dialog, shell, Menu, safeStorage} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const policy = require('./security.cjs');
const {createVault} = require('./vault.cjs');
const {createOAuth, providerAccount} = require('./oauth.cjs');

app.enableSandbox();
protocol.registerSchemesAsPrivileged([{scheme: 'veyro', privileges: {standard: true, secure: true, supportFetchAPI: true}}]);

async function bootstrap(options = {}) {
  const testing = !app.isPackaged && process.env.VEYRO_DESKTOP_TEST === '1' && options.test === true;
  const origin = policy.resolveOrigin({isPackaged: app.isPackaged, testMode: testing, testOrigin: options.testOrigin});
  if (options.userData && testing) app.setPath('userData', options.userData);
  app.setName('Veyro Mail');
  if (!testing && !app.requestSingleInstanceLock()) { app.quit(); return; }
  const prompt = testing && options.dialog ? options.dialog : dialog;
  const openExternal = testing && options.openExternal ? options.openExternal : (url) => shell.openExternal(url);
  const accountsFile = path.join(app.getPath('userData'), 'accounts.json');
  const vault = createVault({safeStorage, directory: path.join(app.getPath('userData'), 'vault')});
  const oauthConfig = require('./oauth-config.json');
  const oauth = createOAuth({
    config: {
      google: {clientId: process.env.VEYRO_GOOGLE_CLIENT_ID || oauthConfig.google?.clientId, clientSecret: process.env.VEYRO_GOOGLE_CLIENT_SECRET || oauthConfig.google?.clientSecret},
      microsoft: {clientId: process.env.VEYRO_MICROSOFT_CLIENT_ID || oauthConfig.microsoft?.clientId},
    },
    // OAuth destinations are fixed in oauth.cjs and opened only by the explicit Connect action.
    openBrowser: openExternal,
  });
  const views = new Map();
  const protectedSessions = new Map();
  const downloads = new Map();
  const accountQueues = new Map();
  const removing = new Set();
  const oauthAttempts = new Map();
  const messageViews = new Map();
  let window, accounts = [], activeId, dialogOpen = false, promptOpen = false, toast = '', shuttingDown = false;
  let mutation = Promise.resolve();

  function accountById(id) {
    const account = accounts.find((item) => item.id === id);
    if (!account) throw new Error('Kontoen findes ikke længere.');
    return account;
  }
  async function saveAccounts() {
    await fs.mkdir(path.dirname(accountsFile), {recursive: true, mode: 0o700});
    await fs.writeFile(`${accountsFile}.tmp`, JSON.stringify({version: 1, accounts, activeId}), {mode: 0o600});
    await fs.rename(`${accountsFile}.tmp`, accountsFile);
  }
  async function loadAccounts() {
    try {
      const data = JSON.parse(await fs.readFile(accountsFile, 'utf8'));
      if (!Array.isArray(data.accounts)) throw new Error('Invalid accounts');
      const ids = new Set();
      accounts = data.accounts.slice(0, 30).map((item) => {
        if (!policy.UUID.test(item.id) || ids.has(item.id) || !['veyro', 'external'].includes(item.kind)) throw new Error('Invalid account');
        ids.add(item.id);
        return {id: item.id, label: policy.normalizeLabel(item.label), kind: item.kind};
      });
      activeId = accounts.some((item) => item.id === data.activeId) ? data.activeId : accounts[0]?.id;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Kontolisten kunne ikke læses. Dine gemte kontodata er bevaret.');
      accounts = [{id: randomUUID(), label: 'Min Veyro', kind: 'veyro'}];
      activeId = accounts[0].id;
      await saveAccounts();
    }
  }
  function state() {
    const entry = views.get(activeId);
    return {accounts, activeId, status: entry?.status || 'empty', section: entry?.section || 'mail', dialogOpen, toast, version: app.getVersion()};
  }
  function publish() {
    if (window && !window.isDestroyed()) window.webContents.send('veyro:state', state());
  }
  function layout() {
    if (!window || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    for (const [id, entry] of views) {
      entry.view.setBounds({x: 112, y: 0, width: Math.max(0, width - 112), height});
      entry.view.setVisible(id === activeId && !dialogOpen && entry.status === 'ready');
    }
  }
  function notify(message) { toast = message; publish(); }
  function invalidateOAuth(id) {
    const generation = (oauthAttempts.get(id) || 0) + 1;
    oauthAttempts.set(id, generation);
    oauth.cancel(id);
    return generation;
  }
  function messageView(url, accountId) {
    if (typeof url !== 'string' || !/^veyro:\/\/message\/[a-f0-9-]{36}$/.test(url)) return undefined;
    const record = messageViews.get(url);
    if (!record || record.accountId !== accountId || Date.now() - record.createdAt > 30 * 60 * 1000) return undefined;
    return record;
  }
  function clearMessageViews(accountId) {
    for (const [url, record] of messageViews) if (record.accountId === accountId) messageViews.delete(url);
  }
  function messageImageAllowed(details, id) {
    const record = messageView(details.frame?.url, id);
    return !!record?.enabled && details.resourceType === 'image'
      && details.webContentsId === views.get(id)?.view.webContents.id
      && record.images.has(details.url);
  }
  async function confirmExternal(value) {
    const url = policy.externalURL(value);
    if (!url || promptOpen || !window || window.isDestroyed()) return;
    promptOpen = true;
    try {
      const result = await prompt.showMessageBox(window, {
        type: 'question', title: 'Åbn link uden for Veyro Mail?',
        message: 'Vil du åbne dette link i en anden app?', detail: url,
        buttons: ['Annuller', 'Åbn link'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response === 1) await openExternal(url);
    } catch { notify('Linket kunne ikke åbnes.'); }
    finally { promptOpen = false; }
  }
  function secureContents(contents, {remote = false, expected, accountId} = {}) {
    contents.setWindowOpenHandler(({url}) => {
      if (remote && policy.allowedRemote(url, origin)) void contents.loadURL(url).catch(() => {});
      else void confirmExternal(url);
      return {action: 'deny'};
    });
    const guard = (event, target) => {
      const url = typeof target === 'string' ? target : target.url;
      if ((remote && policy.allowedRemote(url, origin)) || (!remote && policy.trustedDocument(url, expected))) return;
      event.preventDefault();
      void confirmExternal(url);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-frame-navigate', (event) => {
      const details = event;
      if (details.isMainFrame) return;
      if (remote && (policy.allowedRemote(details.url, origin) || ['about:blank', 'about:srcdoc'].includes(details.url))) return;
      if (!remote && messageView(details.url, accountId)) return;
      event.preventDefault();
      void confirmExternal(details.url);
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  }
  function configureSession(id, native = false) {
    if (protectedSessions.has(id)) return protectedSessions.get(id);
    const ses = session.fromPartition(policy.partitionFor(id));
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    // Block cross-origin document loads even when navigation starts outside a click handler.
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (native) {
        callback({cancel: !details.url.startsWith('veyro://mail/') && !messageView(details.url, id) && !messageImageAllowed(details, id)});
      } else if (['mainFrame', 'subFrame'].includes(details.resourceType)) {
        callback({cancel: !policy.allowedRemote(details.url, origin) && !['about:blank', 'about:srcdoc'].includes(details.url)});
      } else {
        const url = policy.parseURL ? policy.parseURL(details.url) : new URL(details.url);
        callback({cancel: ['file:', 'veyro:'].includes(url.protocol) || (url.protocol === 'http:' && !testing)});
      }
    });
    if (native) {
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = {...details.requestHeaders};
        if (details.url.startsWith('https:')) for (const key of Object.keys(headers)) {
          if (['cookie', 'authorization', 'referer', 'origin'].includes(key.toLowerCase())) delete headers[key];
        }
        callback({requestHeaders: headers});
      });
      ses.webRequest.onHeadersReceived((details, callback) => {
        const headers = {...details.responseHeaders};
        if (details.url.startsWith('https:')) for (const key of Object.keys(headers)) if (key.toLowerCase() === 'set-cookie') delete headers[key];
        callback({responseHeaders: headers});
      });
    }
    ses.on('will-download', (event, item, contents) => {
      const owner = views.get(id);
      const url = item.getURL();
      const allowed = policy.allowedRemote(url, origin) || (url.startsWith('blob:') && policy.allowedRemote(url.slice(5), origin));
      if (native || !owner || owner.view.webContents !== contents || !allowed) { event.preventDefault(); return; }
      const items = downloads.get(id) || new Set();
      items.add(item); downloads.set(id, items);
      item.setSaveDialogOptions({
        title: 'Gem vedhæftning',
        defaultPath: path.join(app.getPath('downloads'), policy.safeFilename(item.getFilename())),
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      });
      item.once('done', (_event, status) => {
        items.delete(item);
        if (status === 'completed') notify('Vedhæftningen er gemt.');
        else if (status !== 'cancelled') notify('Download mislykkedes. Prøv igen.');
      });
    });
    protectedSessions.set(id, ses);
    return ses;
  }
  async function installProtocol(ses, accountId) {
    const files = new Map([
      ['shell/index.html', ['shell.html', 'text/html']], ['shell/shell.js', ['shell.js', 'text/javascript']],
      ['shell/shell.css', ['shell.css', 'text/css']], ['shell/logo.svg', ['assets/logo.svg', 'image/svg+xml']],
      ['shell/manrope.woff2', ['assets/manrope.woff2', 'font/woff2']],
      ['mail/index.html', ['mail-client.html', 'text/html']],
      ['mail/mail-client.js', ['mail-client.js', 'text/javascript']], ['mail/mail-client.css', ['mail-client.css', 'text/css']],
      ['mail/manrope.woff2', ['assets/manrope.woff2', 'font/woff2']], ['mail/logo.svg', ['assets/logo.svg', 'image/svg+xml']],
    ]);
    await ses.protocol.handle('veyro', async (request) => {
      const url = new URL(request.url);
      if (url.hostname === 'message') {
        const record = messageView(url.href, accountId);
        if (!record || request.method !== 'GET') return new Response('Not found', {status: 404});
        return new Response(record.html, {headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': `default-src 'none'; sandbox; script-src 'none'; style-src 'unsafe-inline'; img-src data:${record.enabled ? ' https:' : ''}; font-src 'none'; frame-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
        }});
      }
      const file = files.get(`${url.hostname}${url.pathname}`);
      if (!file || url.search || url.username || url.password || request.method !== 'GET') return new Response('Not found', {status: 404});
      try {
        return new Response(await fs.readFile(path.join(__dirname, file[0])), {headers: {
          'Content-Type': `${file[1]}; charset=utf-8`,
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src veyro://message; object-src 'none'; base-uri 'none'; form-action 'none'",
          'X-Content-Type-Options': 'nosniff',
        }});
      } catch { return new Response('Not found', {status: 404}); }
    });
  }
  async function createView(account) {
    const native = account.kind === 'external';
    const ses = configureSession(account.id, native);
    if (native && !(await ses.protocol.isProtocolHandled('veyro'))) await installProtocol(ses, account.id);
    // Remote mail intentionally has NO preload and no privileged bridge.
    const preferences = {...policy.secureWebPreferences, session: ses};
    if (native) preferences.preload = path.join(__dirname, 'mail-preload.cjs');
    const view = new WebContentsView({webPreferences: preferences});
    const entry = {view, status: 'loading', section: 'mail', failed: false};
    views.set(account.id, entry);
    window.contentView.addChildView(view);
    view.setBackgroundColor('#faf9f6');
    secureContents(view.webContents, {remote: !native, expected: policy.CLIENT_URL, accountId: account.id});
    view.webContents.on('did-start-loading', () => { entry.failed = false; entry.status = 'loading'; layout(); publish(); });
    view.webContents.on('did-finish-load', () => { if (!entry.failed) entry.status = 'ready'; layout(); publish(); });
    view.webContents.on('did-stop-loading', () => {
      // A download can stop navigation without finishing a new document.
      if (!entry.failed && entry.status === 'loading' && view.webContents.getURL()) { entry.status = 'ready'; layout(); publish(); }
    });
    view.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { entry.failed = true; entry.status = 'offline'; layout(); publish(); }
    });
    view.webContents.on('render-process-gone', () => { entry.status = 'offline'; layout(); publish(); });
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) {
        const parsed = new URL(url);
        entry.section = parsed.pathname === '/team' ? (parsed.hash === '#intranet' ? 'intranet' : 'chat') : 'mail';
        publish();
      }
    });
    layout();
    void view.webContents.loadURL(native ? policy.CLIENT_URL : origin).catch(() => {});
    return entry;
  }
  async function switchAccount(id) {
    const account = accountById(id);
    activeId = id;
    if (!views.has(id)) await createView(account);
    await saveAccounts();
    layout(); publish();
  }
  async function removeAccount(id) {
    const account = accountById(id);
    const result = await prompt.showMessageBox(window, {
      type: 'warning', title: 'Fjern konto', message: `Fjern “${account.label}” fra denne computer?`,
      detail: 'Login, cookies, cache og lokale kladder slettes for denne konto. Mails på serveren bliver ikke slettet.',
      buttons: ['Annuller', 'Fjern konto'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return state();
    removing.add(id);
    invalidateOAuth(id);
    // Finish any in-flight account operation before deleting its credential vault.
    await accountQueues.get(id)?.catch(() => {});
    for (const download of downloads.get(id) || []) download.cancel();
    downloads.delete(id);
    const entry = views.get(id);
    if (entry) { window.contentView.removeChildView(entry.view); entry.view.webContents.close(); views.delete(id); }
    const ses = configureSession(id, account.kind === 'external');
    await ses.closeAllConnections();
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
    await vault.remove(id);
    clearMessageViews(id);
    accountQueues.delete(id);
    accounts = accounts.filter((item) => item.id !== id);
    if (activeId === id) activeId = accounts[0]?.id;
    if (activeId) await switchAccount(activeId); else await saveAccounts();
    removing.delete(id);
    layout(); publish();
    return state();
  }
  function assertSender(event, expected, contents) {
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame || !policy.trustedDocument(event.senderFrame?.url, expected)) {
      throw new Error('Denne side har ikke adgang til desktop-funktioner.');
    }
  }
  async function shellAction(action, payload = {}) {
    switch (action) {
      case 'state': return state();
      case 'dialog': dialogOpen = payload.open === true; layout(); publish(); return state();
      case 'add': {
        if (accounts.length >= 30) throw new Error('Du kan have op til 30 konti.');
        if (!['veyro', 'external'].includes(payload.kind)) throw new Error('Vælg en kontotype.');
        const account = {id: randomUUID(), label: policy.normalizeLabel(payload.label), kind: payload.kind};
        accounts.push(account);
        await switchAccount(account.id);
        return state();
      }
      case 'rename': accountById(payload.id).label = policy.normalizeLabel(payload.label); await saveAccounts(); publish(); return state();
      case 'switch': await switchAccount(payload.id); return state();
      case 'remove': return removeAccount(payload.id);
      case 'section': {
        const account = accountById(activeId);
        if (account.kind !== 'veyro' && payload.section !== 'mail') throw new Error('Chat og intranet kræver en Veyro-konto. Skift til eller tilføj en Veyro-konto.');
        const routes = {mail: '/', chat: '/team#chat', intranet: '/team#intranet'};
        if (!(payload.section in routes)) throw new Error('Ukendt område.');
        const entry = views.get(activeId);
        entry.section = payload.section;
        void entry.view.webContents.loadURL(account.kind === 'external' ? policy.CLIENT_URL : `${origin}${routes[payload.section]}`).catch(() => {});
        publish(); return state();
      }
      case 'retry': {
        const entry = views.get(activeId);
        if (entry) {
          // A retry may begin before Chromium finishes the failed navigation;
          // in that case did-start-loading need not fire again.
          entry.failed = false;
          entry.status = 'loading';
          layout(); publish();
          entry.view.webContents.reload();
        }
        return state();
      }
      case 'dismiss': toast = ''; publish(); return state();
      default: throw new Error('Ukendt desktop-handling.');
    }
  }
  function publicAccount(account) {
    if (!account) return undefined;
    const endpoint = (value) => ({host: value.host, port: value.port, secure: value.secure, user: value.user});
    return {email: account.email, name: account.name, saveSent: account.saveSent, authType: account.authType, oauthProvider: account.oauthProvider,
      imap: endpoint(account.imap), smtp: endpoint(account.smtp)};
  }
  async function mailAction(id, action, payload = {}, oauthGeneration) {
    const metadata = accountById(id);
    if (metadata.kind !== 'external') throw new Error('Ikke en ekstern mailkonto.');
    const saved = await vault.read(id);
    const identity = (account = saved.account) => ({id, label: metadata.label, configured: !!account, account: publicAccount(account), oauth: oauth.availability()});
    if (action === 'bootstrap') return identity();
    if (action === 'messageImages') {
      const previous = messageView(payload.htmlUrl, id);
      if (!previous) throw new Error('Åbn mailen igen for at vise billeder.');
      messageViews.delete(payload.htmlUrl);
      const htmlUrl = `veyro://message/${randomUUID()}`;
      messageViews.set(htmlUrl, {...previous, enabled: payload.enabled === true, createdAt: Date.now()});
      return {htmlUrl, hasRemoteImages: previous.images.size > 0, richAvailable: true};
    }
    const {createMailConnector} = require('./mail-connector.cjs');
    if (action === 'oauthConnect') {
      const assertAttempt = () => {
        if (removing.has(id) || shuttingDown || (oauthGeneration !== undefined && oauthAttempts.get(id) !== oauthGeneration)) throw new Error('Login blev annulleret.');
      };
      assertAttempt();
      const account = {...providerAccount(payload.provider, payload.email, payload.name), id};
      const tokens = await oauth.connect(id, payload.provider, account.email);
      assertAttempt();
      const authenticated = {...account, imap: {...account.imap, accessToken: tokens.accessToken}, smtp: {...account.smtp, accessToken: tokens.accessToken}};
      await createMailConnector({account: authenticated}).verify();
      assertAttempt();
      await vault.write(id, {...saved, account, oauth: tokens});
      clearMessageViews(id);
      return identity(account);
    }
    if (action === 'configure') {
      const account = {id, email: payload.email, name: payload.name, saveSent: payload.saveSent,
        imap: policy.accountEndpoint(payload.imap, saved.account?.imap, payload.email, saved.account?.email),
        smtp: policy.accountEndpoint(payload.smtp, saved.account?.smtp, payload.email, saved.account?.email),
      };
      const connector = createMailConnector({account});
      await connector.verify();
      await vault.write(id, {...saved, account, oauth: undefined});
      clearMessageViews(id);
      return identity(account);
    }
    if (action === 'drafts') return saved.drafts || [];
    if (action === 'saveDraft') {
      if (!payload || typeof payload !== 'object' || JSON.stringify(payload).length > 35 * 1024 * 1024) throw new Error('Kladden er for stor.');
      const draft = {...payload, id: policy.UUID.test(payload.id) ? payload.id : randomUUID(), updatedAt: new Date().toISOString()};
      const drafts = (saved.drafts || []).filter((item) => item.id !== draft.id);
      if (drafts.length >= 50) throw new Error('Du kan gemme op til 50 lokale kladder.');
      await vault.write(id, {...saved, drafts: [...drafts, draft]});
      return draft;
    }
    if (action === 'deleteDraft') {
      await vault.write(id, {...saved, drafts: (saved.drafts || []).filter((item) => item.id !== payload.id)});
      return {ok: true};
    }
    if (!saved.account) throw new Error('Forbind først din mailkonto.');
    let authenticated = saved.account;
    if (saved.account.authType === 'oauth') {
      const tokens = await oauth.fresh(saved.oauth);
      if (tokens !== saved.oauth) await vault.write(id, {...saved, oauth: tokens});
      authenticated = {...saved.account, imap: {...saved.account.imap, accessToken: tokens.accessToken}, smtp: {...saved.account.smtp, accessToken: tokens.accessToken}};
    }
    const connector = createMailConnector({account: authenticated});
    if (action === 'saveAttachment') {
      const attachment = await connector.attachment(payload);
      const result = await prompt.showSaveDialog(window, {title: 'Gem vedhæftning', defaultPath: path.join(app.getPath('downloads'), policy.safeFilename(attachment.filename)), properties: ['showOverwriteConfirmation', 'createDirectory']});
      if (result.canceled || !result.filePath) return {saved: false};
      await fs.writeFile(result.filePath, attachment.data);
      return {saved: true};
    }
    if (!['folders', 'messages', 'message', 'action', 'send'].includes(action)) throw new Error('Ukendt mailhandling.');
    const result = await connector[action](payload);
    if (action === 'message') {
      clearMessageViews(id);
      const {html, remoteImages, ...message} = result;
      if (html && typeof html === 'string') {
        const images = new Set((remoteImages || []).filter((value) => {
          try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
        }));
        const htmlUrl = `veyro://message/${randomUUID()}`;
        messageViews.set(htmlUrl, {accountId: id, html, images, enabled: false, createdAt: Date.now()});
        return {...message, htmlUrl, hasRemoteImages: images.size > 0, richAvailable: true};
      }
      return message;
    }
    return result;
  }
  await app.whenReady();
  await loadAccounts();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  await installProtocol(session.defaultSession);
  ipcMain.handle('veyro:shell', (event, action, payload) => {
    assertSender(event, policy.SHELL_URL, window?.webContents);
    const result = mutation.then(() => shellAction(action, payload));
    mutation = result.catch(() => {});
    return result;
  });
  ipcMain.handle('veyro:mail', (event, action, payload) => {
    const entry = [...views.entries()].find(([, candidate]) => candidate.view.webContents === event.sender);
    if (!entry) throw new Error('Ukendt konto.');
    assertSender(event, policy.CLIENT_URL, entry[1].view.webContents);
    if (removing.has(entry[0])) throw new Error('Kontoen bliver fjernet.');
    if (action === 'oauthCancel') { invalidateOAuth(entry[0]); return {cancelled: true}; }
    if (typeof action !== 'string' || payload === null || (typeof payload !== 'object' && payload !== undefined)) throw new Error('Ugyldig mailhandling.');
    const previous = accountQueues.get(entry[0]) || Promise.resolve();
    const generation = action === 'oauthConnect' ? invalidateOAuth(entry[0]) : undefined;
    const result = previous.then(() => mailAction(entry[0], action, payload, generation));
    accountQueues.set(entry[0], result.catch(() => {}));
    return result;
  });
  function currentContents() { return views.get(activeId)?.view.webContents; }
  function buildMenu() {
    const active = () => currentContents();
    const template = [
      ...(process.platform === 'darwin' ? [{role: 'appMenu', label: 'Veyro Mail'}] : []),
      {label: 'Konto', submenu: [
        {label: 'Tilføj konto…', accelerator: 'CmdOrCtrl+Shift+A', click: () => { dialogOpen = true; layout(); window.webContents.send('veyro:open-add'); }},
        {type: 'separator'}, {role: process.platform === 'darwin' ? 'close' : 'quit'},
      ]},
      {label: 'Rediger', submenu: [{role: 'undo'}, {role: 'redo'}, {type: 'separator'}, {role: 'cut'}, {role: 'copy'}, {role: 'paste'}, {role: 'selectAll'}]},
      {label: 'Vis', submenu: [
        {label: 'Genindlæs', accelerator: 'CmdOrCtrl+R', click: () => active()?.reload()},
        {label: 'Genindlæs uden cache', accelerator: 'CmdOrCtrl+Shift+R', click: () => active()?.reloadIgnoringCache()},
        {type: 'separator'},
        {label: 'Zoom ind', accelerator: 'CmdOrCtrl+Plus', click: () => { const c = active(); if (c) c.setZoomLevel(Math.min(c.getZoomLevel() + 0.5, 3)); }},
        {label: 'Zoom ud', accelerator: 'CmdOrCtrl+-', click: () => { const c = active(); if (c) c.setZoomLevel(Math.max(c.getZoomLevel() - 0.5, -2)); }},
        {label: 'Faktisk størrelse', accelerator: 'CmdOrCtrl+0', click: () => active()?.setZoomLevel(0)},
        {type: 'separator'}, {role: 'togglefullscreen'},
      ]},
      {label: 'Vindue', submenu: [{role: 'minimize'}, {role: 'zoom'}]},
      {label: 'Hjælp', submenu: [{label: 'Om Veyro Mail', click: () => prompt.showMessageBox(window, {title: 'Veyro Mail', message: `Veyro Mail ${app.getVersion()}`, detail: 'Mail, chat og intranet — samlet på dit skrivebord.\nDenne betaversion er ikke signeret med et verificeret udgivercertifikat.'})}]},
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
  async function createWindow() {
    window = new BrowserWindow({title: 'Veyro Mail', width: 1440, height: 960, minWidth: 920, minHeight: 640, show: false,
      backgroundColor: '#f4f2ec', icon: path.join(__dirname, 'assets/icon.png'),
      webPreferences: {...policy.secureWebPreferences, preload: path.join(__dirname, 'preload.cjs')},
    });
    secureContents(window.webContents, {expected: policy.SHELL_URL});
    window.on('resize', layout);
    window.on('closed', () => {
      for (const entry of views.values()) if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
      views.clear(); messageViews.clear(); window = undefined;
    });
    await window.loadURL(policy.SHELL_URL);
    if (activeId) await switchAccount(activeId);
    buildMenu();
    if (!options.hidden) window.show();
    publish();
  }
  await createWindow();
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('activate', () => { if (!window && !shuttingDown) void createWindow(); else window?.show(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { shuttingDown = true; oauth.cancelAll(); });
  // Only an unpackaged test harness receives these references. This is never exposed to a page.
  if (testing) return {get window() { return window; }, views, messageViews, messageImageAllowed, state, shellAction, mailAction, assertSender, configureSession, vault, origin};
}

if (require.main === module) bootstrap().catch((error) => {
  dialog.showErrorBox('Veyro Mail kunne ikke starte', error.message);
  app.quit();
});
module.exports = {bootstrap};
