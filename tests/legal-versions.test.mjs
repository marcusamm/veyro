import { describe, expect, it } from 'vitest';
import { LEGAL_DOCS, LEGAL_VERSION, DPA_VERSION, isCurrent, recordAcceptance } from '../src/lib/legal';
import { agreementsCard, legalLinks } from '../src/views/legal';
import { adminCustomerPage } from '../src/views/offers';

const acceptance = (document, version) => ({ document, version, accepted_at: 1792530000, context: 'tilbud' });
const previous = {
  handelsbetingelser: acceptance('handelsbetingelser', '2026-10-21'),
  databehandleraftale: acceptance('databehandleraftale', '2026-10-21'),
};
const current = {
  handelsbetingelser: acceptance('handelsbetingelser', LEGAL_VERSION),
  databehandleraftale: acceptance('databehandleraftale', DPA_VERSION),
};
const render = async result => String(await result);

function database(accepted = {}) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...values) {
          return { sql, values, all: async () => ({ results: Object.values(accepted) }) };
        },
      };
    },
    async batch(statements) { writes.push(...statements); return []; },
  };
}

describe('legal versions and existing customer agreements', () => {
  it('versions terms and the unchanged DPA independently', () => {
    expect(LEGAL_DOCS.map(d => [d.key, d.version])).toEqual([
      ['handelsbetingelser', '2026-11-03'], ['databehandleraftale', '2026-10-21'],
    ]);
    expect(isCurrent(current)).toBe(true);
    expect(isCurrent(previous)).toBe(true);
    expect(isCurrent({ handelsbetingelser: previous.handelsbetingelser })).toBe(false);
  });

  it('preserves prior accepted terms with an archive link and no reacceptance request', async () => {
    const html = await render(agreementsCard({ csrf: 'test', accepted: previous }));
    expect(html).toContain('href="https://veyro.dk/pages/handelsbetingelser-2026-10-21"');
    expect(html.match(/badge b-ok">Accepteret/g)).toHaveLength(2);
    expect(html).not.toContain('Ny version');
    expect(html).not.toContain('action="/konto/vilkaar"');
    expect(html).toContain('Version 2026-10-21 accepteret');
  });

  it('records the displayed document versions on a new offer without rewriting any old acceptance', async () => {
    const db = database(previous);
    await recordAcceptance(db, { email: 'CUSTOMER@example.dk', customerId: 7, offerId: 12, context: 'tilbud' });
    expect(db.writes.map(row => [row.values[0], row.values[3], row.values[4], row.values[5]])).toEqual([
      ['customer@example.dk', 'handelsbetingelser', '2026-11-03', 'tilbud'],
      ['customer@example.dk', 'databehandleraftale', '2026-10-21', 'tilbud'],
    ]);
    expect(db.writes.every(row => row.sql.trim().startsWith('INSERT INTO agreement_acceptances'))).toBe(true);
    expect(await render(legalLinks())).toContain('href="https://veyro.dk/pages/handelsbetingelser"');
  });

  it('does not upgrade existing contracts through a repeated generic customer-panel submission', async () => {
    const db = database(previous);
    await recordAcceptance(db, { email: 'customer@example.dk', customerId: 7, context: 'kundepanel' });
    expect(db.writes).toHaveLength(0);
  });

  it('asks only for a missing DPA and leaves the prior terms acceptance intact', async () => {
    const partial = { handelsbetingelser: previous.handelsbetingelser };
    const html = await render(agreementsCard({ csrf: 'test', accepted: partial }));
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    expect(form).toContain('databehandleraftale');
    expect(form).not.toContain('handelsbetingelser');
    const db = database(partial);
    await recordAcceptance(db, { email: 'customer@example.dk', customerId: 7, context: 'kundepanel' });
    expect(db.writes.map(row => [row.values[3], row.values[4]])).toEqual([['databehandleraftale', '2026-10-21']]);
  });

  it('labels an unknown historical acceptance honestly and offers explicit acceptance of the current text', async () => {
    const html = await render(agreementsCard({ csrf: 'test', accepted: {
      ...previous, handelsbetingelser: acceptance('handelsbetingelser', '2025-09-10'),
    } }));
    expect(html).toContain('Version 2025-09-10 accepteret');
    expect(html).toContain('(aktuel tekst)');
    expect(html).toContain('Teksten for den accepterede version er ikke tilgængelig her');
    expect(html).not.toContain('/handelsbetingelser-2025-09-10');
    expect(html).toContain('action="/konto/vilkaar"');
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    expect(form).toContain('handelsbetingelser');
    expect(form).not.toContain('databehandleraftale');
  });

  it('allows an outdated DPA to be explicitly updated without rewriting grandfathered terms', async () => {
    const accepted = { ...previous, databehandleraftale: acceptance('databehandleraftale', '2025-09-10') };
    expect(isCurrent(accepted)).toBe(false);
    const html = await render(agreementsCard({ csrf: 'test', accepted }));
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    expect(form).toContain('databehandleraftale');
    expect(form).not.toContain('handelsbetingelser');
    expect(html).toContain('/handelsbetingelser-2026-10-21');
    const db = database(accepted);
    expect(db.writes).toHaveLength(0);
    await recordAcceptance(db, { email: 'customer@example.dk', customerId: 7, context: 'kundepanel' });
    expect(db.writes.map(row => [row.values[3], row.values[4]])).toEqual([['databehandleraftale', DPA_VERSION]]);
  });

  it('shows the applicable old contract to staff without flagging the unchanged DPA as outdated', async () => {
    const html = await render(adminCustomerPage({ csrf: 'test', customer: { id: 7, email: 'customer@example.dk' },
      subs: [], offers: [], payments: [], priceChanges: [], flash: null, error: null, accepted: previous }));
    expect(html).toContain('/handelsbetingelser-2026-10-21');
    expect(html).toContain('(eksisterende aftale)');
    expect(html).not.toContain('(ikke nyeste)');
    expect((html.match(/\(eksisterende aftale\)/g) || []).length).toBe(1);
  });
});
