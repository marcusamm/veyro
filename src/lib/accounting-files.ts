// Reuse Bilag's private, content-addressed D1 storage. OCR never replaces originals.
import { storeFile, sha256Bytes, safeName, type FileRow } from '../../lagerstyring/src/lib/files';
import { PDFDocument } from 'pdf-lib';
export { getFile, fileBytes } from '../../lagerstyring/src/lib/files';
export const ACCOUNTING_FILE_LIMIT = 15 * 1024 * 1024;
const CHUNK = 1_000_000;

export async function storeAccountingOriginal(db: D1Database, actor: string, upload: File, bankImport = false): Promise<{ file: FileRow; name: string; bytes: Uint8Array }> {
  if (!upload.size || upload.size > ACCOUNTING_FILE_LIMIT) throw new Error('Vælg en fil på højst 15 MB.');
  const bytes = new Uint8Array(await upload.arrayBuffer());
  const now = Math.floor(Date.now() / 1000);
  const name = safeName(upload.name, 'bilag');
  if (bankImport && /\.csv$/i.test(name)) {
    if (bytes.length > 2 * 1024 * 1024) throw new Error('CSV-filen må højst være 2 MB. Del større udtog op i perioder.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { throw new Error('CSV-filen skal være UTF-8. Eksportér den som CSV fra Revolut igen.'); }
    if (text.includes('\0') || !/[,;\t]/.test(text)) throw new Error('Filen ligner ikke et CSV-udtog.');
    const sha = await sha256Bytes(bytes);
    let file = await db.prepare('SELECT * FROM files WHERE sha256 = ?').bind(sha).first<FileRow>();
    if (!file) {
      const count = Math.ceil(bytes.length / CHUNK);
      const statements = [db.prepare('INSERT INTO files (sha256,mime,size,pages,chunks,created_by,created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)')
        .bind(sha, 'text/csv', bytes.length, count, actor, now)];
      for (let i = 0; i < count; i++) statements.push(db.prepare('INSERT INTO file_chunks (file_id,idx,data) VALUES ((SELECT id FROM files WHERE sha256 = ?), ?, ?)')
        .bind(sha, i, bytes.slice(i * CHUNK, (i + 1) * CHUNK).buffer));
      try { await db.batch(statements); }
      catch (error) { if (!String((error as Error).message).includes('UNIQUE')) throw error; }
      file = await db.prepare('SELECT * FROM files WHERE sha256 = ?').bind(sha).first<FileRow>();
    }
    if (!file || file.mime !== 'text/csv') throw new Error('Originalfilen kunne ikke gemmes.');
    return { file, name, bytes };
  }
  // Validate before making an immutable file; rejected PDFs must not leave inaccessible originals.
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-') {
    try {
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      if (pdf.getPageCount() < 1 || pdf.getPageCount() > 20) throw new Error('pages');
    } catch { throw new Error('PDF-filen skal kunne åbnes uden adgangskode og være højst 20 sider.'); }
  }
  const saved = await storeFile(db, bytes, actor, now, bankImport ? ['pdf'] : ['pdf', 'jpg', 'png'], ACCOUNTING_FILE_LIMIT);
  if (!saved.ok) throw new Error(bankImport ? 'Brug et Revolut-udtog i CSV eller PDF.' : 'Brug en original PDF, JPG eller PNG på højst 15 MB.');
  if (saved.file.mime === 'application/pdf' && (!saved.file.pages || saved.file.pages > 20)) throw new Error('PDF-filen skal være læsbar og højst 20 sider. Del større udtog op i perioder.');
  return { file: saved.file, name, bytes };
}
