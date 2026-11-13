import { validateProductionDraft, type ProductionDraft } from './production-validation';

export const MAX_PRODUCTION_SHARE_TOKEN_LENGTH = 30_000;
export const MAX_PRODUCTION_SHARE_BYTES = 100_000;
const MAX_COMPRESSED_BYTES = Math.floor(MAX_PRODUCTION_SHARE_TOKEN_LENGTH * 3 / 4);

function byteStream(bytes: Uint8Array<ArrayBuffer>): ReadableStream<BufferSource> {
  let position = 0;
  return new ReadableStream<BufferSource>({
    pull(controller) {
      if (position >= bytes.byteLength) { controller.close(); return; }
      // Small compressed input chunks let cancellation stop highly expanding data
      // before the complete payload is pushed through the decompressor.
      const end = Math.min(position + 256, bytes.byteLength);
      controller.enqueue(bytes.subarray(position, end));
      position = end;
    },
  });
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, message: string): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(message);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(token: string): Uint8Array<ArrayBuffer> {
  if (typeof token !== 'string' || !token || token.length > MAX_PRODUCTION_SHARE_TOKEN_LENGTH) throw new Error('The shared-plan link is empty or exceeds 30 KB.');
  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length % 4 === 1) throw new Error('The shared-plan link is not valid base64url.');
  let binary: string;
  try { binary = atob(token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - token.length % 4) % 4)); }
  catch { throw new Error('The shared-plan link is not valid base64url.'); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (base64Url(bytes) !== token) throw new Error('The shared-plan link has invalid base64url padding bits.');
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) throw new Error('The shared-plan link does not contain gzip data.');
  return bytes;
}

/** Share only the validated production draft; no accounts or saved results are included. */
export async function encodeProductionShare(draft: ProductionDraft): Promise<string> {
  const checked = validateProductionDraft(draft);
  const bytes = new TextEncoder().encode(JSON.stringify(checked));
  if (bytes.byteLength > MAX_PRODUCTION_SHARE_BYTES) throw new Error('This production plan exceeds the 100 KB share limit. Export it as a file instead.');
  const compressed = await readBounded(
    byteStream(bytes).pipeThrough(new CompressionStream('gzip')),
    MAX_COMPRESSED_BYTES,
    'This production plan is too large for a share link. Export it as a file instead.',
  );
  const token = base64Url(compressed);
  if (token.length > MAX_PRODUCTION_SHARE_TOKEN_LENGTH) throw new Error('This production plan is too large for a share link. Export it as a file instead.');
  return token;
}

/** Decode an untrusted link into a draft. The caller chooses whether to import or save it. */
export async function decodeProductionShare(token: string): Promise<ProductionDraft> {
  const compressed = decodeBase64Url(token);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readBounded(
      byteStream(compressed).pipeThrough(new DecompressionStream('gzip')),
      MAX_PRODUCTION_SHARE_BYTES,
      'The shared plan expands beyond the 100 KB limit.',
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('100 KB')) throw error;
    throw new Error('The shared-plan link is damaged or incomplete.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('The shared-plan link does not contain valid UTF-8 JSON.'); }
  return validateProductionDraft(parsed);
}
