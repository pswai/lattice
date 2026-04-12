-- Webhook registrations: broker POSTs to registered URL on message arrival.
CREATE TABLE bus_webhooks (
  agent_id TEXT PRIMARY KEY,
  url      TEXT NOT NULL,
  secret   TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
