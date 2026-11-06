import { nowSec } from './crypto';
import type { validateLogisticsInput } from './logistics-input.mjs';

export type LogisticsToolId = 'tco' | 'eoq' | 'genbestilling' | 'abc' | 'ladmeter' | 'luftfragt' | 'palletransport' | 'containertransport' | 'biltransport';
export type LogisticsInput = ReturnType<typeof validateLogisticsInput>;
export interface LogisticsCalculation {
  id: string; toolId: LogisticsToolId; name: string; input: LogisticsInput; version: number;
  createdAt: string; updatedAt: string; archivedAt: string | null;
}
export type LogisticsSummary = Omit<LogisticsCalculation, 'input'>;
interface Row {
  id: string; tool_id: LogisticsToolId; name: string; input_json?: string; version: number;
  created_at: number; updated_at: number; archived_at: number | null;
}
const columns = 'id, tool_id, name, version, created_at, updated_at, archived_at';
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const summary = (r: Row): LogisticsSummary => ({ id: r.id, toolId: r.tool_id, name: r.name, version: r.version,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), archivedAt: r.archived_at === null ? null : iso(r.archived_at) });
const calculation = (r: Row): LogisticsCalculation => ({ ...summary(r), input: JSON.parse(r.input_json!) as LogisticsInput });
type NewCalculation = Pick<LogisticsCalculation, 'toolId' | 'name' | 'input'>;

export async function listLogisticsCalculations(db: D1Database, customerId: number, archived = false): Promise<LogisticsSummary[]> {
  const { results } = await db.prepare(`SELECT ${columns} FROM logistics_calculations
    WHERE customer_id = ? AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'} ORDER BY updated_at DESC, id LIMIT 200`)
    .bind(customerId).all<Row>();
  return results.map(summary);
}
export async function getLogisticsCalculation(db: D1Database, customerId: number, id: string): Promise<LogisticsCalculation | null> {
  const row = await db.prepare(`SELECT ${columns}, input_json FROM logistics_calculations WHERE customer_id = ? AND id = ?`)
    .bind(customerId, id).first<Row>();
  return row ? calculation(row) : null;
}
export async function createLogisticsCalculation(db: D1Database, customerId: number, args: NewCalculation): Promise<LogisticsCalculation | null> {
  const now = nowSec();
  // Quotas belong in the same write: simultaneous saves cannot bypass either cap.
  const row = await db.prepare(`INSERT INTO logistics_calculations
    (id, customer_id, tool_id, name, input_json, created_at, updated_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6
    WHERE (SELECT COUNT(*) FROM logistics_calculations WHERE customer_id = ?2 AND archived_at IS NULL) < 50
      AND (SELECT COUNT(*) FROM logistics_calculations WHERE customer_id = ?2) < 200
    RETURNING ${columns}, input_json`)
    .bind(crypto.randomUUID(), customerId, args.toolId, args.name, JSON.stringify(args.input), now).first<Row>();
  return row ? calculation(row) : null;
}
export async function saveLogisticsCalculation(db: D1Database, customerId: number, id: string, version: number,
  args: Pick<LogisticsCalculation, 'name' | 'input'>): Promise<LogisticsCalculation | null> {
  const row = await db.prepare(`UPDATE logistics_calculations SET name = ?, input_json = ?, version = version + 1, updated_at = ?
    WHERE customer_id = ? AND id = ? AND version = ? AND archived_at IS NULL RETURNING ${columns}, input_json`)
    .bind(args.name, JSON.stringify(args.input), nowSec(), customerId, id, version).first<Row>();
  return row ? calculation(row) : null;
}
export async function copyStoredLogisticsCalculation(db: D1Database, customerId: number, id: string, version: number, name: string): Promise<LogisticsCalculation | null> {
  const now = nowSec();
  // A dashboard copy uses the exact version the user saw, even during concurrent edits.
  const row = await db.prepare(`INSERT INTO logistics_calculations
    (id, customer_id, tool_id, name, input_json, created_at, updated_at)
    SELECT ?1, customer_id, tool_id, ?2, input_json, ?3, ?3 FROM logistics_calculations
    WHERE customer_id = ?4 AND id = ?5 AND version = ?6
      AND (SELECT COUNT(*) FROM logistics_calculations WHERE customer_id = ?4 AND archived_at IS NULL) < 50
      AND (SELECT COUNT(*) FROM logistics_calculations WHERE customer_id = ?4) < 200
    RETURNING ${columns}, input_json`)
    .bind(crypto.randomUUID(), name, now, customerId, id, version).first<Row>();
  return row ? calculation(row) : null;
}
export async function archiveLogisticsCalculation(db: D1Database, customerId: number, id: string, version: number, restore: boolean): Promise<LogisticsCalculation | null> {
  const now = nowSec();
  const row = await db.prepare(`UPDATE logistics_calculations SET archived_at = ?1, updated_at = ?2, version = version + 1
    WHERE customer_id = ?3 AND id = ?4 AND version = ?5
      AND ${restore ? 'archived_at IS NOT NULL AND (SELECT COUNT(*) FROM logistics_calculations WHERE customer_id = ?3 AND archived_at IS NULL) < 50' : 'archived_at IS NULL'}
    RETURNING ${columns}, input_json`)
    .bind(restore ? null : now, now, customerId, id, version).first<Row>();
  return row ? calculation(row) : null;
}
