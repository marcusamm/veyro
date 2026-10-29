import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ inference: vi.fn(), health: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ DurableObject: class {
  ctx: unknown; env: unknown;
  constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
} }));
import worker, { ReceiptOcrContainer } from '../src/index';

const IMAGE = 'registry.cloudflare.com/test/ocr@sha256:abc';
function instance(initial?: { day: string; attempts: number }, opts: { running?: boolean; image?: string; noImage?: boolean } = {}) {
  let budget = initial;
  const port = { fetch: vi.fn((request: Request | string, init?: RequestInit) => {
    const url = typeof request === 'string' ? request : request.url;
    return url.endsWith('/health') ? mocks.health(request, init) : mocks.inference(request, init);
  }) };
  const api = {
    running: !!opts.running, images: opts.noImage ? {} : { ocr: IMAGE },
    inspect: vi.fn(async () => opts.running ? { image: opts.image ?? IMAGE, labels: {} } : null),
    start: vi.fn(() => { api.running = true; }),
    destroy: vi.fn(async () => { api.running = false; }),
    setInactivityTimeout: vi.fn(async () => {}), getTcpPort: vi.fn(() => port),
  };
  const ctx = { container: api,
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    storage: { transaction: async (fn: (tx: unknown) => unknown) => fn({
      get: async () => budget, put: async (_key: string, value: typeof budget) => { budget = value; },
    }) },
  };
  return { subject: new ReceiptOcrContainer(ctx as never, {} as never), api, port, ctx, getBudget: () => budget };
}
const request = () => new Request('http://container/v1/extract', { method: 'POST', body: 'TESTDATA' });
beforeEach(() => {
  vi.useRealTimers(); vi.clearAllMocks();
  mocks.health.mockImplementation(async () => Response.json({ ready: true }));
  mocks.inference.mockImplementation(async () => Response.json({ pages: ['TESTDATA'], provider: 'Veyro PaddleOCR' }));
});

