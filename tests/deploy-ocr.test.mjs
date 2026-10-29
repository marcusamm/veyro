import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bygKonfiguration, laesKunder } from '../scripts/deploy-kunder.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const template = readFileSync(new URL('../lagerstyring/wrangler.toml', import.meta.url), 'utf8');
function customer(ocr, system = 'lagerstyring', chat) {
  const dir = mkdtempSync(join(tmpdir(), 'veyro-ocr-config-')); dirs.push(dir);
  writeFileSync(join(dir, 'testfirma.json'), JSON.stringify({ navn: 'TESTDATA firma', systemer: { [system]: { admins: ['test@example.invalid'], ...(ocr === undefined ? {} : { ocr_service: ocr }), ...(chat === undefined ? {} : { receipt_chat: chat }) } } }));
  return () => laesKunder(dir, 'veyro.dk')[0].systemer[0];
}
describe('OCR konfigureres særskilt pr. virksomhed', () => {
  it('opretter ingen forbindelse, når virksomheden ikke har valgt en OCR-worker', () => {
    const config = bygKonfiguration(template, customer()(), 'test-database');
    expect(config).not.toContain('RECEIPT_OCR');
    expect(config).not.toContain('BILAG_OCR_QUEUE');
    expect(config).not.toContain('new_sqlite_classes');
    expect(config).not.toContain('RECEIPT_CHAT');
  });
  it('binder kun den udtrykkeligt valgte eksisterende tjeneste', () => {
    const config = bygKonfiguration(template, customer('testfirma-kvittering-ocr')(), 'test-database');
    expect(config).toContain('binding = "RECEIPT_OCR"\nservice = "testfirma-kvittering-ocr"');
    expect(config).toContain('name = "BILAG_OCR_QUEUE"\nclass_name = "BilagOcrQueue"');
    expect(config).toContain('new_sqlite_classes = ["BilagOcrQueue"]');
    expect(config).not.toContain('RECEIPT_CHAT');
  });
  it('afviser URL, TOML-injektion og OCR på varebestillingssystemet', () => {
    for (const invalid of ['https://example.com', 'worker"\n[vars]', 42]) expect(customer(invalid)).toThrow(/ocr_service/);
    expect(customer('anden-ocr', 'varebestilling')).toThrow(/ocr_service/);
  });
  it('tilføjer kun Workers AI-bindingen efter særskilt tilvalg af bilagschat', () => {
    const config = bygKonfiguration(template, customer('testfirma-kvittering-ocr','lagerstyring',true)(), 'test-database');
    expect(config).toContain('[ai]\nbinding = "RECEIPT_CHAT"');
    const disabled = bygKonfiguration(template, customer('testfirma-kvittering-ocr','lagerstyring',false)(), 'test-database');
    expect(disabled).not.toContain('[ai]');
    expect(disabled).not.toContain('RECEIPT_CHAT');
  });
  it('afviser ugyldigt chattilvalg, manglende OCR og et andet system', () => {
    for (const invalid of ['true',1,null,{},['true']]) expect(customer('test-ocr','lagerstyring',invalid)).toThrow(/receipt_chat/);
    expect(customer(undefined,'lagerstyring',true)).toThrow(/receipt_chat/);
    expect(customer(undefined,'varebestilling',true)).toThrow(/receipt_chat/);
    expect(() => bygKonfiguration(template,{...customer()(),receiptChat:true},'test-database')).toThrow(/receipt_chat/);
  });
  it('giver kun den valgte EK-demo en chatbinding og ingen andre virksomheders installationer', () => {
    const customers = laesKunder(fileURLToPath(new URL('../kunder/',import.meta.url)),'veyro.dk');
    const opted = [];
    for (const c of customers) for (const inst of c.systemer) {
      const config = bygKonfiguration(template,inst,'test-database');
      if (config.includes('RECEIPT_CHAT')) opted.push({slug:c.slug,demo:c.demo,system:inst.system});
      else expect(config).not.toContain('[ai]');
    }
    expect(opted).toEqual([{slug:'ek-enterprise',demo:true,system:'lagerstyring'}]);
  });
});
