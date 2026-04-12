import { existsSync, statSync } from 'node:fs';
import type { DB } from './db.js';

// EWMA decay constants.  Both are derived from the continuous-time formula α = 1 − e^(−dt/τ)
// where dt = 5 s (tick interval).
//
// messages_per_sec:        τ = 60 s   → α ≈ 0.0800   (1-minute effective window)
// db_growth_rate_per_day:  τ = 604800 s (7 days) → α ≈ 8.27e-6  (1-week effective window)
const ALPHA_MSG = 1 - Math.exp(-5 / 60);
const ALPHA_DB = 1 - Math.exp(-5 / 604_800);

/**
 * Return the total on-disk footprint of the SQLite database in bytes.
 * Includes the main file plus WAL and SHM sidecar files (present when
 * journal_mode=WAL, which this project always uses).
 * Returns 0 for in-memory databases or if the file is not yet visible to stat.
 */
export function getDbSizeBytes(dbPath: string): number {
  try {
    const main = statSync(dbPath).size;
    const wal = existsSync(dbPath + '-wal') ? statSync(dbPath + '-wal').size : 0;
    const shm = existsSync(dbPath + '-shm') ? statSync(dbPath + '-shm').size : 0;
    return main + wal + shm;
  } catch {
    return 0;
  }
}

export class Metrics {
  // ── In-memory counters ─────────────────────────────────────────────────────
  // messages_total uses an in-memory counter rather than COUNT(*) because retention
  // cleanup deletes rows from bus_messages — a live COUNT would show a
  // shrinking number that doesn't reflect historical throughput.
  messagesTotal = 0;
  replayGapsTotal = 0;
  // inboxFullTotal is reserved for the step-10 back-pressure feature.
  inboxFullTotal = 0;

  // ── EWMA state ─────────────────────────────────────────────────────────────
  private tickMsgCount = 0;
  private ewmaMsgPerSec = 0;
  private ewmaDbGrowthBytesPerDay = 0;
  private prevDbBytes: number | null = null;

  constructor(private readonly dbPath: string) {}

  recordMessage(): void {
    this.messagesTotal++;
    this.tickMsgCount++;
  }

  recordGap(): void {
    this.replayGapsTotal++;
  }

  recordInboxFull(): void {
    this.inboxFullTotal++;
  }

  /**
   * Advance all EWMAs.  Called every 5 s by BrokerServer.
   */
  tick(): void {
    // messages/sec EWMA
    const rate = this.tickMsgCount / 5;
    this.ewmaMsgPerSec = ALPHA_MSG * rate + (1 - ALPHA_MSG) * this.ewmaMsgPerSec;
    this.tickMsgCount = 0;

    // db growth rate EWMA (bytes/day)
    const currentBytes = getDbSizeBytes(this.dbPath);
    if (this.prevDbBytes !== null) {
      // bytes gained in the last 5 s, projected to a day
      const dailyRate = ((currentBytes - this.prevDbBytes) / 5) * 86_400;
      this.ewmaDbGrowthBytesPerDay =
        ALPHA_DB * dailyRate + (1 - ALPHA_DB) * this.ewmaDbGrowthBytesPerDay;
    }
    this.prevDbBytes = currentBytes;
  }

  snapshot(db: DB): {
    messages_total: number;
    messages_per_sec: number;
    replay_gaps_total: number;
    inbox_full_total: number;
    // Dead-letter rows are never deleted, so COUNT(*) is accurate across restarts.
    // Unlike messages_total (which uses an in-memory counter because retention cleanup
    // deletes bus_messages rows, making COUNT(*) unreliable for historical throughput).
    dead_letters_total: number;
    db_size_bytes: number;
    db_growth_rate_bytes_per_day: number;
  } {
    const dlRow = db.prepare('SELECT COUNT(*) AS n FROM bus_dead_letters').get() as {
      n: number;
    };
    return {
      messages_total: this.messagesTotal,
      messages_per_sec: this.ewmaMsgPerSec,
      replay_gaps_total: this.replayGapsTotal,
      inbox_full_total: this.inboxFullTotal,
      dead_letters_total: dlRow.n,
      db_size_bytes: getDbSizeBytes(this.dbPath),
      db_growth_rate_bytes_per_day: this.ewmaDbGrowthBytesPerDay,
    };
  }
}
