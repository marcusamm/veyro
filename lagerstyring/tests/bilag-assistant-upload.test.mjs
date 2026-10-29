import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bilagAssistantRoutes } from '../src/routes/bilagassistant.ts';
import { fileBytes, getFile, FILE_MAX_BYTES } from '../src/lib/files.ts';
import { getBilag } from '../src/lib/bilag.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';

const csrf = 'TESTDATA-upload-csrf', op = 'TESTDATA-upload-operation-001';
const actor = { email: 'test-owner@example.invalid', name: 'TESTDATA ejer', role: 'ejer' };
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const open = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of open.splice(0)) db.close(); });

function database() {
  const sqlite = new DatabaseSync(':memory:'); open.push(sqlite); sqlite.exec('PRAGMA foreign_keys=ON');
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const file of readdirSync(folder).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(`${folder}/${file}`, 'utf8'));
  function prepared(sql, params = []) {
    const args = () => params.map(x => x instanceof ArrayBuffer ? Buffer.from(x) : x === undefined ? null : x);
    const execute = () => ({ results: sqlite.prepare(sql).all(...args()), success: true });
    return {
      bind: (...p) => prepared(sql, p),
      first: async column => { const row = sqlite.prepare(sql).get(...args()) ?? null; return column && row ? row[column] : row; },
      all: async () => execute(),
      run: async () => { const result = sqlite.prepare(sql).run(...args()); return { meta: { changes: Number(result.changes) }, success: true }; },
      execute,
    };
  }
  return { sqlite, prepare: sql => prepared(sql), async batch(statements) {
    // Execute each complete D1 batch synchronously in one real SQLite transaction.
    sqlite.exec('BEGIN');
    try { const result = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}

function setup({ user = actor, portal = 'lager', chat = true, db = database() } = {}) {
  const app = new Hono(), ai = vi.fn(), ocr = vi.fn(), queue = vi.fn();
  app.use('*', async (c, next) => {
    c.set('csrf', csrf); c.set('session', user ? { user, csrf } : null);
    c.set('settings', { ...DEFAULT_SETTINGS, company_name: 'TESTDATA firma' });
    await next();
  });
  app.route(`/${portal}/bilag/chat`, bilagAssistantRoutes(portal));
  const env = { DB: db, ...(chat ? { RECEIPT_CHAT: { run: ai } } : {}), RECEIPT_OCR: { fetch: ocr }, BILAG_OCR_QUEUE: { getByName: queue } };
  return { app, db, ai, ocr, queue, portal, env,
    request(path = '', init = {}) { return app.request(`https://test.invalid/${portal}/bilag/chat${path}`, init, env); },
    upload(options = {}) {
      const form = new FormData();
      if (options.csrf !== null) form.set('_csrf', options.csrf ?? csrf);
      if (options.op !== null) form.set('op', options.op ?? op);
      if (options.bytes !== null) form.append('file', new File([options.bytes ?? png], options.name ?? 'TESTDATA.png', { type: options.mime ?? 'image/png' }));
      if (options.second) form.append('file', new File([png], 'TESTDATA-anden.png'));
      return this.request('/upload', { method: 'POST', body: form, headers: { ...(options.json === false ? {} : { Accept: 'application/json' }), ...(options.origin ? { Origin: options.origin } : {}) } });
    },
  };
}

const count = (db, table) => db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
function untouched(db) {
  for (const table of ['movements', 'purchase_lines', 'bilag_allocations', 'bilag_lines', 'bilag_ocr_jobs', 'bilag_ocr_evidence', 'bilag_chat_usage']) expect(count(db, table)).toBe(0);
}

describe('Upload direkte i bilagschatten', () => {
  it('opretter et privat uafklaret udkast uden OCR, modelkald, kø, varelinjer eller lagerregistrering', async () => {
    const x = setup();
    const res = await x.upload({ name: '../../TESTDATA <script>.pdf', mime: 'application/zip' });
    expect(res.status).toBe(201);
    const result = await res.json();
    expect(result).toMatchObject({ id: 1, url: '/lager/bilag/1', fileName: 'TESTDATA script.pdf', version: 1, file_id: 1, mime: 'image/png' });
    expect(result.op).toMatch(/^[A-Za-z0-9_-]{16,64}$/); expect(result.op).not.toBe(op);
    const b = await getBilag(x.db, result.id);
    expect(b).toMatchObject({ doc_type: 'kvittering', payment: 'uafklaret', status: 'modtaget', origin: 'chat', uploaded_by: actor.email, version: 1, approved_by: null, net: null, vat: null, total: null, reading_token: '', reading_source: '' });
    const original = await getFile(x.db, result.file_id);
    expect(await fileBytes(x.db, original)).toEqual(png);
    expect(count(x.db, 'bilag_events')).toBe(1);
    untouched(x.db); expect(x.ai).not.toHaveBeenCalled(); expect(x.ocr).not.toHaveBeenCalled(); expect(x.queue).not.toHaveBeenCalled();
  });

  it('gensendt upload med samme op og bytes returnerer samme udkast og oprindelige filnavn', async () => {
    const x = setup(), first = await (await x.upload()).json();
    const repeated = await x.upload({ name: 'TESTDATA omdøbt.jpg', mime: 'text/plain' });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ id: first.id, file_id: first.file_id, fileName: first.fileName });
    expect(count(x.db, 'bilag')).toBe(1); expect(count(x.db, 'bilag_chat_uploads')).toBe(1); expect(count(x.db, 'bilag_events')).toBe(1);
    untouched(x.db);
  });

  it('samme engangsnøgle i samtidige requests kan atomisk kun oprette ét udkast', async () => {
    const x = setup();
    const responses = await Promise.all(Array.from({ length: 8 }, () => x.upload()));
    expect(responses.every(r => [200, 201].includes(r.status))).toBe(true);
    const results = await Promise.all(responses.map(r => r.json()));
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    expect(count(x.db, 'bilag')).toBe(1); expect(count(x.db, 'bilag_chat_uploads')).toBe(1); expect(count(x.db, 'files')).toBe(1);
    expect(count(x.db, 'bilag_events')).toBe(1); untouched(x.db);
  });

  it('samme op med forskellige bytes afvises og kan heller ikke vinde i et kapløb', async () => {
    const x = setup(), other = new Uint8Array([...png, 42]);
    const responses = await Promise.all([x.upload(), x.upload({ bytes: other })]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    const claim = x.db.sqlite.prepare('SELECT * FROM bilag_chat_uploads').get();
    const b = await getBilag(x.db, claim.bilag_id);
    expect(b.file_id).toBe(claim.file_id); expect(count(x.db, 'bilag')).toBe(1); untouched(x.db);
  });

  it('fejl ved claim-tilknytning ruller både udkast og claim tilbage, og samme upload kan prøves igen', async () => {
    const x = setup(), prepare = x.db.prepare;
    let fail = true;
    x.db.prepare = sql => {
      if (fail && sql.startsWith('UPDATE bilag_chat_uploads SET bilag_id=')) {
        fail = false;
        const stmt = prepare(sql), bind = stmt.bind;
        stmt.bind = (...params) => ({ ...bind(...params), execute: () => { throw new Error('TESTDATA afbrudt batch'); } }); return stmt;
      }
      return prepare(sql);
    };
    expect((await x.upload()).status).toBe(503);
    expect(count(x.db, 'bilag')).toBe(0); expect(count(x.db, 'bilag_chat_uploads')).toBe(0);
    expect((await x.upload()).status).toBe(201);
    expect(count(x.db, 'bilag')).toBe(1); untouched(x.db);
  });

  it('en mistet efterfølgende eventskrivning opretter ikke endnu et udkast ved genforsøg', async () => {
    const x = setup(), prepare = x.db.prepare;
    let fail = true;
    x.db.prepare = sql => {
      const stmt = prepare(sql);
      if (fail && sql.startsWith('INSERT INTO bilag_events')) {
        fail = false;
        const bind = stmt.bind; stmt.bind = (...params) => ({ ...bind(...params), run: async () => { throw new Error('TESTDATA event udfald'); } });
      }
      return stmt;
    };
    const first = await x.upload(); expect(first.status).toBe(200);
    const firstId = (await first.json()).id;
    expect((await (await x.upload()).json()).id).toBe(firstId);
    expect(count(x.db, 'bilag')).toBe(1); expect(count(x.db, 'bilag_chat_uploads')).toBe(1);
  });

  it('slettet udkast genoprettes aldrig under den samme uploadnøgle', async () => {
    const x = setup(), result = await (await x.upload()).json();
    x.db.sqlite.prepare('DELETE FROM bilag WHERE id=?').run(result.id);
    expect((await x.upload()).status).toBe(409);
    expect(count(x.db, 'bilag')).toBe(0);
  });

  it('uden JavaScript redirectes til det oprettede bilags eksisterende detaljeside', async () => {
    const x = setup(), res = await x.upload({ json: false });
    expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('/lager/bilag/1');
  });

  it.each([
    ['falsk PNG-navn med tekst', new TextEncoder().encode('TESTDATA ingen billedfil'), 'faktisk.png', 'image/png'],
    ['ZIP forklædt som PDF', Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0, 0), 'TESTDATA.pdf', 'application/pdf'],
  ])('afviser %s ud fra indholdet', async (_label, bytes, name, mime) => {
    const x = setup(); expect((await x.upload({ bytes, name, mime })).status).toBe(400);
    expect(count(x.db, 'files')).toBe(0); expect(count(x.db, 'bilag')).toBe(0);
  });

  it('afviser fil over 15 MB og manglende/tom/multiple filer eller ugyldig op uden databaseændring', async () => {
    const x = setup(), huge = new Uint8Array(FILE_MAX_BYTES + 1); huge.set(png);
    expect((await x.upload({ bytes: huge })).status).toBe(413);
    for (const options of [{ bytes: null }, { bytes: new Uint8Array() }, { second: true }, { op: null }, { op: 'short' }]) expect((await x.upload(options)).status).toBe(400);
    expect(count(x.db, 'bilag')).toBe(0); expect(count(x.db, 'files')).toBe(0);
  });

  it('bruger samme dataskillelinje pr. virksomhed og pr. bruger selv med identisk op', async () => {
    const db = database(), owner = setup({ db }), staff = setup({ db, portal: 'job', user: { ...actor, email: 'staff@example.invalid', role: 'medarbejder' } }), otherCompany = setup();
    const a = await (await owner.upload()).json(), b = await (await staff.upload()).json(), other = await (await otherCompany.upload()).json();
    expect(b.id).not.toBe(a.id); expect(count(db, 'bilag_chat_uploads')).toBe(2); expect(count(otherCompany.db, 'bilag_chat_uploads')).toBe(1);
    expect((await getBilag(db, b.id)).uploaded_by).toBe('staff@example.invalid'); expect(other.id).toBe(1);
  });

  it('kræver login, sessionens CSRF/origin og lagerrollens adgang, også når ruten monteres alene', async () => {
    const anonymous = setup({ user: null }); expect((await anonymous.upload()).status).toBe(303); expect(count(anonymous.db, 'bilag')).toBe(0);
    const staff = setup({ user: { ...actor, role: 'medarbejder' } }); expect((await staff.upload()).status).toBe(303); expect(count(staff.db, 'bilag')).toBe(0);
    const x = setup();
    for (const options of [{ csrf: null }, { csrf: 'forkert' }, { origin: 'https://evil.invalid' }]) expect((await x.upload(options)).status).toBe(403);
    expect(count(x.db, 'bilag')).toBe(0);
    const disabled = setup({ chat: false }); expect((await disabled.upload()).status).toBe(503); expect(count(disabled.db, 'bilag')).toBe(0);
  });

  it('GET viser chatten med ny engangsnøgle uden at oprette et bilag eller starte OCR', async () => {
    const x = setup(), response = await x.request(), html = await response.text();
    expect(response.status).toBe(200); expect(html).toContain('data-bilag-assistant');
    expect(html).toContain('/lager/bilag/chat/upload'); expect(html).toContain(`name="_csrf" value="${csrf}"`);
    expect(count(x.db, 'bilag')).toBe(0); expect(x.ocr).not.toHaveBeenCalled();
  });
});
