import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium, devices, webkit } from 'playwright';

const account = {email:'employee@example.test', password:'fixture-password'};
const assets = new Map(await Promise.all(Object.entries({
  '/': ['inbox.html', 'text/html; charset=utf-8'],
  '/inbox.js': ['inbox.js', 'text/javascript'],
  '/inbox.css': ['inbox.css', 'text/css'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/manrope.woff2': ['manrope.woff2', 'font/woff2'],
}).map(async ([path, [file, mime]]) =>
  [path, {mime, body:await readFile(new URL('./assets/' + file, import.meta.url))}])));

async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return 'http://127.0.0.1:' + server.address().port;
}

for (const [engine, device] of [[chromium, 'Pixel 7'], [webkit, 'iPhone 13']]) {
  test('mobile login supplies its own Origin and never follows an external redirect in ' + engine.name(), async t => {
    const browser = await engine.launch(engine === chromium ? {channel:process.env.WEBMAIL_BROWSER} : {});
    t.after(() => browser.close());
    const context = await browser.newContext(devices[device]);
    const page = await context.newPage();
    const forwarded = [], logins = [], sessionReads = [];
    const otherOrigin = await listen(t, (req, res) => {
      forwarded.push(req.url);
      res.writeHead(200).end();
    });

    let redirect = false;
    const origin = await listen(t, async (req, res) => {
      const path = req.url.split('?')[0];
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      if (assets.has(path)) {
        const {mime, body} = assets.get(path);
        res.writeHead(200, {'Content-Type':mime}).end(body);
        return;
      }
      const json = (status, value) => res.writeHead(status, {'Content-Type':'application/json'}).end(JSON.stringify(value));
      if (path === '/api/session') {
        sessionReads.push(req.headers.referer);
        return json(401, {error:'Log ind for at fortsætte.'});
      }
      if (path === '/api/login' && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        logins.push({headers:req.headers, body:JSON.parse(Buffer.concat(chunks).toString())});
        // Like the Worker, compare the on-the-wire Origin to the exact site origin.
        if (req.headers.origin !== origin) return json(403, {error:'Ugyldig oprindelse.'});
        if (redirect) return res.writeHead(307, {Location:otherOrigin + '/unexpected'}).end();
        return json(200, {email:account.email, csrfToken:'fixture-csrf'});
      }
      if (path === '/api/folders') return json(200, {folders:[]});
      return json(404, {});
    });

    async function submitLogin() {
      await page.goto(origin + '/?private-test-query=1');
      await page.getByLabel('E-mailadresse', {exact:true}).fill(account.email);
      await page.getByLabel('Adgangskode', {exact:true}).fill(account.password);
      await page.getByRole('button', {name:'Log ind', exact:true}).click();
    }
    await submitLogin();
    await page.locator('#workspace:not([hidden]), #login-error:not([hidden])').waitFor();
    assert.equal(logins.length, 1);
    const [{headers, body}] = logins;
    assert.equal(headers.origin, origin, 'Origin received from ' + engine.name());
    assert.deepEqual(body, account);
    assert.ok([undefined, origin, origin + '/'].includes(headers.referer), 'the page query stays private');
    assert.deepEqual(sessionReads, [undefined], 'GET uses the document’s no-referrer policy');
    assert.ok(await page.locator('#workspace').isVisible());

    redirect = true;
    await submitLogin();
    await page.locator('#login-error').waitFor();
    assert.equal(logins.length, 2);
    assert.equal(await page.locator('#workspace').isVisible(), false);
    assert.deepEqual(forwarded, [], 'the second origin received no request');
  });
}
