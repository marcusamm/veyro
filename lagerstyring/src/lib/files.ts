// Private filer i databasen (bilag). Hver fil gemmes én gang ud fra indholdets SHA-256, uændret og
// i stykker á højst 1 MB, så også store PDF'er og billeder fra telefonen kan gemmes i D1. Filerne
// kan kun hentes gennem appens egne ruter, som kræver login.

import { PDFDocument } from 'pdf-lib';

export const FILE_MAX_BYTES = 15 * 1024 * 1024;
export const UPLOAD_MAX_FILES = 20;
const CHUNK = 1_000_000;

export type FileKind = 'pdf' | 'jpg' | 'png' | 'heic' | 'zip';

export const MIME: Record<FileKind, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  zip: 'application/zip',
};

export interface FileRow {
  id: number;
  sha256: string;
  mime: string;
  size: number;
  pages: number | null;
  chunks: number;
  created_by: string;
  created_at: number;
}

/** Filtypen ud fra indholdet (ikke filnavnet). null = ikke tilladt. */
export function sniff(b: Uint8Array): FileKind | null {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  if (b.length >= 12 && String.fromCharCode(...b.slice(4, 8)) === 'ftyp') {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return null;
}

export function kindOfMime(mime: string): FileKind | null {
  return (Object.keys(MIME) as FileKind[]).find((k) => MIME[k] === mime) ?? null;
}

/** Kan browseren vise filen direkte? (HEIC kan de fleste browsere ikke) */
export function viewable(mime: string): boolean {
  return mime !== MIME.heic;
}

export async function sha256Bytes(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function pdfPages(b: Uint8Array): Promise<number | null> {
  try {
    const doc = await PDFDocument.load(b, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    return null;
  }
}

/** Et sikkert filnavn til visning og eksport (bevarer æøå). */
export function safeName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || fallback;
}

export type StoreResult = { ok: true; file: FileRow; existed: boolean } | { ok: false; error: string };

/** Validerer og gemmer en fil (genbruger en eksisterende fil med samme indhold). */
export async function storeFile(db: D1Database, bytes: Uint8Array, actor: string, now: number, allowed: FileKind[] = ['pdf', 'jpg', 'png', 'heic'], maxBytes = FILE_MAX_BYTES): Promise<StoreResult> {
  if (!bytes.length) return { ok: false, error: 'Filen er tom.' };
  if (bytes.length > maxBytes) return { ok: false, error: `Filen er for stor (højst ${Math.round(maxBytes / 1024 / 1024)} MB).` };
  const kind = sniff(bytes);
  if (!kind || !allowed.includes(kind)) return { ok: false, error: 'Filtypen er ikke tilladt. Brug JPG, PNG, HEIC eller PDF.' };
  const sha = await sha256Bytes(bytes);
  const found = await db.prepare('SELECT * FROM files WHERE sha256 = ?').bind(sha).first<FileRow>();
  if (found) return { ok: true, file: found, existed: true };
  const pages = kind === 'pdf' ? await pdfPages(bytes) : null;
  const chunks = Math.ceil(bytes.length / CHUNK);
  // Filen oprettes og alle stykker gemmes i samme batch: enten hele filen eller intet
  const stmts = [
    db.prepare('INSERT INTO files (sha256, mime, size, pages, chunks, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(sha, MIME[kind], bytes.length, pages, chunks, actor, now),
  ];
  for (let i = 0; i < chunks; i++) {
    stmts.push(
      db.prepare('INSERT INTO file_chunks (file_id, idx, data) VALUES ((SELECT id FROM files WHERE sha256 = ?), ?, ?)').bind(sha, i, bytes.slice(i * CHUNK, (i + 1) * CHUNK).buffer),
    );
  }
  try {
    await db.batch(stmts);
  } catch (err) {
    // En anden upload af samme fil kom først
    if (!String((err as Error)?.message).includes('UNIQUE')) throw err;
  }
  const row = await db.prepare('SELECT * FROM files WHERE sha256 = ?').bind(sha).first<FileRow>();
  return row ? { ok: true, file: row, existed: false } : { ok: false, error: 'Filen kunne ikke gemmes. Prøv igen.' };
}

export async function getFile(db: D1Database, id: number): Promise<FileRow | null> {
  return db.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRow>();
}

/** Filens indhold, samlet fra stykkerne (null hvis et stykke mangler). */
export async function fileBytes(db: D1Database, f: FileRow): Promise<Uint8Array | null> {
  const { results } = await db.prepare('SELECT idx, data FROM file_chunks WHERE file_id = ? ORDER BY idx').bind(f.id).all<{ idx: number; data: ArrayBuffer | number[] }>();
  if (results.length !== f.chunks) return null;
  const out = new Uint8Array(f.size);
  let at = 0;
  for (const r of results) {
    const part = r.data instanceof ArrayBuffer ? new Uint8Array(r.data) : Uint8Array.from(r.data);
    out.set(part, at);
    at += part.length;
  }
  return at === f.size ? out : null;
}
