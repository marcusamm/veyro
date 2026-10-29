import { Container } from '@cloudflare/containers';
import { failure, limitedBytes, nextBudget, routeRequest, type Budget } from './gateway';

type Env = { OCR_CONTAINER: DurableObjectNamespace<ReceiptOcrContainer> };

export class ReceiptOcrContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = '2m';
  override enableInternet = false;
  override envVars = { OCR_CPU_THREADS: '1' };
  private processing = false;

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/extract') return failure(404, 'not_found');
    if (this.processing) return failure(503, 'busy');
    this.processing = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopping: Promise<unknown> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        // The Container library may convert an aborted fetch to HTTP 500. Kill
        // here regardless, rather than relying on that fetch throwing an error.
        stopping = this.stop('SIGKILL').catch(() => {});
        reject(new Error('deadline'));
      }, 110_000);
    });
    try {
      return await Promise.race([this.infer(request, controller.signal), deadline]);
    } catch {
      return failure(controller.signal.aborted ? 504 : 503,
        controller.signal.aborted ? 'ocr_timeout' : 'container_unavailable');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await stopping;
      this.processing = false;
    }
  }

  private async infer(request: Request, signal: AbortSignal): Promise<Response> {
      // One shared container, no document/result storage. Persist only a non-identifying
      // daily attempt counter so restarts cannot defeat the initial spending guard.
      const allowed = await this.ctx.storage.transaction(async (tx) => {
        const budget = nextBudget(await tx.get<Budget>('budget'), Date.now());
        if (!budget) return false;
        await tx.put('budget', budget);
        return true;
      });
      if (!allowed) return failure(429, 'daily_limit');
      await this.startAndWaitForPorts({
        ports: 8080,
        startOptions: { enableInternet: false },
        cancellationOptions: { abort: signal, instanceGetTimeoutMS: 10_000, portReadyTimeoutMS: 30_000 },
      });
      const response = await this.containerFetch(new Request(request, { signal }));
      if (signal.aborted) throw new Error('deadline');
      // Keep the deadline and busy gate until the actual inference result has
      // arrived; containerFetch returns as soon as the headers are available.
      const bytes = await limitedBytes(response.body, 500_000);
      if (signal.aborted) throw new Error('deadline');
      return new Response(bytes.slice().buffer, {
        status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return routeRequest(request, (validated) =>
      env.OCR_CONTAINER.jurisdiction('eu').getByName('receipt-ocr-v1').fetch(validated));
  },
} satisfies ExportedHandler<Env>;
