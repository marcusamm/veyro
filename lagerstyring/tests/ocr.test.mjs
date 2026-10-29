import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractReceiptText } from '../src/lib/ocr.ts';

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const input = { bytes, mime: 'image/png' };
const env = (data, status = 200) => ({ RECEIPT_OCR: { fetch: vi.fn(async () => Response.json(data, { status })) } });
afterEach(() => vi.useRealTimers());

describe('Særskilt OCR-integration uden automatisk lager- eller omkostningsbogføring', () => {
  it('viser ærligt at tjenesten ikke er tilsluttet', async () => {
    expect(await extractReceiptText({}, input)).toMatchObject({ status: 'unavailable' });
  });

  it('sender uændrede originalbytes til den faste servicebinding og bevarer tekstens kolonner', async () => {
    const binding = env({ pages: ['TESTDATA\nBeskrivelse  Antal  Beløb\nTræskrue  2  20,00'], provider: 'TEST OCR' });
    const result = await extractReceiptText(binding, input);
    expect(result).toMatchObject({ status: 'ok', provider: 'TEST OCR', pages: ['TESTDATA\nBeskrivelse  Antal  Beløb\nTræskrue  2  20,00'] });
    const request = binding.RECEIPT_OCR.fetch.mock.calls[0][0];
    expect(request.url).toBe('https://receipt-ocr.internal/v1/extract');
    expect(request.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
    expect(input.bytes).toEqual(bytes);
    expect(Object.keys(binding)).toEqual(['RECEIPT_OCR']);
  });

  it.each([
    ['ingen sider', { pages: [] }], ['forkert teksttype', { pages: [42] }], ['tom tekst', { pages: [''] }],
    ['for mange sider', { pages: Array(11).fill('TEST') }], ['for megen tekst', { pages: ['x'.repeat(100001)] }],
  ])('afviser %s uden at opfinde oplysninger', async (_label, data) => {
    expect(await extractReceiptText(env(data), input)).toMatchObject({ status: 'failed', retryable: false });
  });

  it('falder sikkert tilbage ved fejl, ugyldig filtype eller en langsom tjeneste', async () => {
    expect((await extractReceiptText(env({}, 503), input)).status).toBe('failed');
    const unsupported = env({ pages: ['TEST'] });
    expect((await extractReceiptText(unsupported, { ...input, mime: 'text/html' })).status).toBe('failed');
    expect(unsupported.RECEIPT_OCR.fetch).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const slow = extractReceiptText({ RECEIPT_OCR: { fetch: () => new Promise(() => {}) } }, input);
    await vi.advanceTimersByTimeAsync(120001);
    expect(await slow).toMatchObject({ status: 'failed', retryable: true });
  });

  it('giver CPU-containeren tid til koldstart uden at miste den samlede frist', async () => {
    vi.useFakeTimers();
    const cpu = extractReceiptText({ RECEIPT_OCR: { fetch: () => new Promise(resolve => setTimeout(() => resolve(Response.json({pages:['TESTDATA CPU'],provider:'TEST CPU'})), 30000)) } }, input);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await cpu).toMatchObject({status:'ok',pages:['TESTDATA CPU']});
  });

  it('genprøver kun midlertidige fejl, aldrig den daglige grænse eller ugyldige svar', async () => {
    expect(await extractReceiptText(env({},429),input)).toMatchObject({status:'failed',retryable:false});
    expect(await extractReceiptText(env({},503),input)).toMatchObject({status:'failed',retryable:true});
    expect(await extractReceiptText({RECEIPT_OCR:{fetch:async()=>new Response('{bad json')}},input)).toMatchObject({status:'failed',retryable:false});
  });
});
