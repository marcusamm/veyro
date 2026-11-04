import { nowSec } from './crypto';
import type { PlanningData, PlanningTemplateId } from './planning';

export type ToolCurrency = 'DKK' | 'EUR' | 'SEK';
export interface ToolProject {
  id: string;
  templateId: PlanningTemplateId;
  name: string;
  currency: ToolCurrency;
  data: PlanningData;
  version: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}
export type ToolProjectSummary = Omit<ToolProject, 'data'>;
interface ProjectRow {
  id: string; template_id: PlanningTemplateId; name: string; currency: ToolCurrency;
  data_json?: string; version: number; created_at: number; updated_at: number; archived_at: number | null;
}
const summaryColumns = 'id, template_id, name, currency, version, created_at, updated_at, archived_at';
function summary(row: ProjectRow): ToolProjectSummary {
  return { id: row.id, templateId: row.template_id, name: row.name, currency: row.currency, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at };
}
export async function listToolProjects(db: D1Database, customerId: number): Promise<ToolProjectSummary[]> {
  const rows = await db.prepare(`SELECT ${summaryColumns} FROM tool_projects WHERE customer_id = ? ORDER BY archived_at IS NOT NULL, updated_at DESC, id LIMIT 200`)
    .bind(customerId).all<ProjectRow>();
  return rows.results.map(summary);
}
export async function getToolProject(db: D1Database, customerId: number, id: string): Promise<ToolProject | null> {
  const row = await db.prepare(`SELECT ${summaryColumns}, data_json FROM tool_projects WHERE customer_id = ? AND id = ?`)
    .bind(customerId, id).first<ProjectRow>();
  return row ? { ...summary(row), data: JSON.parse(row.data_json!) as PlanningData } : null;
}
export async function createToolProject(db: D1Database, customerId: number, args: Pick<ToolProject, 'templateId' | 'name' | 'currency' | 'data'>): Promise<string | null> {
  const id = crypto.randomUUID();
  const now = nowSec();
  // Quotas are checked inside the write, so concurrent requests cannot bypass them.
  const result = await db.prepare(`INSERT INTO tool_projects (id, customer_id, template_id, name, currency, data_json, created_at, updated_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7
    WHERE (SELECT COUNT(*) FROM tool_projects WHERE customer_id = ?2 AND archived_at IS NULL) < 50
      AND (SELECT COUNT(*) FROM tool_projects WHERE customer_id = ?2) < 200`)
    .bind(id, customerId, args.templateId, args.name, args.currency, JSON.stringify(args.data), now).run();
  return result.meta.changes === 1 ? id : null;
}
export async function saveToolProject(db: D1Database, customerId: number, id: string, version: number, args: Pick<ToolProject, 'name' | 'currency' | 'data'>): Promise<boolean> {
  const result = await db.prepare(`UPDATE tool_projects SET name = ?, currency = ?, data_json = ?, version = version + 1, updated_at = ?
    WHERE customer_id = ? AND id = ? AND version = ? AND archived_at IS NULL`)
    .bind(args.name, args.currency, JSON.stringify(args.data), nowSec(), customerId, id, version).run();
  return result.meta.changes === 1;
}
export async function archiveToolProject(db: D1Database, customerId: number, id: string, version: number, restore: boolean): Promise<boolean> {
  const now = nowSec();
  const result = await db.prepare(`UPDATE tool_projects SET archived_at = ?1, updated_at = ?2, version = version + 1
    WHERE customer_id = ?3 AND id = ?4 AND version = ?5
      AND ${restore ? 'archived_at IS NOT NULL AND (SELECT COUNT(*) FROM tool_projects WHERE customer_id = ?3 AND archived_at IS NULL) < 50' : 'archived_at IS NULL'}`)
    .bind(restore ? null : now, now, customerId, id, version).run();
  return result.meta.changes === 1;
}
