import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { csrfMiddleware } from '../src/lib/session.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';
import { bilagRoutes } from '../src/routes/bilag.ts';
import { detailPage } from '../src/views/bilag.ts';

const unavailable = 'OCR er ikke tilsluttet. Kontrollér og registrér oplysningerne manuelt ud fra originalen.';
const historical = 'Bilaget blev uploadet før OCR blev tilsluttet.';
const actor = { email: 'test-ejer@example.invalid', name: 'TESTDATA ejer', role: 'ejer' };
const csrf = 'TESTDATA-csrf-token';

function fixture() {
  return {
    base: '/lager/bilag', csrf, op: 'TESTDATA-op',
    b: {
      id: 7, doc_type: 'kvittering', file_id: 1, file_name: 'TESTDATA.png', preview_file_id: null,
      status: 'modtaget', version: 1, supplier_name: '', supplier_cvr: '', supplier_id: null,
      doc_number: '', doc_date: '', due_date: '', currency: 'DKK', net: null, vat: null, total: null,
      rounding: 0, line_prices: 'ekskl', payment_info: '', uncertain: '[]', reading_source: '',
      ocr_provider: '', reading_token: '', data_revision: 0, reading_note: unavailable,
      payment: 'virksomhed', paid_by: '', reimbursed_at: null, reimbursed_by: null, job_hint: null,
      origin: 'test', credit_of: null, note: 'TESTDATA', clarify: '', dup_of: null, dup_reason: '',
      dup_cleared_by: null, approved_by: null, approved_at: null, approved_version: null,
      exported_version: null, exported_at: null, export_id: null, export_failed: 0,
      uploaded_by: actor.email, uploaded_name: actor.name, created_at: 1793291340, updated_at: 1793291340,
      uploader: actor.name, payer: null, approver: null,
    },
    file: { mime: 'image/png', pages: null, size: 100 },
    lines: [], allocs: [], events: [{ id: 1, bilag_id: 7, version: 1, kind: 'aflaest', text: unavailable,
      actor: actor.email, actor_name: actor.name, created_at: 1793291340 }],
    checks: { errors: ['Totalen mangler.'], warnings: [], linesSum: null, allocated: 0, base: null },
    canEdit: true, canDelete: false, manager: true, jobs: [], products: [], users: [], suggestions: [],
    dupOf: null, vatRegistered: true, errs: [], ocr: null, ocrConfigured: true,
  };
}

// The real detail route with a read-only D1 fixture. Any attempted SQL write
// fails, including UPDATE ... RETURNING through first(), as well as run/batch.
function routeFixture(d, bindings = {}) {
  const queries = [], run = vi.fn(() => { throw new Error('GET must not write'); });
  const DB = {
    prepare(sql) {
      queries.push(sql);
      expect(sql.trim()).toMatch(/^SELECT\b/);
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('FROM bilag_ocr_jobs')) return d.ocr;
          if (/FROM bilag(?: b)? (?:WHERE|LEFT JOIN)/.test(sql)) return d.b;
          if (sql.includes('FROM files WHERE')) return { id: 1, ...d.file };
          if (sql.includes('COUNT(*)')) return { n: 0 };
          throw new Error(`Unexpected first query: ${sql}`);
        },
        async all() {
          if (sql.includes('FROM bilag_events')) return { results: d.events };
          if (sql.includes('FROM bilag_allocations')) return { results: d.allocs };
          return { results: [] };
        },
        run,
      };
    },
    batch: run,
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('settings', { ...DEFAULT_SETTINGS, company_name: 'TESTDATA firma' });
    c.set('session', { user: actor, csrf }); c.set('csrf', csrf);
    await next();
  });
  app.use('*', csrfMiddleware);
  app.route('/lager/bilag', bilagRoutes('lager'));
  const waitUntil = vi.fn();
  return { queries, run, waitUntil, request: (method = 'GET', body) => app.request(
    'https://test.invalid/lager/bilag/7', { method, ...(body ? { body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {}) },
    { DB, APP_URL: 'https://test.invalid', ...bindings }, { waitUntil },
  ) };
}

