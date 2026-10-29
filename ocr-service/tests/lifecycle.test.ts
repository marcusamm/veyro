import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ start: vi.fn(), fetch: vi.fn(), stop: vi.fn() }));
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    ctx: unknown;
    constructor(ctx: unknown) { this.ctx = ctx; }
    startAndWaitForPorts(...args: unknown[]) { return mocks.start(...args); }
    containerFetch(...args: unknown[]) { return mocks.fetch(...args); }
    stop(...args: unknown[]) { return mocks.stop(...args); }
  },
}));
import { ReceiptOcrContainer } from '../src/index';

function instance(initial?: { day: string; attempts: number }) {
  let budget = initial;
  const ctx = { storage: { transaction: async (fn: (tx: unknown) => unknown) => fn({
    get: async () => budget,
    put: async (_key: string, value: typeof budget) => { budget = value; },
  }) } };
  return new ReceiptOcrContainer(ctx as never, {} as never);
}
const request = () => new Request('http://container/v1/extract', { method: 'POST', body: 'TESTDATA' });

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.start.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue(Response.json({ pages: ['TESTDATA'], provider: 'Veyro PaddleOCR' }));
});

describe('paid container lifecycle', () => {
  it('holds the concurrency gate until the response body has arrived', async () => {
    let output: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { output = c; } });
    mocks.fetch.mockResolvedValue(new Response(stream));
    const container = instance();
    const pending = container.fetch(request());
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    expect((await container.fetch(request())).status).toBe(503);
    output!.enqueue(new TextEncoder().encode('{"pages":["TESTDATA"]}'));
    output!.close();
    expect((await pending).status).toBe(200);
    mocks.fetch.mockResolvedValue(Response.json({ pages: ['Next'] }));
    expect((await container.fetch(request())).status).toBe(200);
  });

  it('kills and times out even after HTTP response headers arrived', async () => {
    vi.useFakeTimers();
    let output: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { output = c; } });
    mocks.fetch.mockResolvedValue(new Response(stream));
    mocks.stop.mockImplementation(async () => output!.error(new Error('container stopped')));
    const pending = instance().fetch(request());
    await vi.advanceTimersByTimeAsync(110_000);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(mocks.stop).toHaveBeenCalledWith('SIGKILL');
  });

  it('kills on deadline when the container library translates an abort into HTTP500', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(async (req: Request) => new Promise<Response>((resolve) => {
      req.signal.addEventListener('abort', () => resolve(new Response('private exception', { status: 500 })));
    }));
    const pending = instance().fetch(request());
    await vi.advanceTimersByTimeAsync(110_000);
    expect((await pending).status).toBe(504);
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it('never starts paid compute after the persisted daily allowance is exhausted', async () => {
    const container = instance({ day: new Date().toISOString().slice(0, 10), attempts: 30 });
    expect((await container.fetch(request())).status).toBe(429);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects a response stream larger than the bounded JSON allowance', async () => {
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array(500_001)));
    expect((await instance().fetch(request())).status).toBe(503);
  });
});
