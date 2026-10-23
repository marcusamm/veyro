// Lokal simulator af Googles OAuth- og Gmail-endpoints samt en lille offentlig "hjemmeside" til test af
// "Tilføj via link" og søgning i kilder. Kun til test; der rammes aldrig Google eller rigtige hjemmesider.
import http from 'node:http';

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function startGoogleMock() {
  const state = {
    // account -> { historyId, messages: [{ id, threadId, historyId, labelIds, internalDate, headers: {}, body }] }
    boxes: {},
    calls: [],
    drafts: [],
    revoked: [],
    failToken: false,
  };
  const box = (a) => (state.boxes[a] ??= { historyId: 100, messages: [] });
  const accountOf = (req) => {
    const m = /^Bearer at_(.+)$/.exec(req.headers.authorization ?? '');
    return m ? m[1] : null;
  };
  const toMsg = (m, format) => ({
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds ?? ['INBOX'],
    snippet: (m.body ?? '').slice(0, 80),
    internalDate: String(m.internalDate),
    historyId: String(m.historyId),
    payload: {
      mimeType: format === 'full' ? 'multipart/alternative' : 'text/plain',
      headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })),
      ...(format === 'full'
        ? {
            parts: [
              { mimeType: 'text/plain', body: { data: b64url(m.body ?? '') } },
              { mimeType: 'text/html', body: { data: b64url(`<p>${m.body ?? ''}</p><img src="https://tracker.example/pixel.gif">`) } },
            ],
          }
        : {}),
    },
  });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const page = (status, h, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
        res.end(h);
      };

      // --- Styring fra testene ---
      if (p === '/__g/add' && req.method === 'POST') {
        const { account, message } = JSON.parse(body);
        const b = box(account);
        b.historyId += 1;
        b.messages.push({ ...message, historyId: b.historyId });
        return json(200, { historyId: b.historyId });
      }
      if (p === '/__g/state' && req.method === 'POST') {
        Object.assign(state, JSON.parse(body));
        return json(200, { ok: true });
      }
      if (p === '/__g/state') return json(200, state);

      // --- OAuth ---
      if (p === '/token' && req.method === 'POST') {
        const f = Object.fromEntries(new URLSearchParams(body));
        state.calls.push({ path: p, grant: f.grant_type });
        if (state.failToken) return json(400, { error: 'invalid_grant' });
        if (f.client_id !== 'test-client' || f.client_secret !== 'test-secret') return json(401, { error: 'invalid_client' });
        if (f.grant_type === 'authorization_code') {
          // Testkoden er "code|<konto>|<rettigheder adskilt af +>"
          const [, account, scopes = ''] = f.code.split('|');
          if (!f.code_verifier) return json(400, { error: 'invalid_request' });
          return json(200, { access_token: `at_${account}`, refresh_token: `rt_${account}`, expires_in: 3600, scope: scopes.split('+').join(' ') });
        }
        if (f.grant_type === 'refresh_token') return json(200, { access_token: `at_${f.refresh_token.replace(/^rt_/, '')}`, expires_in: 3600 });
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (p === '/revoke' && req.method === 'POST') {
        state.revoked.push(Object.fromEntries(new URLSearchParams(body)).token);
        return json(200, {});
      }

      // --- Gmail API ---
      const gm = /^\/gmail\/v1\/users\/me(\/.*)$/.exec(p);
      if (gm) {
        const account = accountOf(req);
        if (!account) return json(401, { error: { status: 'UNAUTHENTICATED' } });
        const b = box(account);
        const sub = gm[1];
        state.calls.push({ path: sub, account, format: url.searchParams.get('format'), q: url.searchParams.get('q') });
        if (sub === '/profile') return json(200, { emailAddress: account, historyId: String(b.historyId) });
        if (sub === '/messages' && req.method === 'GET') {
          const q = (url.searchParams.get('q') ?? '').toLowerCase();
          // Kun from:/to:/cc:-led (adresser eller domæner) bruges som filter
          const emails = [...q.matchAll(/(?:from|to|cc):([a-z0-9._%+@-]+\.[a-z]{2,})/g)].map((x) => x[1]);
          const words = emails.length ? [] : q.split(/\s+/).filter((w) => w && !w.includes(':'));
          const hit = (m) => {
            const h = Object.values(m.headers).join(' ').toLowerCase();
            return emails.length ? emails.some((e) => h.includes(e)) : words.every((w) => h.includes(w));
          };
          return json(200, { messages: b.messages.filter(hit).map((m) => ({ id: m.id, threadId: m.threadId })) });
        }
        const mm = /^\/messages\/([^/]+)$/.exec(sub);
        if (mm) {
          const m = b.messages.find((x) => x.id === mm[1]);
          return m ? json(200, toMsg(m, url.searchParams.get('format'))) : json(404, { error: { status: 'NOT_FOUND' } });
        }
        if (sub === '/history') {
          const start = Number(url.searchParams.get('startHistoryId'));
          if (start < 50) return json(404, { error: { status: 'NOT_FOUND' } });
          const added = b.messages.filter((m) => m.historyId > start);
          return json(200, { history: added.map((m) => ({ id: String(m.historyId), messagesAdded: [{ message: { id: m.id, threadId: m.threadId } }] })), historyId: String(b.historyId) });
        }
        const tm = /^\/threads\/([^/]+)$/.exec(sub);
        if (tm) return json(200, { id: tm[1], messages: b.messages.filter((m) => m.threadId === tm[1]).map((m) => toMsg(m, 'metadata')) });
        if (sub === '/drafts' && req.method === 'POST') {
          const d = JSON.parse(body);
          const raw = Buffer.from(d.message.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
          state.drafts.push({ account, raw });
          return json(200, { id: 'draft_' + state.drafts.length });
        }
        return json(404, { error: { status: 'NOT_FOUND' } });
      }

      // --- Offentlig testhjemmeside ---
      if (p === '/') {
        return page(200, `<!doctype html><html><head><title>Forside | Bageriet Kornet</title><meta name="description" content="Håndværksbageri i Slagelse">
          <meta name="viewport" content="width=device-width"></head><body><h1>Velkommen</h1><p>Lorem ipsum dolor sit amet.</p>
          <a href="/kontakt">Kontakt</a> <a href="/findes-ikke">Gammel side</a>
          <script type="application/ld+json">{"@type":"Bakery","name":"Bageriet Kornet ApS","address":{"streetAddress":"Torvet 1","postalCode":"4200","addressLocality":"Slagelse"}}</script>
          <footer>© 2015 Bageriet Kornet · CVR 12345678</footer></body></html>`);
      }
      if (p === '/kontakt') {
        return page(200, `<!doctype html><html><head><title>Kontakt</title></head><body><p>Skriv til <a href="mailto:bageriet.kornet@gmail.com">bageriet.kornet@gmail.com</a> eller ring på tlf. 12 34 56 78.</p>
          <p>Hjemmeside lavet af <a href="mailto:hej@webbureau.dk">hej@webbureau.dk</a></p></body></html>`);
      }
      if (p === '/udstillere') {
        return page(200, `<!doctype html><html><head><title>Udstillere</title></head><body><ul>
          <li><a href="https://slagterhuset-test.dk/">Slagterhuset</a></li>
          <li><a href="https://www.mejeriet-test.dk/om">Mejeriet Vest</a></li>
          <li><a href="https://blokeret-test.dk/">Blokeret Firma</a></li>
          <li><a href="https://www.facebook.com/festival">Facebook</a></li>
          <li><a href="/program">Program</a></li></ul></body></html>`);
      }
      if (p === '/redirect-intern') return page(302, '', { Location: 'http://10.0.0.1/admin' });
      return page(404, '<!doctype html><title>Ikke fundet</title><p>404</p>');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
