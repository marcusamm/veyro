// Fælles hjælpere for jobportalens ruter.

import type { Context } from 'hono';
import type { AppEnv, User } from '../env';
import { canManage } from '../lib/session';
import type { JobHead } from '../views/job';

export const NAV = (tab: 'job' | 'lager' | 'katalog' | 'indkob' | 'faktura') => ({ portal: 'job', tab }) as const;

export const me = (c: Context<AppEnv>): User => c.get('session')!.user;

export const isManager = (c: Context<AppEnv>): boolean => canManage(me(c));

export const nowSec = () => Math.floor(Date.now() / 1000);

export async function jobHead(db: D1Database, id: number): Promise<JobHead | null> {
  return db
    .prepare('SELECT j.*, u.name AS responsible_name FROM jobs j LEFT JOIN users u ON u.email = j.responsible WHERE j.id = ?')
    .bind(id)
    .first<JobHead>();
}
