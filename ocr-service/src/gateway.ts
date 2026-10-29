// This boundary accepts bytes, never document URLs or arbitrary container paths.
export const MAX_FILE = 15 * 1024 * 1024;
const MAX_RESPONSE = 500_000;
const TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/heic']);

class LimitError extends Error {}

export function failure(status: number, code: string): Response {
  return Response.json({ error: code }, {
    status,
    headers: { 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '3600' } : {}) },
  });
}

export async function limitedBytes(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new LimitError();
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

export async function routeRequest(request: Request, forward: (request: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== 'receipt-ocr.internal' || url.search) return failure(404, 'not_found');
  // Deliberately does not wake the paid container. Inference is checked using TESTDATA.
  if (url.pathname === '/health' && request.method === 'GET') return Response.json({ service: 'veyro-receipt-ocr', access: 'service-binding-only' });
  if (url.pathname !== '/v1/extract') return failure(404, 'not_found');
  if (request.method !== 'POST') return failure(405, 'method_not_allowed');
  const mime = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
  if (!TYPES.has(mime)) return failure(415, 'unsupported_type');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_FILE)) return failure(413, 'file_too_large');
  try {
    const bytes = await limitedBytes(request.body, MAX_FILE);
    if (!bytes.length) return failure(400, 'empty_file');
    const response = await forward(new Request('http://container/v1/extract', {
      method: 'POST', headers: { 'Content-Type': mime }, body: bytes.slice().buffer,
      signal: request.signal,
    }));
    // Never relay a Python exception, model filename, or document content in an error.
    if (!response.ok) {
      await response.body?.cancel();
      return failure([400, 413, 415, 422, 429, 503, 504].includes(response.status) ? response.status : 502,
        response.status === 429 ? 'daily_limit' : response.status === 503 ? 'busy_or_unavailable' : 'ocr_failed');
    }
    const raw = await limitedBytes(response.body, MAX_RESPONSE);
    const result = JSON.parse(new TextDecoder().decode(raw)) as { pages?: unknown; provider?: unknown };
    if (!result || !Array.isArray(result.pages) || !result.pages.length || result.pages.length > 10) return failure(502, 'invalid_ocr_result');
    let count = 0;
    const pages: string[] = [];
    for (const page of result.pages) {
      if (typeof page !== 'string') return failure(502, 'invalid_ocr_result');
      const text = page.replace(/\u0000/g, '').trim();
      count += text.length;
      if (count > 100_000) return failure(502, 'invalid_ocr_result');
      pages.push(text);
    }
    if (!pages.some(Boolean)) return failure(422, 'no_text_found');
    // The model name is fixed by the deployment, not accepted from the caller.
    const provider = typeof result.provider === 'string' ? result.provider.replace(/[\u0000-\u001f]/g, '').slice(0, 80).trim() : '';
    return Response.json({ pages, provider: provider || 'Veyro PaddleOCR' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error instanceof LimitError ? 413 : 502, error instanceof LimitError ? 'size_limit' : 'ocr_unavailable');
  }
}

export type Budget = { day: string; attempts: number };
export function nextBudget(current: Budget | undefined, now: number, limit = 30): Budget | null {
  const day = new Date(now).toISOString().slice(0, 10);
  const attempts = current?.day === day ? current.attempts : 0;
  return attempts >= limit ? null : { day, attempts: attempts + 1 };
}
