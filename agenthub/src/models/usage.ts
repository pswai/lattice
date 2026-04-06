import type { DbAdapter } from '../db/adapter.js';
import { getTeamPlan } from './subscription.js';
import type { Plan } from './plan.js';

// Module-level flag. When false, increment calls are no-ops — this lets
// us keep the exec-counter wiring safely disabled in tests by default.
let usageTrackingEnabled = false;

export function setUsageTracking(enabled: boolean): void {
  usageTrackingEnabled = enabled;
}

export function isUsageTrackingEnabled(): boolean {
  return usageTrackingEnabled;
}

export function currentPeriodYm(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export interface UsageRow {
  periodYm: string;
  execCount: number;
  apiCallCount: number;
  storageBytes: number;
  updatedAt: string;
}

interface CounterRow {
  team_id: string;
  period_ym: string;
  exec_count: number;
  api_call_count: number;
  storage_bytes: number;
  updated_at: string;
}

export interface IncrementInput {
  exec?: number;
  apiCall?: number;
  storageBytes?: number;
}

/**
 * Add to the current-period counters for a team. UPSERTs the row.
 * No-op when usage tracking is disabled (test default).
 */
export async function incrementUsage(
  db: DbAdapter,
  teamId: string,
  input: IncrementInput,
): Promise<void> {
  if (!usageTrackingEnabled) return;
  const exec = input.exec ?? 0;
  const apiCall = input.apiCall ?? 0;
  const storage = input.storageBytes ?? 0;
  if (exec === 0 && apiCall === 0 && storage === 0) return;
  const periodYm = currentPeriodYm();
  await db.run(`
    INSERT INTO usage_counters
      (team_id, period_ym, exec_count, api_call_count, storage_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id, period_ym) DO UPDATE SET
      exec_count = exec_count + excluded.exec_count,
      api_call_count = api_call_count + excluded.api_call_count,
      storage_bytes = storage_bytes + excluded.storage_bytes,
      updated_at = ?
  `, teamId, periodYm, exec, apiCall, storage, new Date().toISOString(), new Date().toISOString());
}

/** Force an increment regardless of the global flag — used by the quota
 *  middleware's post-response api_call_count bump. */
export async function incrementUsageForced(
  db: DbAdapter,
  teamId: string,
  input: IncrementInput,
): Promise<void> {
  const exec = input.exec ?? 0;
  const apiCall = input.apiCall ?? 0;
  const storage = input.storageBytes ?? 0;
  if (exec === 0 && apiCall === 0 && storage === 0) return;
  const periodYm = currentPeriodYm();
  await db.run(`
    INSERT INTO usage_counters
      (team_id, period_ym, exec_count, api_call_count, storage_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id, period_ym) DO UPDATE SET
      exec_count = exec_count + excluded.exec_count,
      api_call_count = api_call_count + excluded.api_call_count,
      storage_bytes = storage_bytes + excluded.storage_bytes,
      updated_at = ?
  `, teamId, periodYm, exec, apiCall, storage, new Date().toISOString(), new Date().toISOString());
}

export async function getUsage(
  db: DbAdapter,
  teamId: string,
  periodYm?: string,
): Promise<UsageRow> {
  const period = periodYm ?? currentPeriodYm();
  const row = await db.get<CounterRow>(
    'SELECT * FROM usage_counters WHERE team_id = ? AND period_ym = ?',
    teamId, period,
  );
  if (!row) {
    return {
      periodYm: period,
      execCount: 0,
      apiCallCount: 0,
      storageBytes: 0,
      updatedAt: '',
    };
  }
  return {
    periodYm: row.period_ym,
    execCount: row.exec_count,
    apiCallCount: row.api_call_count,
    storageBytes: row.storage_bytes,
    updatedAt: row.updated_at,
  };
}

export interface UsageWithLimits {
  period: string;
  usage: UsageRow;
  limits: Plan;
  soft: boolean;
  hard: boolean;
}

export async function getCurrentUsageWithLimits(
  db: DbAdapter,
  teamId: string,
): Promise<UsageWithLimits> {
  const usage = await getUsage(db, teamId);
  const plan = await getTeamPlan(db, teamId);

  const ratios = [
    plan.execQuota > 0 ? usage.execCount / plan.execQuota : 0,
    plan.apiCallQuota > 0 ? usage.apiCallCount / plan.apiCallQuota : 0,
    plan.storageBytesQuota > 0 ? usage.storageBytes / plan.storageBytesQuota : 0,
  ];
  const max = Math.max(...ratios);

  return {
    period: usage.periodYm,
    usage,
    limits: plan,
    soft: max >= 0.8,
    hard: max >= 1,
  };
}
