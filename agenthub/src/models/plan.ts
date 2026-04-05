import type Database from 'better-sqlite3';

export interface Plan {
  id: string;
  name: string;
  priceCents: number;
  execQuota: number;
  apiCallQuota: number;
  storageBytesQuota: number;
  seatQuota: number;
  retentionDays: number;
  createdAt: string;
}

interface PlanRow {
  id: string;
  name: string;
  price_cents: number;
  exec_quota: number;
  api_call_quota: number;
  storage_bytes_quota: number;
  seat_quota: number;
  retention_days: number;
  created_at: string;
}

function rowToPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    priceCents: row.price_cents,
    execQuota: row.exec_quota,
    apiCallQuota: row.api_call_quota,
    storageBytesQuota: row.storage_bytes_quota,
    seatQuota: row.seat_quota,
    retentionDays: row.retention_days,
    createdAt: row.created_at,
  };
}

// Default plan catalog. `free` is always available as a fallback.
export const DEFAULT_PLANS: Array<Omit<Plan, 'createdAt'>> = [
  {
    id: 'free',
    name: 'Free',
    priceCents: 0,
    execQuota: 1000,
    apiCallQuota: 10000,
    storageBytesQuota: 100 * 1024 * 1024,
    seatQuota: 3,
    retentionDays: 7,
  },
  {
    id: 'pro',
    name: 'Pro',
    priceCents: 4900,
    execQuota: 15000,
    apiCallQuota: 150000,
    storageBytesQuota: 2 * 1024 * 1024 * 1024,
    seatQuota: 10,
    retentionDays: 30,
  },
  {
    id: 'business',
    name: 'Business',
    priceCents: 24900,
    execQuota: 100000,
    apiCallQuota: 1000000,
    storageBytesQuota: 20 * 1024 * 1024 * 1024,
    seatQuota: 9999,
    retentionDays: 90,
  },
];

// In-memory fallback plan for when the DB has no rows yet (test paths).
export const FREE_PLAN_FALLBACK: Plan = {
  ...DEFAULT_PLANS[0],
  createdAt: '1970-01-01T00:00:00.000Z',
};

export function seedDefaultPlans(db: Database.Database): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO subscription_plans
      (id, name, price_cents, exec_quota, api_call_quota, storage_bytes_quota, seat_quota, retention_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const p of DEFAULT_PLANS) {
    stmt.run(
      p.id,
      p.name,
      p.priceCents,
      p.execQuota,
      p.apiCallQuota,
      p.storageBytesQuota,
      p.seatQuota,
      p.retentionDays,
    );
  }
}

export function getPlan(db: Database.Database, id: string): Plan | null {
  const row = db
    .prepare('SELECT * FROM subscription_plans WHERE id = ?')
    .get(id) as PlanRow | undefined;
  return row ? rowToPlan(row) : null;
}

export function listPlans(db: Database.Database): Plan[] {
  const rows = db
    .prepare('SELECT * FROM subscription_plans ORDER BY price_cents ASC')
    .all() as PlanRow[];
  return rows.map(rowToPlan);
}
