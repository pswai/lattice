import type { DB } from './db.js';

export type RetentionDays = number | 'forever';

type ExpiredMsg = {
  id: number;
  to_agent: string | null;
  topic: string | null;
};

/**
 * Run one retention-cleanup pass against the database.
 *
 * Algorithm (atomic — everything runs in a single transaction):
 *  - Skip if retentionDays === 'forever'.
 *  - Select messages whose created_at < (now − retentionDays × 86400 s).
 *  - For each expired message:
 *      • If every intended recipient has last_acked_cursor ≥ message.id in
 *        bus_agent_cursors → DELETE (fully acked, safe to remove).
 *      • Otherwise → INSERT INTO bus_dead_letters (reason = 'retention_expired')
 *        THEN DELETE FROM bus_messages.  INSERT before DELETE so the source row
 *        still exists when the INSERT executes (no FK issue since 0002 removed the
 *        FK, but the row copy via INSERT...SELECT requires the row to exist).
 *
 * "No current subscribers" for a topic message is treated as fully acked → DELETE.
 * Rationale: if nobody subscribes to the topic anymore, nobody can receive the
 * message; recording it as a dead letter would misrepresent it as a delivery failure.
 */
export function runRetentionCleanup(
  db: DB,
  retentionDays: RetentionDays,
): { deleted: number; deadLettered: number } {
  if (retentionDays === 'forever') return { deleted: 0, deadLettered: 0 };

  const cutoff = Date.now() - retentionDays * 86_400_000;
  const now = Date.now();

  // Prepare all statements outside the transaction for efficiency.
  const getExpired = db.prepare<[number], ExpiredMsg>(
    'SELECT id, to_agent, topic FROM bus_messages WHERE created_at < ?',
  );

  // Direct: recipient acked iff they have a bus_agent_cursors row with cursor >= msg.id.
  // No row → never acked (treat cursor as 0).
  const isDirectAcked = db.prepare<[string, number], { n: 1 }>(
    'SELECT 1 AS n FROM bus_agent_cursors WHERE agent_id = ? AND last_acked_cursor >= ?',
  );

  // Topic: any subscriber who has NOT acked?
  // LEFT JOIN so agents with no cursor row appear with NULL (= not acked).
  // NOT EXISTS (this query) → all acked (or no subscribers) → fully acked → DELETE.
  const hasUnackedSubscriber = db.prepare<[string, number], { n: 1 }>(`
    SELECT 1 AS n
    FROM bus_topics t
    WHERE t.topic = ?
      AND NOT EXISTS (
        SELECT 1 FROM bus_agent_cursors c
        WHERE c.agent_id = t.agent_id
          AND c.last_acked_cursor >= ?
      )
  `);

  // Copy message fields via INSERT ... SELECT so the dead-letter row is self-contained.
  const insertDeadLetter = db.prepare<[number, number]>(`
    INSERT INTO bus_dead_letters
      (message_id, from_agent, to_agent, topic, type, payload, reason, recorded_at)
    SELECT id, from_agent, to_agent, topic, type, payload, 'retention_expired', ?
    FROM bus_messages
    WHERE id = ?
  `);

  const deleteMsg = db.prepare<[number]>('DELETE FROM bus_messages WHERE id = ?');

  let deleted = 0;
  let deadLettered = 0;

  db.transaction(() => {
    const expired = getExpired.all(cutoff);

    for (const msg of expired) {
      let fullyAcked: boolean;

      if (msg.to_agent !== null) {
        fullyAcked = isDirectAcked.get(msg.to_agent, msg.id) !== undefined;
      } else if (msg.topic !== null) {
        // fullyAcked when NO un-acked subscriber exists
        fullyAcked = hasUnackedSubscriber.get(msg.topic, msg.id) === undefined;
      } else {
        // No intended recipient (schema invariant: shouldn't happen); delete safely.
        fullyAcked = true;
      }

      if (!fullyAcked) {
        insertDeadLetter.run(now, msg.id);
        deadLettered++;
      } else {
        deleted++;
      }

      deleteMsg.run(msg.id);
    }
  })();

  return { deleted, deadLettered };
}

/**
 * Parse the --retention-days / LATTICE_RETENTION_DAYS value.
 *  - undefined or 'forever' → 'forever'
 *  - positive integer string → number
 *  - anything else → throws
 */
export function parseRetentionDays(raw: string | undefined): RetentionDays {
  if (raw === undefined || raw === 'forever') return 'forever';
  const n = Number.parseInt(raw, 10);
  if (!Number.isNaN(n) && n > 0 && String(n) === raw.trim()) return n;
  throw new Error(
    `invalid --retention-days value: '${raw}' (expected positive integer or 'forever')`,
  );
}
