import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bygKonfiguration, laesKunder } from '../scripts/deploy-kunder.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const template = readFileSync(new URL('../lagerstyring/wrangler.toml', import.meta.url), 'utf8');
function customer(ocr, system = 'lagerstyring') {
  const dir = mkdtempSync(join(tmpdir(), 'veyro-ocr-config-')); dirs.push(dir);
  writeFileSync(join(dir, 'testfirma.json'), JSON.stringify({ navn: 'TESTDATA firma', systemer: { [system]: { admins: ['test@example.invalid'], ...(ocr === undefined ? {} : { ocr_service: ocr }) } } }));
  return () => laesKunder(dir, 'veyro.dk')[0].systemer[0];
}
describe('OCR konfigureres særskilt pr. virksomhed', () => {
  it('opretter ingen forbindelse, når virksomheden ikke har valgt en OCR-worker', () => {
    const config = bygKonfiguration(template, customer()(), 'test-database');
    expect(config).not.toContain('RECEIPT_OCR');
  });
  it('binder kun den udtrykkeligt valgte eksisterende tjeneste', () => {
    const config = bygKonfiguration(template, customer('testfirma-kvittering-ocr')(), 'test-database');
    expect(config).toContain('binding = "RECEIPT_OCR"\nservice = "testfirma-kvittering-ocr"');
  });
  it('afviser URL, TOML-injektion og OCR på varebestillingssystemet', () => {
    for (const invalid of ['https://example.com', 'worker"\n[vars]', 42]) expect(customer(invalid)).toThrow(/ocr_service/);
    expect(customer('anden-ocr', 'varebestilling')).toThrow(/ocr_service/);
  });
});
