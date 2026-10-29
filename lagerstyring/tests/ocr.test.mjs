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

  it.each([{ pages: [] }, { pages: [42] }, { pages: [''] }, { pages: Array(11).fill('TEST') }, { pages: ['x'.repeat(100001)] }])('afviser ugyldige OCR-data uden at opfinde oplysninger: %j', async data => {
    expect((await extractReceiptText(env(data), input)).status).toBe('failed');
  });

  it('falder sikkert tilbage ved fejl, ugyldig filtype eller en langsom tjeneste', async () => {
    expect((await extractReceiptText(env({}, 503), input)).status).toBe('failed');
    const unsupported = env({ pages: ['TEST'] });
    expect((await extractReceiptText(unsupported, { ...input, mime: 'text/html' })).status).toBe('failed');
    expect(unsupported.RECEIPT_OCR.fetch).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const slow = extractReceiptText({ RECEIPT_OCR: { fetch: () => new Promise(() => {}) } }, input);
    await vi.advanceTimersByTimeAsync(15001);
    expect((await slow).status).toBe('failed');
  });
});
