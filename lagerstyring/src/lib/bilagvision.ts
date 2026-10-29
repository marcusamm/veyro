// Private original images for a read-only review. No public URLs or writes.
import { getBilag, type BilagRow } from './bilag';
import { fileBytes, getFile, sniff } from './files';

export const RECEIPT_VISION_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export interface ChatOriginalImage { dataUrl: string; mime: 'image/png' | 'image/jpeg' }
export class BilagVisionError extends Error {
  constructor(message: string, readonly status: 409 | 502) { super(message); }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary);
}

function imageMime(mime: string): mime is ChatOriginalImage['mime'] {
  return mime === 'image/png' || mime === 'image/jpeg';
}

/** Same document-access authorization as the detail view is required by caller. */
export async function chatOriginalImage(db: D1Database, b: BilagRow): Promise<ChatOriginalImage | null> {
  const changed = () => new BilagVisionError('Originalbilaget er ændret imens. Genindlæs siden, og stil spørgsmålet igen.', 409);
  let current = await getBilag(db, b.id);
  if (!current || current.file_id !== b.file_id) throw changed();
  const file = await getFile(db, b.file_id);
  if (!file || !imageMime(file.mime) || file.size > MAX_IMAGE_BYTES) return null;
  const bytes = await fileBytes(db, file);
  current = await getBilag(db, b.id);
  if (!current || current.file_id !== b.file_id) throw changed();
  if (!bytes?.length || bytes.length > MAX_IMAGE_BYTES || (file.mime === 'image/png' ? sniff(bytes) !== 'png' : sniff(bytes) !== 'jpg')) return null;
  return { dataUrl: `data:${file.mime};base64,${base64(bytes)}`, mime: file.mime };
}

/** Only the in-memory bytes of an authorized original may become model media. */
function validImage(image: ChatOriginalImage): boolean {
  if (!image || !imageMime(image.mime) || typeof image.dataUrl !== 'string') return false;
  const prefix = `data:${image.mime};base64,`;
  if (!image.dataUrl.startsWith(prefix)) return false;
  const encoded = image.dataUrl.slice(prefix.length);
  if (!encoded || encoded.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  try {
    const decoded = atob(encoded);
    if (!decoded.length || decoded.length > MAX_IMAGE_BYTES || btoa(decoded) !== encoded) return false;
    const head = Uint8Array.from(decoded.slice(0, 12), c => c.charCodeAt(0));
    return image.mime === 'image/png' ? sniff(head) === 'png' : sniff(head) === 'jpg';
  } catch { return false; }
}

/** Called within the review service's existing request deadline. No tools. */
export async function runVisionChat(ai: Ai, system: string, userData: string, schema: object, image: ChatOriginalImage): Promise<unknown> {
  if (!validImage(image)) throw new BilagVisionError('Billedet kunne ikke klargøres til gennemgang. Originalen er uændret.', 502);
  let result: unknown;
  try {
    result = await ai.run(RECEIPT_VISION_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: image.dataUrl, detail: 'high' } },
          { type: 'text', text: userData },
        ] },
      ],
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0.1,
      max_completion_tokens: 1100,
      store: false,
      stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'receipt_review', schema: schema as Record<string, unknown>, strict: true } },
    });
  } catch {
    throw new BilagVisionError('Billedgennemgangen kunne ikke gennemføres. Originalen og dine oplysninger er uændrede; prøv igen senere.', 502);
  }
  const choice = (result as { choices?: { finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }[] } | null)?.choices?.[0];
  if (!choice || choice.finish_reason !== 'stop' || choice.message?.refusal || typeof choice.message?.content !== 'string' || !choice.message.content.trim() || choice.message.content.length > 20000) {
    throw new BilagVisionError('Billedgennemgangen gav ikke et fuldstændigt svar. Prøv at spørge igen.', 502);
  }
  try {
    const response: unknown = JSON.parse(choice.message.content);
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('shape');
    // Normalize the new model's OpenAI-compatible response for the existing
    // answer/citation validator. Model-provided quotations are never trusted.
    return { response };
  } catch {
    throw new BilagVisionError('Svaret fra billedgennemgangen kunne ikke kontrolleres. Prøv at spørge igen.', 502);
  }
}