describe('Gamle bilag fra før OCR blev tilsluttet', () => {
  it('forklarer den gamle aflæsning, bevarer historikken og tilbyder et bevidst CSRF-beskyttet genforsøg', async () => {
    const d = fixture(), before = structuredClone(d);
    const html = String(await detailPage(d));
    const [current, history] = html.split('<h2>Historik</h2>');
    expect(current).toContain(historical); expect(current).not.toContain(unavailable);
    expect(history).toContain(unavailable); expect(d).toEqual(before);
    const form = current.match(/<form[^>]+method="post"[^>]*>[\s\S]*?Start ny aflæsning<\/button><\/form>/)?.[0];
    expect(form).toContain('action="/lager/bilag/7"');
    expect(form).toContain(`name="_csrf" value="${csrf}"`);
    expect(form).toContain('name="do" value="laes"');
    expect(form).toContain('btn-primary');
    expect(current).toContain('>Aflæs igen</button>');
    expect(current).not.toMatch(/OCR (?:virker|er klar)/);
  });

  it.each([
    ['uden redigeringsret', d => { d.canEdit = false; }],
    ['med fordeling', d => { d.allocs = [{ id: 1, target: 'drift', action: 'udgift', amount: 1000, done_at: null }]; }],
    ['med registreret varemodtagelse', d => { d.allocs = [{ id: 1, target: 'lager', action: 'ny_modtagelse', amount: 1000, done_at: 1793291400 }]; }],
    ['godkendt', d => { d.b.status = 'godkendt'; }],
    ['arkiveret', d => { d.b.status = 'arkiveret'; }],
    ['med aktiv aflæsningstoken', d => { d.b.reading_token = 'TESTDATA-token'; }],
    ['med køjob', d => { d.ocr = { state: 'queued' }; }],
    ['med igangværende OCR', d => { d.ocr = { state: 'processing' }; }],
  ])('tilbyder ikke den nye genaflæsningsknap %s', async (_label, change) => {
    const d = fixture(); change(d);
    expect(String(await detailPage(d))).not.toContain('>Start ny aflæsning</button>');
  });

  it('bevarer aktuelle fejlbeskeder fra en tilsluttet tjeneste', async () => {
    const d = fixture(); d.b.reading_note = 'OCR-tjenestens daglige grænse er nået.';
    const html = String(await detailPage(d));
    expect(html).toContain(d.b.reading_note); expect(html).not.toContain(historical);
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    'GET bruger begge faktiske bindings (%s / %s) uden at sende OCR eller ændre det gemte bilag',
    async (service, queue) => {
      const d = fixture(), before = structuredClone(d);
      const fetch = vi.fn(), getByName = vi.fn();
      const route = routeFixture(d, { ...(service ? { RECEIPT_OCR: { fetch } } : {}), ...(queue ? { BILAG_OCR_QUEUE: { getByName } } : {}) });
      const response = await route.request(), html = await response.text();
      expect(response.status).toBe(200);
      const [current, history] = html.split('<h2>Historik</h2>');
      expect(history).toContain(unavailable);
      if (service && queue) {
        expect(current).toContain(historical); expect(current).not.toContain(unavailable);
        expect(current).toContain('>Start ny aflæsning</button>');
      } else {
        expect(current).toContain(unavailable); expect(current).not.toContain(historical);
        expect(current).not.toContain('>Start ny aflæsning</button>');
      }
      expect(d).toEqual(before);
      expect(fetch).not.toHaveBeenCalled(); expect(getByName).not.toHaveBeenCalled();
      expect(route.run).not.toHaveBeenCalled(); expect(route.waitUntil).not.toHaveBeenCalled();
    },
  );

  it('afviser den samme laes-POST uden gyldig CSRF, før nogen database- eller OCR-handling', async () => {
    const route = routeFixture(fixture(), { RECEIPT_OCR: { fetch: vi.fn() }, BILAG_OCR_QUEUE: { getByName: vi.fn() } });
    const response = await route.request('POST', new URLSearchParams({ do: 'laes', _csrf: 'wrong' }));
    expect(response.status).toBe(403); expect(route.queries).toHaveLength(0); expect(route.run).not.toHaveBeenCalled();
  });
});
