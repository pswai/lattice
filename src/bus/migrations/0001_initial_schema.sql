-- 0001 Initial schema for Lattice v0.2.0 broker.
-- See RFC 0002 §Schema.

CREATE TABLE bus_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent      TEXT NOT NULL,
  to_agent        TEXT,
  topic           TEXT,
  type            TEXT NOT NULL,
  payload         BLOB NOT NULL,
  idempotency_key TEXT,
  correlation_id  TEXT,
  created_at      INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_bus_msg_recipient ON bus_messages(to_agent, id);
CREATE INDEX idx_bus_msg_topic     ON bus_messages(topic, id);
CREATE INDEX idx_bus_msg_created   ON bus_messages(created_at);

CREATE TABLE bus_subscriptions (
  agent_id          TEXT NOT NULL,
  connection_id     TEXT NOT NULL,
  last_acked_cursor INTEGER NOT NULL DEFAULT 0,
  connected_at      INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  PRIMARY KEY (agent_id, connection_id)
) STRICT;
CREATE INDEX idx_bus_sub_agent ON bus_subscriptions(agent_id);

CREATE TABLE bus_topics (
  agent_id TEXT NOT NULL,
  topic    TEXT NOT NULL,
  PRIMARY KEY (agent_id, topic)
) STRICT;
CREATE INDEX idx_bus_topics_topic ON bus_topics(topic);

CREATE TABLE bus_dead_letters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES bus_messages(id),
  reason      TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
) STRICT;

CREATE TABLE bus_tokens (
  token_hash TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  scope      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX idx_bus_tokens_agent ON bus_tokens(agent_id);
