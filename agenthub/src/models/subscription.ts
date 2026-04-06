import type { DbAdapter } from '../db/adapter.js';
import { FREE_PLAN_FALLBACK, type Plan } from './plan.js';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

export interface TeamSubscription {
  teamId: string;
  planId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  status: SubscriptionStatus;
  createdAt: string;
  updatedAt: string;
}

interface SubRow {
  team_id: string;
  plan_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToSub(row: SubRow): TeamSubscription {
  return {
    teamId: row.team_id,
    planId: row.plan_id,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    status: row.status as SubscriptionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getTeamSubscription(
  db: DbAdapter,
  teamId: string,
): Promise<TeamSubscription | null> {
  const row = await db.get<SubRow>(
    'SELECT * FROM team_subscriptions WHERE team_id = ?',
    teamId,
  );
  return row ? rowToSub(row) : null;
}

export interface UpsertSubscriptionInput {
  teamId: string;
  planId: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  status?: SubscriptionStatus;
  periodStart?: string | null;
  periodEnd?: string | null;
}

export async function upsertTeamSubscription(
  db: DbAdapter,
  input: UpsertSubscriptionInput,
): Promise<TeamSubscription> {
  const status = input.status ?? 'active';
  await db.run(`
    INSERT INTO team_subscriptions
      (team_id, plan_id, stripe_customer_id, stripe_subscription_id,
       current_period_start, current_period_end, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id) DO UPDATE SET
      plan_id = excluded.plan_id,
      stripe_customer_id = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      status = excluded.status,
      updated_at = ?
  `,
    input.teamId,
    input.planId,
    input.stripeCustomerId ?? null,
    input.stripeSubscriptionId ?? null,
    input.periodStart ?? null,
    input.periodEnd ?? null,
    status,
    new Date().toISOString(),
  );
  return (await getTeamSubscription(db, input.teamId))!;
}

/**
 * Return the team's plan. If no subscription row exists, fall back to the
 * `free` plan (from the DB if seeded, else the in-memory default).
 */
export async function getTeamPlan(db: DbAdapter, teamId: string): Promise<Plan> {
  const row = await db.get<{
    id: string;
    name: string;
    price_cents: number;
    exec_quota: number;
    api_call_quota: number;
    storage_bytes_quota: number;
    seat_quota: number;
    retention_days: number;
    created_at: string;
  }>(`
    SELECT p.*
    FROM team_subscriptions s
    JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.team_id = ?
  `, teamId);

  if (row) {
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

  // No subscription — return free plan from DB if seeded.
  const free = await db.get<{
    id: string;
    name: string;
    price_cents: number;
    exec_quota: number;
    api_call_quota: number;
    storage_bytes_quota: number;
    seat_quota: number;
    retention_days: number;
    created_at: string;
  }>('SELECT * FROM subscription_plans WHERE id = ?', 'free');

  if (free) {
    return {
      id: free.id,
      name: free.name,
      priceCents: free.price_cents,
      execQuota: free.exec_quota,
      apiCallQuota: free.api_call_quota,
      storageBytesQuota: free.storage_bytes_quota,
      seatQuota: free.seat_quota,
      retentionDays: free.retention_days,
      createdAt: free.created_at,
    };
  }

  return FREE_PLAN_FALLBACK;
}
