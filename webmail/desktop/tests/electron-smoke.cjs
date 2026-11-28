'use strict';
const {app} = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {randomUUID} = require('node:crypto');
const {bootstrap} = require('../main.cjs');
const {SHELL_URL} = require('../security.cjs');
let runtime, server, temp, offline = false;
const confirmations = [], opened = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 400; i++) { if (await fn()) return; await wait(25); } throw new Error(`Timed out: ${label}`); }
async function run() {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'veyro-desktop-smoke-'));
  server = http.createServer((request, response) => {
    if (offline) { request.socket.destroy(); return; }
    if (request.url === '/attachment') { response.writeHead(200, {'Content-Disposition': 'attachment; filename="smoke.txt"', 'Content-Type': 'application/octet-stream'}); response.end('Veyro attachment smoke'); return; }
    response.writeHead(200, {'Content-Type': 'text/html'});
    response.end('<!doctype html><html><body style="font-family:system-ui;background:#faf9f6;padding:40px"><h1>Veyro Mail · testkonto</h1><p>Isoleret session og sikker desktop-skal.</p><a id="download" href="/attachment">Gem vedhæftning</a></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  runtime = await bootstrap({test: true, hidden: true, userData: temp, testOrigin: origin,
    dialog: {
      async showMessageBox(_window, options) { confirmations.push(options); return {response: options.title === 'Fjern konto' ? 1 : 0}; },
      async showSaveDialog() { return {canceled: true}; },
    }, openExternal: async (url) => opened.push(url),
  });
  const firstId = runtime.state().activeId;
  await until(() => runtime.state().status === 'ready', 'initial remote page');
  const first = runtime.views.get(firstId).view.webContents;
  assert.deepEqual(await first.executeJavaScript('({node: typeof require, process: typeof process, shell: typeof veyroDesktop, mail: typeof veyroMail})'), {node: 'undefined', process: 'undefined', shell: 'undefined', mail: 'undefined'});
  assert.equal(first.getLastWebPreferences().sandbox, true);
  assert.equal(first.getLastWebPreferences().contextIsolation, true);
  assert.equal(first.getLastWebPreferences().nodeIntegration, false);
  assert.throws(() => runtime.assertSender({sender: first, senderFrame: first.mainFrame}, SHELL_URL, runtime.window.webContents), /ikke adgang/);
  await first.executeJavaScript('document.cookie="account=first;path=/";localStorage.setItem("marker","first")');
  await runtime.window.webContents.executeJavaScript('window.veyroDesktop.invoke("add",{label:"Arbejde",kind:"veyro"})');
  const secondId = runtime.state().activeId;
  await until(() => runtime.state().status === 'ready', 'second account');
  const second = runtime.views.get(secondId).view.webContents;
  assert.equal(await second.executeJavaScript('document.cookie'), '');
  assert.equal(await second.executeJavaScript('localStorage.getItem("marker")'), null);
  await second.executeJavaScript('document.cookie="account=second;path=/"');
  await runtime.shellAction('switch', {id: firstId});
  assert.match(await first.executeJavaScript('document.cookie'), /account=first/);
  await runtime.shellAction('rename', {id: firstId, label: 'Privat'});
  assert.equal(runtime.state().accounts[0].label, 'Privat');
  await first.executeJavaScript('window.open("https://example.com/test")');
  await until(() => confirmations.length === 1, 'external link confirmation');
  assert.equal(opened.length, 0);
  assert.ok(first.getURL().startsWith(origin));
  await first.executeJavaScript('window.open("file:///etc/passwd")');
  await wait(100);
  assert.equal(confirmations.length, 1);
  const downloadPath = path.join(temp, 'attachment.txt');
  first.session.once('will-download', (_event, item, source) => {
    assert.equal(_event.defaultPrevented, false);
    assert.equal(source?.id, first.id);
    assert.equal(item.getSaveDialogOptions().title, 'Gem vedhæftning');
    item.setSavePath(downloadPath); // Only the test harness bypasses the native Save dialog.
  });
  await first.executeJavaScript('document.getElementById("download").click()');
  await until(async () => { try { return (await fs.readFile(downloadPath, 'utf8')) === 'Veyro attachment smoke'; } catch { return false; } }, 'attachment download');
  await runtime.shellAction('section', {section: 'chat'});
  await until(() => first.getURL() === `${origin}/team#chat`, 'team navigation');
  await runtime.shellAction('section', {section: 'intranet'});
  await until(() => first.getURL() === `${origin}/team#intranet`, 'intranet navigation');
  await until(() => runtime.state().status === 'ready' && !first.isLoading(), 'intranet document loaded');
  offline = true;
  await runtime.shellAction('retry');
  await until(() => runtime.state().status === 'offline', 'offline fallback');
  assert.equal(runtime.views.get(firstId).view.getVisible(), false);
  offline = false;
  await runtime.shellAction('retry');
  await until(() => runtime.state().status === 'ready', 'retry recovery');
  const firstSession = first.session;
  await runtime.shellAction('remove', {id: firstId});
  assert.equal(runtime.views.has(firstId), false);
  assert.equal((await firstSession.cookies.get({})).length, 0);
  assert.match(await second.executeJavaScript('document.cookie'), /account=second/);
  const saved = JSON.parse(await fs.readFile(path.join(temp, 'accounts.json'), 'utf8'));
  assert.equal(saved.accounts.length, 1);
  assert.equal(saved.accounts[0].id, secondId);
  await fs.mkdir(path.join(__dirname, '../.test-output'), {recursive: true});
  await fs.writeFile(path.join(__dirname, '../.test-output/shell.png'), (await runtime.window.webContents.capturePage()).toPNG());
  await runtime.shellAction('dialog', {open: true});
  assert.equal(runtime.views.get(secondId).view.getVisible(), false);
  await runtime.shellAction('dialog', {open: false});
  if (await fs.stat(path.join(__dirname, '../mail-client.html')).catch(() => null)) {
    await runtime.shellAction('add', {kind: 'external', label: 'IMAP test'});
    await until(() => runtime.state().status === 'ready', 'native client');
    const native = runtime.views.get(runtime.state().activeId).view.webContents;
    assert.deepEqual(await native.executeJavaScript('({node:typeof require,bridge:typeof veyroMail,shell:typeof veyroDesktop})'), {node: 'undefined', bridge: 'object', shell: 'undefined'});
    assert.equal((await native.executeJavaScript('veyroMail.invoke("bootstrap")')).configured, false);
    assert.deepEqual((await native.executeJavaScript('veyroMail.invoke("bootstrap")')).oauth, {google: {available: false}, microsoft: {available: false}});
    // Real asynchronous OS encryption, draft persistence and public-data redaction.
    await native.executeJavaScript('veyroMail.invoke("saveDraft",{subject:"Private draft",text:"SECRET-SMOKE-DRAFT"})');
    console.log('Smoke: encrypted draft saved');
    assert.equal((await native.executeJavaScript('veyroMail.invoke("drafts")')).length, 1);
    const nativeId = runtime.state().activeId;
    assert.equal((await fs.readFile(path.join(temp, 'vault', `${nativeId}.enc`))).includes('SECRET-SMOKE-DRAFT'), false);
    app.show?.(); runtime.window.show();
    await wait(250);
    console.log('Smoke: capturing native view', native.getURL(), runtime.views.get(nativeId).view.getVisible());
    try { await fs.writeFile(path.join(__dirname, '../.test-output/native-settings.png'), (await runtime.window.capturePage()).toPNG()); }
    catch (error) { console.log('Screenshot unavailable:', error.message); }
    await assert.rejects(runtime.shellAction('section', {section: 'chat'}), /Veyro-konto/);
    const htmlUrl = `veyro://message/${randomUUID()}`;
    runtime.messageViews.set(htmlUrl, {accountId: nativeId, createdAt: Date.now(), enabled: false,
      images: new Set(['https://example.org/image.png']), html: '<!doctype html><html><body><h1 id="safe">Rich mail</h1><script>window.emailScriptRan=true</script></body></html>'});
    await native.executeJavaScript(`(()=>{const f=document.createElement('iframe');f.sandbox='';f.src=${JSON.stringify(htmlUrl)};document.body.append(f);})()`);
    await until(() => native.mainFrame.frames.some((frame) => frame.url === htmlUrl), 'isolated email frame');
    const frame = native.mainFrame.frames.find((candidate) => candidate.url === htmlUrl);
    await assert.rejects(frame.executeJavaScript('window.emailScriptRan'), 'Email frame must refuse script execution');
    assert.throws(() => runtime.assertSender({sender: native, senderFrame: frame}, 'veyro://mail/index.html', native), /ikke adgang/);
    const details = {frame, resourceType: 'image', webContentsId: native.id, url: 'https://example.org/image.png'};
    assert.equal(runtime.messageImageAllowed(details, nativeId), false);
    const replacement = await native.executeJavaScript(`veyroMail.invoke('messageImages',{htmlUrl:${JSON.stringify(htmlUrl)},enabled:true})`);
    assert.notEqual(replacement.htmlUrl, htmlUrl);
    assert.equal(runtime.messageViews.has(htmlUrl), false);
    const syntheticFrame = {url: replacement.htmlUrl};
    assert.equal(runtime.messageImageAllowed({...details, frame: syntheticFrame}, nativeId), true);
    assert.equal(runtime.messageImageAllowed({...details, frame: syntheticFrame, resourceType: 'script'}, nativeId), false);
    assert.equal(runtime.messageImageAllowed({...details, frame: syntheticFrame, url: 'https://evil.test/track'}, nativeId), false);
    assert.equal(runtime.messageImageAllowed({...details, frame: syntheticFrame}, secondId), false);
    // Cancel a queued OAuth attempt before it can open a browser.
    const savedWrite = runtime.vault.write;
    let releaseQueuedWrite, queuedWriteStarted;
    const queuedGate = new Promise((resolve) => { releaseQueuedWrite = resolve; });
    const queuedStart = new Promise((resolve) => { queuedWriteStarted = resolve; });
    runtime.vault.write = async (...args) => { queuedWriteStarted(); await queuedGate; return savedWrite(...args); };
    const heldWrite = native.executeJavaScript('veyroMail.invoke("saveDraft",{text:"Before OAuth"})');
    await queuedStart;
    const queuedOAuth = native.executeJavaScript('veyroMail.invoke("oauthConnect",{provider:"google",email:"test@example.org"})').then(() => '', (error) => error.message);
    await native.executeJavaScript('veyroMail.invoke("oauthCancel")');
    releaseQueuedWrite(); await heldWrite;
    assert.match(await queuedOAuth, /annulleret/);
    runtime.vault.write = savedWrite;
    // Removal rejects newly submitted work while an existing encrypted write is draining.
    let releaseWrite, startedWrite;
    const gate = new Promise((resolve) => { releaseWrite = resolve; });
    const started = new Promise((resolve) => { startedWrite = resolve; });
    const originalWrite = runtime.vault.write;
    runtime.vault.write = async (...args) => { startedWrite(); await gate; return originalWrite(...args); };
    const pendingWrite = native.executeJavaScript('veyroMail.invoke("saveDraft",{text:"REMOVAL-RACE"})').catch(() => {});
    await started;
    const removal = runtime.shellAction('remove', {id: nativeId});
    await assert.rejects(native.executeJavaScript('veyroMail.invoke("saveDraft",{text:"MUST-NOT-PERSIST"})'), /fjernet/);
    releaseWrite();
    await pendingWrite; await removal;
    assert.equal(await fs.stat(path.join(temp, 'vault', `${nativeId}.enc`)).catch(() => null), null);
    assert.equal(runtime.messageViews.has(replacement.htmlUrl), false);
  }
  console.log('PASS Electron integration: sandbox, origin guards, account isolation, IPC identity, confirmed external links, downloads, navigation, offline/retry, removal and local client.');
}
run().then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1); }).finally(() => { server?.close(); });
