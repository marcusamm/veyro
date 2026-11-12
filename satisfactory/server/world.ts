import { PlanValidationError } from '../app/lib/plan-validation';
import { MAX_PLAN_BYTES, readWorldJson, validateRevision, validateWorldPlan, validateWorldSnapshot } from '../app/world/validation';
import type { SavedWorldPlan, WorldConnection, WorldSnapshot, WorldState } from '../app/world/types';
import { randomToken, sha256 } from './password';

type Actor = { id: string; username: string; role: string };
type ConnectionRow = { token_hash: string | null; created_at: string | null; world_id: string | null; sequence: number; observed_at: string | null; snapshot_id: string | null; received_at: string | null };
type PlanRow = { data: string; revision: number; updated_at: string | null; updated_by: string | null };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
const bad = (message: string): never => { throw new PlanValidationError(message); };
const connectionReply = (row: ConnectionRow): WorldConnection => ({ configured: !!row.token_hash, createdAt: row.created_at, worldId: row.world_id });
const planReply = (row: PlanRow): SavedWorldPlan => ({ data: JSON.parse(row.data), revision: row.revision, updatedAt: row.updated_at, updatedBy: row.updated_by });
async function connection(db: D1Database): Promise<ConnectionRow> {
  const row = await db.prepare('SELECT * FROM factory_world_connection WHERE id=1').first<ConnectionRow>();
  if (!row) throw new Error('World map migration is missing.');
  return row;
}
function bodyFields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('Send a JSON object.');
  if (Object.keys(value).some(key => !keys.includes(key))) bad('The request contains unsupported fields.');
  return value as Record<string, unknown>;
}
function equalHash(left: string, right: string): boolean {
  if (left.length !== 64 || right.length !== 64) return false;
  let difference = 0; for (let index = 0; index < 64; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/** All browser routes must be called after the application's session and Origin checks. */
export async function worldApi(request: Request, db: D1Database, user: Actor): Promise<Response> {
  const path = new URL(request.url).pathname, method = request.method;
  if (path === '/api/world' && method === 'GET') {
    // The manifest and its chunks are read in a single statement, avoiding a race with a new snapshot.
    const result = await db.prepare(`SELECT c.token_hash,c.received_at,c.observed_at,p.part,p.data FROM factory_world_connection c LEFT JOIN factory_world_chunks p ON p.snapshot_id=c.snapshot_id WHERE c.id=1 ORDER BY p.part`).all<{ token_hash: string | null; received_at: string | null; observed_at: string | null; part: number | null; data: string | null }>();
    const first = result.results[0]; if (!first) throw new Error('World map migration is missing.');
    const snapshot = first.data === null ? null : JSON.parse(result.results.map(part => part.data).join('')) as WorldSnapshot;
    const fresh = first.received_at && first.observed_at && Date.now() - Date.parse(first.received_at) <= 90_000 && Date.now() - Date.parse(first.observed_at) <= 90_000;
    const state: WorldState = { status: !first.token_hash ? 'not_connected' : !snapshot ? 'waiting' : fresh ? 'live' : 'stale', configured: !!first.token_hash, snapshot, lastReceivedAt: first.received_at };
    return json(state);
  }
  if (path === '/api/world/connection') {
    if (user.username !== 'marcus' || user.role !== 'admin') return json({ error: 'Only Marcus can configure the server connection.' }, 403);
    if (method === 'GET') return json(connectionReply(await connection(db)));
    if (method === 'POST') {
      bodyFields(await readWorldJson(request, 1024), []);
      const token = randomToken(), hash = await sha256(token), now = new Date().toISOString();
      // Rotation retains the bound world, snapshot and plans. An old token cannot publish afterward.
      await db.prepare('UPDATE factory_world_connection SET token_hash=?,created_at=?,created_by=? WHERE id=1').bind(hash, now, user.id).run();
      return json({ token, createdAt: now, ingestUrl: new URL('/api/world/ingest', request.url).href }, 201);
    }
    if (method === 'DELETE') {
      await db.prepare('UPDATE factory_world_connection SET token_hash=NULL WHERE id=1').run();
      return json(connectionReply(await connection(db)));
    }
    return json({ error: 'Use GET, POST or DELETE.' }, 405);
  }
  if (path === '/api/world/plan') {
    if (method === 'GET') {
      const row = await db.prepare('SELECT * FROM factory_world_plans WHERE id=1').first<PlanRow>();
      if (!row) throw new Error('World plan migration is missing.');
      return json(planReply(row));
    }
    if (method !== 'PUT') return json({ error: 'Use GET or PUT.' }, 405);
    const body = bodyFields(await readWorldJson(request, MAX_PLAN_BYTES), ['data', 'revision']);
    const data = validateWorldPlan(body.data), revision = validateRevision(body.revision), current = await connection(db);
    if (data.worldId !== current.world_id) return json({ error: 'This plan belongs to another world. Load the current world before saving.', code: 'world_mismatch' }, 409);
    // Check world identity again in SQL to protect a save racing the first snapshot.
    const row = await db.prepare(`UPDATE factory_world_plans SET data=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=1 AND revision=? AND EXISTS(SELECT 1 FROM factory_world_connection WHERE id=1 AND world_id IS ?) RETURNING *`)
      .bind(JSON.stringify(data), new Date().toISOString(), user.id, revision, data.worldId).first<PlanRow>();
    if (!row) return json({ error: 'A newer plan or world arrived. Export your draft before loading the latest version.', code: 'revision_conflict' }, 409);
    return json(planReply(row));
  }
  return json({ error: 'World endpoint not found.' }, 404);
}

/** The sole machine-to-machine route. Its ingest-only token never grants player/game administration. */
export async function worldIngest(request: Request, db: D1Database): Promise<Response> {
  if (new URL(request.url).pathname !== '/api/world/ingest') return json({ error: 'Not found.' }, 404);
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  const auth = request.headers.get('authorization') || '', token = /^Bearer [0-9a-f]{64}$/.test(auth) ? auth.slice(7) : '';
  if (!token) return json({ error: 'Invalid ingestion credential.' }, 401);
  const hash = await sha256(token), current = await connection(db);
  if (!current.token_hash || !equalHash(hash, current.token_hash)) return json({ error: 'Invalid ingestion credential.' }, 401);
  const snapshot = validateWorldSnapshot(await readWorldJson(request));
  if (current.world_id !== null && current.world_id !== snapshot.worldId) return json({ error: 'This connection is bound to a different world. Existing plans were kept.', code: 'world_mismatch' }, 409);
  if (snapshot.sequence <= current.sequence || (current.observed_at && snapshot.observedAt < current.observed_at)) return json({ error: 'This snapshot is older than the saved world.', code: 'stale_snapshot' }, 409);
  const snapshotId = crypto.randomUUID(), serialized = JSON.stringify(snapshot), now = new Date().toISOString(), chunks: string[] = [];
  // At most 750 KB UTF-8 per TEXT value; do not split a UTF-16 surrogate pair.
  for (let offset = 0; offset < serialized.length;) {
    let end = Math.min(offset + 250_000, serialized.length);
    if (end < serialized.length && /[\uD800-\uDBFF]/.test(serialized[end - 1])) end--;
    chunks.push(serialized.slice(offset, end)); offset = end;
  }
  const condition = `id=1 AND token_hash=? AND sequence<? AND (world_id IS NULL OR world_id=?) AND (observed_at IS NULL OR observed_at<=?)`;
  const args = [hash, snapshot.sequence, snapshot.worldId, snapshot.observedAt];
  const statements = chunks.map((chunk, index) => db.prepare(`INSERT INTO factory_world_chunks(snapshot_id,part,data) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM factory_world_connection WHERE ${condition})`).bind(snapshotId, index, chunk, ...args));
  statements.push(db.prepare(`UPDATE factory_world_connection SET world_id=?,sequence=?,observed_at=?,snapshot_id=?,received_at=? WHERE ${condition} RETURNING snapshot_id`).bind(snapshot.worldId, snapshot.sequence, snapshot.observedAt, snapshotId, now, ...args));
  statements.push(db.prepare('DELETE FROM factory_world_chunks WHERE snapshot_id IS NOT (SELECT snapshot_id FROM factory_world_connection WHERE id=1)'));
  const result = await db.batch(statements), published = result[chunks.length].results as { snapshot_id: string }[];
  if (published[0]?.snapshot_id !== snapshotId) return json({ error: 'The connection changed or a newer snapshot arrived. This upload was not published.', code: 'snapshot_conflict' }, 409);
  return json({ accepted: true, sequence: snapshot.sequence, receivedAt: now, entities: snapshot.entities.length, links: snapshot.links.length });
}
