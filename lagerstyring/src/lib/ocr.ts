// OCR is a separate, optional integration. Originals stay in the company's D1;
// this adapter supplies text suggestions only and never writes business data.
import type { Env } from '../env';

export type OcrResult =
  | { status: 'ok'; pages: string[]; provider: string }
  | { status: 'unavailable' | 'failed'; message: string };

const MAX_FILE = 15 * 1024 * 1024;
const MAX_RESPONSE = 500_000;
const MAX_TEXT = 100_000;
const TIMEOUT_MS = 15_000;
const TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/heic']);

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length') || 0) > MAX_RESPONSE) throw new Error('size');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE) throw new Error('size');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function extractReceiptText(
  env: Pick<Env, 'RECEIPT_OCR'>,
  input: { bytes: Uint8Array; mime: string },
): Promise<OcrResult> {
  if (!env.RECEIPT_OCR) return { status: 'unavailable', message: 'OCR er ikke tilsluttet. Kontrollér og registrér oplysningerne manuelt ud fra originalen.' };
  if (!TYPES.has(input.mime) || !input.bytes.length || input.bytes.length > MAX_FILE) {
    return { status: 'failed', message: 'Filen kan ikke sendes til OCR. Brug PDF, JPG, PNG eller HEIC på højst 15 MB.' };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const binding = env.RECEIPT_OCR;
  const work = async (): Promise<OcrResult> => {
    const response = await binding.fetch(new Request('https://receipt-ocr.internal/v1/extract', {
      method: 'POST',
      headers: { 'Content-Type': input.mime, Accept: 'application/json' },
      body: input.bytes.slice().buffer,
      signal: controller.signal,
    }));
    if (!response.ok) throw new Error('provider');
    const data = await boundedJson(response) as { pages?: unknown; provider?: unknown } | null;
    if (!data || !Array.isArray(data.pages) || !data.pages.length || data.pages.length > 10) throw new Error('pages');
    const pages: string[] = [];
    let length = 0;
    for (const page of data.pages) {
      if (typeof page !== 'string') throw new Error('text');
      const text = page.replace(/\u0000/g, '').trim();
      length += text.length;
      if (length > MAX_TEXT) throw new Error('size');
      pages.push(text);
    }
    if (!pages.some(Boolean)) throw new Error('empty');
    const provider = typeof data.provider === 'string' ? data.provider.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) : '';
    return { status: 'ok', pages, provider: provider || 'Tilsluttet OCR-tjeneste' };
  };
  try {
    return await Promise.race([
      work(),
      new Promise<OcrResult>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, TIMEOUT_MS); }),
    ]);
  } catch {
    return { status: 'failed', message: 'OCR kunne ikke aflæse bilaget. Originalen er bevaret uændret; kontrollér og registrér oplysningerne manuelt, eller prøv igen.' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