describe('native paid container lifecycle', () => {
  it('starts the named image offline with explicit resources and two-minute idle timeout', async () => {
    const { subject, api, port, getBudget } = instance();
    expect((await subject.fetch(request())).status).toBe(200);
    expect(api.start).toHaveBeenCalledWith({ image: IMAGE, instance: 'standard-2', enableInternet: false, env: { OCR_CPU_THREADS: '1' } });
    expect(api.setInactivityTimeout).toHaveBeenCalledWith(120_000);
    expect(api.getTcpPort).toHaveBeenCalledWith(8080);
    expect(port.fetch.mock.calls[0]?.[0]).toBe('http://container/health');
    expect(getBudget()?.attempts).toBe(1);
  });
  it('restores idle timeout after DO restart without restarting a matching container', async () => {
    const { subject, api, ctx } = instance(undefined, { running: true });
    expect(ctx.blockConcurrencyWhile).toHaveBeenCalledOnce();
    expect(api.setInactivityTimeout).toHaveBeenCalledWith(120_000);
    expect((await subject.fetch(request())).status).toBe(200);
    expect(api.start).not.toHaveBeenCalled(); expect(api.destroy).not.toHaveBeenCalled();
  });
  it('replaces a known old image, while an unknown startup image is not destroyed', async () => {
    const old = instance(undefined, { running: true, image: 'registry.cloudflare.com/test/ocr@sha256:old' });
    expect((await old.subject.fetch(request())).status).toBe(200);
    expect(old.api.destroy).toHaveBeenCalledOnce(); expect(old.api.start).toHaveBeenCalledOnce();
    const starting = instance(undefined, { running: true, image: '' });
    expect((await starting.subject.fetch(request())).status).toBe(200);
    expect(starting.api.destroy).not.toHaveBeenCalled(); expect(starting.api.start).not.toHaveBeenCalled();
  });
  it('holds the concurrency gate until the response body has arrived', async () => {
    let output: ReadableStreamDefaultController<Uint8Array>;
    mocks.inference.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(c) { output = c; } })));
    const { subject } = instance(); const pending = subject.fetch(request());
    await vi.waitFor(() => expect(mocks.inference).toHaveBeenCalledOnce());
    expect((await subject.fetch(request())).status).toBe(503);
    output!.enqueue(new TextEncoder().encode('{"pages":["TESTDATA"]}')); output!.close();
    expect((await pending).status).toBe(200);
    mocks.inference.mockResolvedValue(Response.json({ pages: ['Next'] }));
    expect((await subject.fetch(request())).status).toBe(200);
  });
  it('destroys and times out even after HTTP response headers arrived', async () => {
    vi.useFakeTimers(); let output: ReadableStreamDefaultController<Uint8Array>;
    mocks.inference.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(c) { output = c; } })));
    const { subject, api } = instance();
    api.destroy.mockImplementation(async () => { api.running = false; output!.error(new Error('container stopped')); });
    const pending = subject.fetch(request()); await vi.advanceTimersByTimeAsync(110_000);
    expect((await pending).status).toBe(504); expect(api.destroy).toHaveBeenCalledOnce();
  });
  it('destroys on deadline even if transport translates abort into HTTP500', async () => {
    vi.useFakeTimers();
    mocks.inference.mockImplementation(async (req: Request) => new Promise<Response>((resolve) => {
      req.signal.addEventListener('abort', () => resolve(new Response('private exception', { status: 500 })));
    }));
    const { subject, api } = instance(); const pending = subject.fetch(request());
    await vi.advanceTimersByTimeAsync(110_000);
    expect((await pending).status).toBe(504); expect(api.destroy).toHaveBeenCalledOnce();
  });
  it('requires healthy HTTP success, not merely an open port', async () => {
    vi.useFakeTimers();
    mocks.health.mockResolvedValueOnce(new Response('starting', { status: 503 })).mockResolvedValueOnce(Response.json({ ready: true }));
    const { subject } = instance(); const pending = subject.fetch(request());
    await vi.advanceTimersByTimeAsync(200);
    expect((await pending).status).toBe(200);
    expect(mocks.health).toHaveBeenCalledTimes(2); expect(mocks.inference).toHaveBeenCalledOnce();
  });
  it('destroys failed boots at the separate thirty-second readiness deadline', async () => {
    vi.useFakeTimers(); mocks.health.mockImplementation(async () => new Promise<Response>(() => {}));
    const { subject, api } = instance(); const pending = subject.fetch(request());
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).status).toBe(503);
    expect(api.destroy).toHaveBeenCalledOnce(); expect(mocks.inference).not.toHaveBeenCalled();
  });
  it('never starts paid compute after the persisted daily allowance is exhausted', async () => {
    const { subject, api } = instance({ day: new Date().toISOString().slice(0, 10), attempts: 30 });
    expect((await subject.fetch(request())).status).toBe(429);
    expect(api.start).not.toHaveBeenCalled(); expect(api.getTcpPort).not.toHaveBeenCalled(); expect(api.inspect).not.toHaveBeenCalled();
  });
  it('fails closed when the deployment has no named image', async () => {
    const { subject, api } = instance(undefined, { noImage: true });
    expect((await subject.fetch(request())).status).toBe(503); expect(api.start).not.toHaveBeenCalled();
  });
  it('rejects response streams above the JSON limit', async () => {
    mocks.inference.mockResolvedValue(new Response(new Uint8Array(500_001)));
    expect((await instance().subject.fetch(request())).status).toBe(503);
  });
  it('routes every request through the same EU namespace ID', async () => {
    const fetch = vi.fn(async () => Response.json({ pages: ['TESTDATA'] }));
    const getByName = vi.fn(() => ({ fetch })); const jurisdiction = vi.fn(() => ({ getByName }));
    const response = await worker.fetch(new Request('https://receipt-ocr.internal/v1/extract', {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'TESTDATA',
    }), { OCR_CONTAINER: { jurisdiction } } as never);
    expect(response.status).toBe(200); expect(jurisdiction).toHaveBeenCalledWith('eu');
    expect(getByName).toHaveBeenCalledWith('receipt-ocr-v1');
  });
});
