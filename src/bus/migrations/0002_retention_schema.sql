-- 0002 Retention schema: fix bus_dead_letters FK and add bus_agent_cursors.
--
-- bus_dead_letters: the original schema had message_id REFERENCES bus_messages(id).
-- With foreign_keys = ON, that FK is IMMEDIATE (checked per statement), so:
--   INSERT INTO bus_dead_letters (message_id, ...)  → FK check: bus_messages row must exist ✓
--   DELETE FROM bus_messages WHERE id = ?           → FK violation: child row still exists ✗
-- Drop and recreate without the FK. Dead letters are a historical log; message_id is a
-- bare integer reference that survives source-message deletion.
-- Denormalized fields are copied at insert time so dead letters are fully self-contained.
DROP TABLE bus_dead_letters;
CREATE TABLE bus_dead_letters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL,
  from_agent  TEXT    NOT NULL,
  to_agent    TEXT,
  topic       TEXT,
  type        TEXT    NOT NULL,
  payload     BLOB    NOT NULL,
  reason      TEXT    NOT NULL,
  recorded_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_dead_letters_recorded ON bus_dead_letters(recorded_at);

-- bus_agent_cursors: per-agent persistent ack cursor.
-- bus_subscriptions rows are deleted on WebSocket close, so the retention cleanup job
-- cannot use them to determine whether a recipient has acked a message. This table
-- survives disconnects and is updated monotonically on every ack op.
CREATE TABLE bus_agent_cursors (
  agent_id          TEXT    PRIMARY KEY,
  last_acked_cursor INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
) STRICT;
