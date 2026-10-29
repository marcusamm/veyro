// Direct upload starts an unapproved private draft. OCR and all business
// registrations remain separate, deliberate actions on the existing bilag routes.
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { createBilag, getBilag } from '../lib/bilag';
import { FILE_MAX_BYTES, safeName, sniff, storeFile, type FileRow } from '../lib/files';
import { opToken } from '../lib/ledger';
import { canManage, csrfMiddleware, requireUser } from '../lib/session';
import { actorOf, newOp, render } from '../render';
import { bilagAssistantPage } from '../views/bilagassistant';

type UploadClaim = { actor: string; op: string; sha256: string; file_id: number | null; bilag_id: number | null };
const uploadClaim = (db: D1Database, actor: string, op: string) => db.prepare('SELECT * FROM bilag_chat_uploads WHERE actor=? AND op=?').bind(actor, op).first<UploadClaim>();

/**
 * Keep createBilag's defaults, event and duplicate warning behavior. Only its
 * draft INSERT is wrapped: D1 commits it together with the idempotency claim.
 * No draft can exist from this request without its claim, even after a crash.
 */
function claimCreation(db: D1Database, actor: string, op: string, file: FileRow, now: number): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!/^\s*INSERT INTO bilag\s*\(/i.test(sql)) return statement;
      return {
        bind(...values: unknown[]) {
          const insert = statement.bind(...values);
          return {
            async first(column?: string) {
              const results = await db.batch([
                db.prepare('INSERT INTO bilag_chat_uploads(actor,op,sha256,file_id,created_at) VALUES(?,?,?,?,?)').bind(actor, op, file.sha256, file.id, now),
                insert,
                db.prepare('UPDATE bilag_chat_uploads SET bilag_id=last_insert_rowid() WHERE actor=? AND op=?').bind(actor, op),
              ]);
              const row = results[1]?.results?.[0] as { id: number } | undefined;
              if (!row?.id) throw new Error('Chat draft insert returned no id');
              return column ? row[column as keyof typeof row] : row;
            },
          } as D1PreparedStatement;
        },
      } as D1PreparedStatement;
    },
    batch: (statements: D1PreparedStatement[]) => db.batch(statements),
  } as D1Database;
}

export function bilagAssistantRoutes(portal: 'lager' | 'job') {
  const r = new Hono<AppEnv>();
  const base = `/${portal}/bilag`;
  r.use('*', requireUser);
  if (portal === 'lager') r.use('*', async (c, next) => {
    if (!canManage(c.get('session')!.user)) return c.redirect('/job/bilag', 303);
    await next();
  });
  r.use('*', csrfMiddleware);

  r.get('/', c => render(c, 'Bilagsassistent', bilagAssistantPage({ base, csrf: c.get('csrf'), op: newOp(), available: !!c.env.RECEIPT_CHAT }), { portal, tab: 'bilag' }));

  r.post('/upload', async c => {
    const json = c.req.header('Accept')?.includes('application/json');
    const failure = (message: string, status: 400 | 409 | 413 | 503) => json ? c.json({ error: message }, status) : c.text(message, status);
    if (!c.env.RECEIPT_CHAT) return failure('Bilagschatten er ikke tilsluttet på denne installation.', 503);
    if (Number(c.req.header('Content-Length') || 0) > FILE_MAX_BYTES + 65_536) return failure('Filen er for stor. Brug højst 15 MB.', 413);
    let form: FormData;
    try { form = await c.req.formData(); } catch { return failure('Filen kunne ikke læses. Vælg den igen.', 400); }
    const ops = form.getAll('op'), files = form.getAll('file');
    const op = ops.length === 1 ? opToken(ops[0]) : null;
    if (!op) return failure('Formularen er udløbet. Genindlæs siden og prøv igen.', 400);
    const upload = files[0];
    if (files.length !== 1 || !(upload instanceof File) || !upload.size) return failure('Vælg ét billede eller én PDF-kvittering.', 400);
    if (upload.size > FILE_MAX_BYTES) return failure('Filen er for stor. Brug højst 15 MB.', 413);
    const bytes = new Uint8Array(await upload.arrayBuffer());
    const kind = sniff(bytes);
    if (!kind || !['png', 'jpg', 'heic', 'pdf'].includes(kind)) return failure('Filtypen er ikke tilladt. Brug JPG, PNG, HEIC eller PDF.', 400);
    const actor = actorOf(c), now = Math.floor(Date.now() / 1000), db = c.env.DB;
    try {
      const stored = await storeFile(db, bytes, actor.email, now, ['png', 'jpg', 'heic', 'pdf']);
      if (!stored.ok) return failure(stored.error, 400);
      let claim = await uploadClaim(db, actor.email, op);
      let created = false;
      if (!claim) {
        try {
          await createBilag(claimCreation(db, actor.email, op, stored.file, now), stored.file,
            safeName(upload.name, `bilag.${kind === 'jpg' ? 'jpg' : kind}`),
            { doc_type: 'kvittering', payment: 'uafklaret', paid_by: '', job_hint: null, origin: 'chat', note: '', preview_file_id: null }, actor, now);
          created = true;
        } catch (error) {
          // A concurrent copy may have won the unique claim. Also recover a
          // committed draft if a later event/duplicate-warning write failed.
          claim = await uploadClaim(db, actor.email, op);
          if (!claim) throw error;
        }
        claim ??= await uploadClaim(db, actor.email, op);
      }
      if (!claim || claim.sha256 !== stored.file.sha256) return failure('Denne upload er allerede brugt til en anden fil. Genindlæs siden for at uploade en ny.', 409);
      const b = claim.bilag_id ? await getBilag(db, claim.bilag_id) : null;
      if (!b || b.file_id !== claim.file_id || b.uploaded_by !== actor.email) return failure('Det tidligere upload findes ikke længere. Genindlæs siden før en ny upload.', 409);
      const result = { id: b.id, url: `${base}/${b.id}`, fileName: b.file_name, version: b.version, file_id: b.file_id, mime: stored.file.mime, op: newOp() };
      return json ? c.json(result, created ? 201 : 200) : c.redirect(result.url, 303);
    } catch {
      return failure('Filen kunne ikke gemmes. Prøv igen med den samme upload; der oprettes ikke to bilag.', 503);
    }
  });
  return r;
}
