import { describe, expect, it, vi } from 'vitest';
import { MAX_FILE, nextBudget, routeRequest } from '../src/gateway';

const url = 'https://receipt-ocr.internal/v1/extract';
const valid = () => new Request(url, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array([1, 2, 3]) });

describe('private OCR gateway', () => {
  it('forwards only original bytes and controlled MIME; returns suggestions without caching', async () => {
    const forward = vi.fn(async (r: Request) => {
      expect(r.url).toBe('http://container/v1/extract');
      expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3]);
      expect([...r.headers.keys()]).toEqual(['content-type']);
      return Response.json({ pages: ['TESTDATA\nVare  Antal  Pris\nSkrue  2  10,00'], provider: 'Veyro PaddleOCR', extra: 'ignored' });
    });
    const response = await routeRequest(valid(), forward);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ pages: ['TESTDATA\nVare  Antal  Pris\nSkrue  2  10,00'], provider: 'Veyro PaddleOCR' });
  });

  it('health never starts a container', async () => {
    const forward = vi.fn();
    expect((await routeRequest(new Request('https://receipt-ocr.internal/health'), forward)).status).toBe(200);
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([
    [new Request('https://public.invalid/v1/extract'), 404],
    [new Request(url + '?url=https://private.invalid/'), 404],
    [new Request(url), 405],
    [new Request(url, { method: 'POST', headers: { 'Content-Type': 'text/html' }, body: 'x' }), 415],
    [new Request(url, { method: 'POST', headers: { 'Content-Type': 'image/png' } }), 400],
    [new Request(url, { method: 'POST', headers: { 'Content-Type': 'image/png', 'Content-Length': String(MAX_FILE + 1) }, body: 'x' }), 413],
  ])('rejects malformed input before paid inference', async (request, status) => {
    const forward = vi.fn();
    expect((await routeRequest(request, forward)).status).toBe(status);
    expect(forward).not.toHaveBeenCalled();
  });

  it('enforces actual streamed length when content length is absent', async () => {
    const forward = vi.fn();
    const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(MAX_FILE + 1) });
    expect((await routeRequest(request, forward)).status).toBe(413);
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([null, { pages: [] }, { pages: [10] }, { pages: ['x'.repeat(100_001)] }, { pages: Array(11).fill('x') }])('rejects invalid OCR output', async (result) => {
    const response = await routeRequest(valid(), async () => Response.json(result));
    expect(response.status).toBe(502);
  });

  it('does not relay stack traces or document content on errors', async () => {
    const response = await routeRequest(valid(), async () => new Response('SECRET DOCUMENT AND TRACE', { status: 500 }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('SECRET');
  });

  it('propagates bounded daily-cap and busy statuses without exposing the engine', async () => {
    for (const status of [429, 503]) {
      const response = await routeRequest(valid(), async () => new Response('private', { status }));
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain('private');
    }
  });

  it('persists a daily budget across requests and resets only on a new UTC date', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(nextBudget(undefined, now)).toEqual({ day: '2026-10-29', attempts: 1 });
    expect(nextBudget({ day: '2026-10-29', attempts: 29 }, now)?.attempts).toBe(30);
    expect(nextBudget({ day: '2026-10-29', attempts: 30 }, now)).toBeNull();
    expect(nextBudget({ day: '2026-10-28', attempts: 30 }, now)?.attempts).toBe(1);
  });
});
