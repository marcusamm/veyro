import { DurableObject } from 'cloudflare:workers';
import { failure, limitedBytes, nextBudget, routeRequest, type Budget } from './gateway';

type Env = { OCR_CONTAINER: DurableObjectNamespace<ReceiptOcrContainer> };

const IDLE_MS = 120_000;
const READY_MS = 30_000;

export class ReceiptOcrContainer extends DurableObject<Env> {
  private processing = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The native idle timeout belongs to a DO activation, not its persisted
    // storage. Restore it after a code update while its container still runs.
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(IDLE_MS));
    }
  }

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
        // Stop even if a stalled transport ignores AbortSignal, or has already
        // returned response headers while its body remains incomplete.
        stopping = this.ctx.container?.destroy().catch(() => {});
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
      if (signal.aborted) throw new Error('deadline');
      const container = this.ctx.container;
      if (!container) throw new Error('container_missing');
      const image = container.images.ocr;
      if (!image) throw new Error('image_missing');
      const current = await container.inspect();
      // A new image map does not restart native-policy instances. Only replace
      // a known old image; an empty startup image is not a mismatch.
      if (current?.image && current.image !== image) await container.destroy();
      if (signal.aborted) throw new Error('deadline');
      if (!container.running) {
        container.start({ image, instance: 'standard-2', enableInternet: false, env: { OCR_CPU_THREADS: '1' } });
      }
      await container.setInactivityTimeout(IDLE_MS);
      await this.waitUntilReady(container, signal);
      if (signal.aborted) throw new Error('deadline');
      const response = await container.getTcpPort(8080).fetch(new Request(request, { signal }));
      if (signal.aborted) throw new Error('deadline');
      // Keep the deadline and busy gate until the actual inference result has
      // arrived; the TCP fetch returns as soon as headers are available.
      const bytes = await limitedBytes(response.body, 500_000);
      if (signal.aborted) throw new Error('deadline');
      return new Response(bytes.slice().buffer, {
        status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
  }

  private async waitUntilReady(container: Container, outerSignal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    outerSignal.addEventListener('abort', cancel, { once: true });
    if (outerSignal.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('readiness_timeout')); }, READY_MS);
    });
    const poll = async () => {
      const port = container.getTcpPort(8080);
      for (;;) {
        if (controller.signal.aborted) throw new Error('cancelled');
        try {
          const response = await port.fetch('http://container/health', { signal: controller.signal });
          // Readiness must be application health, not merely an open TCP port.
          const ready = response.ok;
          await response.body?.cancel();
          if (controller.signal.aborted) throw new Error('cancelled');
          if (ready) return;
        } catch {
          if (controller.signal.aborted) throw new Error('cancelled');
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
    };
    try {
      await Promise.race([poll(), deadline]);
    } catch (error) {
      // An unhealthy boot cannot keep paid compute running until another user
      // retries. Destruction also interrupts any pending readiness fetch.
      await container.destroy().catch(() => {});
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      outerSignal.removeEventListener('abort', cancel);
    }
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return routeRequest(request, (validated) =>
      env.OCR_CONTAINER.jurisdiction('eu').getByName('receipt-ocr-v1').fetch(validated));
  },
} satisfies ExportedHandler<Env>;
