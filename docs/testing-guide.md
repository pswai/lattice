# Lattice v0.2.0 — Real-World Testing Guide

This document walks through setting up a clean environment and running end-to-end tests across real AI agent hosts. It validates all four receive contracts from RFC 0002.

## Prerequisites

- **Node.js 20+** (`node --version`)
- **npm** (comes with Node)
- **Git** with the `next` branch checked out
- **SQLite 3.45+** (bundled via `better-sqlite3`; no system install needed)
- Hosts to test: Claude Code, Codex CLI, Antigravity, Ollama (any subset works)

## Step 1: Build from scratch

```bash
git checkout next
npm ci
npm run build
npm test                  # 148 tests, ~5s
npm run test:fault        # 100 fault iterations, ~160s (optional but recommended)
```

If either fails, stop — the broker isn't healthy.

## Step 2: Create a workspace

```bash
# Pick a workspace location
export LATTICE_WORKSPACE="$HOME/.lattice/team.db"
mkdir -p "$(dirname "$LATTICE_WORKSPACE")"

./dist/cli.js init "$LATTICE_WORKSPACE"
```

Save the admin token printed to stdout. You'll need it to mint agent tokens.

```
First admin token (save this — it will not be shown again):

  lat_admin_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Step 3: Create agent tokens

One token per agent. Name them meaningfully:

```bash
# Claude Code agent
./dist/cli.js token create claude-code-agent --workspace "$LATTICE_WORKSPACE"
# → lat_live_...  (save this as CLAUDE_CODE_TOKEN)

# Codex CLI agent
./dist/cli.js token create codex-agent --workspace "$LATTICE_WORKSPACE"
# → lat_live_...  (save this as CODEX_TOKEN)

# Antigravity agent
./dist/cli.js token create antigravity-agent --workspace "$LATTICE_WORKSPACE"
# → lat_live_...  (save this as ANTIGRAVITY_TOKEN)

# Ollama SDK agent (script-based)
./dist/cli.js token create ollama-agent --workspace "$LATTICE_WORKSPACE"
# → lat_live_...  (save this as OLLAMA_TOKEN)

# Webhook agent (optional)
./dist/cli.js token create webhook-agent --workspace "$LATTICE_WORKSPACE"
# → lat_live_...  (save this as WEBHOOK_TOKEN)
```

## Step 4: Start the broker

```bash
./dist/cli.js start \
  --workspace "$LATTICE_WORKSPACE" \
  --port 8787 \
  --retention-days 30 \
  --inbox-limit 10000
```

Verify it's running:

```bash
curl http://127.0.0.1:8787/healthz    # → {"status":"ok"}
curl http://127.0.0.1:8787/readyz     # → {"status":"ready"}
curl http://127.0.0.1:8787/bus_stats  # → JSON with 9 fields
```

Leave this terminal running. All subsequent steps use separate terminals.

---

## Contract 1: Claude Code (channel shim)

### Setup

The Claude Code channel shim runs as an MCP server that Claude Code spawns. Configure it in your Claude Code MCP settings (`.mcp.json` or via Claude Code settings UI):

```json
{
  "mcpServers": {
    "lattice": {
      "command": "node",
      "args": ["<absolute-path-to-repo>/packages/shim-claude-code/dist/index.js"],
      "env": {
        "LATTICE_URL": "ws://127.0.0.1:8787",
        "LATTICE_AGENT_ID": "claude-code-agent",
        "LATTICE_TOKEN": "<CLAUDE_CODE_TOKEN>",
        "LATTICE_TOPICS": "team-chat,ci-alerts"
      }
    }
  }
}
```

> ⚠️ **Experimental channels required.** Until the shim is on Anthropic's curated allowlist, Claude Code needs `--dangerously-load-development-channels` when launched. This flag is only needed for the channel notification feature — MCP tools work without it.

### Test scenarios

**T1.1 — Tool availability:**

In a Claude Code session, ask:
> "What Lattice tools are available?"

Expected: the model sees `lattice_send_message` and `lattice_subscribe` tools.

**T1.2 — Send from Claude Code:**

In Claude Code:
> "Use lattice_send_message to send a direct message to 'codex-agent' with type 'direct' and payload {\"hello\": \"from claude code\"}"

Verify in the broker logs (stderr output from step 4):
```json
{"level":"info","event":"send","from":"claude-code-agent","to":"codex-agent",...}
```

**T1.3 — Receive in Claude Code (channel push):**

From another terminal, send a message TO claude-code-agent using the SDK:

```bash
node -e "
import { Bus } from './packages/sdk-ts/dist/index.js';
const bus = new Bus({
  url: 'ws://127.0.0.1:8787',
  agentId: 'ollama-agent',
  token: '<OLLAMA_TOKEN>',
});
await bus.connect();
bus.send({ to: 'claude-code-agent', type: 'direct', payload: { ping: 'hello from SDK' } });
setTimeout(() => bus.close(), 1000);
"
```

Expected: Claude Code receives the message via channel notification. The model's next turn should include a `<channel source="lattice" from="ollama-agent" ...>` tag in its context (visible if channels are enabled).

**T1.4 — Topic subscription + broadcast:**

In Claude Code:
> "Subscribe to the 'team-chat' topic using lattice_subscribe"

Then from another terminal:
```bash
node -e "
import { Bus } from './packages/sdk-ts/dist/index.js';
const bus = new Bus({
  url: 'ws://127.0.0.1:8787',
  agentId: 'ollama-agent',
  token: '<OLLAMA_TOKEN>',
});
await bus.connect();
bus.send({ topic: 'team-chat', type: 'broadcast', payload: { msg: 'team standup in 5' } });
setTimeout(() => bus.close(), 1000);
"
```

Expected: Claude Code receives the broadcast via channel notification.

---

## Contract 2: Generic MCP (Codex CLI, Antigravity, etc.)

### Setup

The generic MCP shim runs as a stdio MCP server. Configure it in each host's MCP settings.

**Codex CLI** (add to Codex's MCP config):
```json
{
  "mcpServers": {
    "lattice": {
      "command": "node",
      "args": ["<absolute-path-to-repo>/packages/shim-mcp/dist/index.js"],
      "env": {
        "LATTICE_URL": "ws://127.0.0.1:8787",
        "LATTICE_AGENT_ID": "codex-agent",
        "LATTICE_TOKEN": "<CODEX_TOKEN>",
        "LATTICE_TOPICS": "team-chat"
      }
    }
  }
}
```

**Antigravity** (same pattern, different agent ID):
```json
{
  "mcpServers": {
    "lattice": {
      "command": "node",
      "args": ["<absolute-path-to-repo>/packages/shim-mcp/dist/index.js"],
      "env": {
        "LATTICE_URL": "ws://127.0.0.1:8787",
        "LATTICE_AGENT_ID": "antigravity-agent",
        "LATTICE_TOKEN": "<ANTIGRAVITY_TOKEN>",
        "LATTICE_TOPICS": "team-chat"
      }
    }
  }
}
```

### Test scenarios

**T2.1 — Tool listing:**

In Codex CLI or Antigravity, verify the agent sees three tools: `lattice_wait`, `lattice_send_message`, `lattice_subscribe`.

**T2.2 — Send from MCP host:**

Ask the agent:
> "Use lattice_send_message to send {\"status\": \"ready\"} to 'claude-code-agent' as a direct message"

Verify broker logs show the send event from `codex-agent` (or `antigravity-agent`).

**T2.3 — Receive via `lattice_wait`:**

From another terminal, send a message to the MCP agent:

```bash
node -e "
import { Bus } from './packages/sdk-ts/dist/index.js';
const bus = new Bus({
  url: 'ws://127.0.0.1:8787',
  agentId: 'claude-code-agent',
  token: '<CLAUDE_CODE_TOKEN>',
});
await bus.connect();
bus.send({ to: 'codex-agent', type: 'direct', payload: { task: 'review PR #42' } });
setTimeout(() => bus.close(), 1000);
"
```

Then ask the agent:
> "Check for new Lattice messages using lattice_wait with timeout_ms 5000"

Expected: the tool returns the message with `from: 'claude-code-agent'`, `payload: {task: 'review PR #42'}`, `pending_messages: 0`.

**T2.4 — Cross-host conversation:**

Set up a back-and-forth:
1. Claude Code sends to `codex-agent` via `lattice_send_message`
2. Codex calls `lattice_wait`, sees the message
3. Codex replies via `lattice_send_message` to `claude-code-agent`
4. Claude Code receives via channel push

This validates real bidirectional agent-to-agent messaging.

**T2.5 — Topic broadcast across hosts:**

All three hosts (Claude Code, Codex, Antigravity) subscribe to `team-chat`. Send from any one:
> "Send a broadcast to topic 'team-chat' with payload {\"announcement\": \"deploy complete\"}"

Verify all three receive the broadcast (Claude Code via channel, Codex/Antigravity via `lattice_wait`).

---

## Contract 3: Native SDK agent (Ollama or custom script)

### Setup

For hosts that don't speak MCP natively (like Ollama), or for custom agents, use the TypeScript SDK directly. Write a small agent script:

```typescript
// agents/ollama-bridge.ts
import { Bus } from '../packages/sdk-ts/dist/index.js';

const bus = new Bus({
  url: process.env.LATTICE_URL ?? 'ws://127.0.0.1:8787',
  agentId: process.env.LATTICE_AGENT_ID ?? 'ollama-agent',
  token: process.env.LATTICE_TOKEN!,
});

await bus.connect();
console.log('Connected to Lattice broker');

bus.subscribe(['team-chat']);

// Forward incoming Lattice messages to Ollama (or any local LLM)
for await (const msg of bus.messages()) {
  console.log(`[${msg.from}] ${JSON.stringify(msg.payload)}`);
  
  // Example: forward to Ollama's API for a response
  // const response = await fetch('http://localhost:11434/api/generate', {
  //   method: 'POST',
  //   body: JSON.stringify({ model: 'llama3', prompt: JSON.stringify(msg.payload) }),
  // });
  // const reply = await response.json();
  
  // Reply back through Lattice
  // bus.send({ to: msg.from, type: 'direct', payload: { reply: reply.response } });
}
```

Run:
```bash
LATTICE_TOKEN="<OLLAMA_TOKEN>" npx tsx agents/ollama-bridge.ts
```

### Test scenarios

**T3.1 — SDK connect + subscribe:**

Run the bridge script. Verify broker logs show `welcome` for `ollama-agent`.

**T3.2 — SDK receive:**

Send from Claude Code or Codex to `ollama-agent`. Verify the bridge script prints the message.

**T3.3 — SDK send + round-trip:**

Uncomment the reply logic in the bridge script. Send from another agent → bridge receives → bridge replies via SDK → original sender receives.

**T3.4 — Reconnect after broker restart:**

1. Kill the broker (Ctrl+C)
2. Restart the broker
3. The SDK agent should reconnect automatically (visible in logs: "reconnecting" + "welcome")
4. Send a message to the SDK agent — it should receive it

---

## Contract 4: Webhook agent

### Setup

Start a webhook receiver (a simple HTTP server that logs incoming POSTs):

```bash
node -e "
import http from 'node:http';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    console.log('WEBHOOK:', JSON.stringify({
      sig: req.headers['x-lattice-signature'],
      msgId: req.headers['x-lattice-message-id'],
      body: JSON.parse(body),
    }, null, 2));
    res.writeHead(200).end('ok');
  });
});
server.listen(9999, () => console.log('Webhook receiver on :9999'));
"
```

Register the webhook (direct SQL for MVP — CLI command is post-MVP):

```bash
sqlite3 "$LATTICE_WORKSPACE" "
  INSERT INTO bus_webhooks (agent_id, url, secret, created_at)
  VALUES ('webhook-agent', 'http://127.0.0.1:9999/webhook', 'my-webhook-secret', unixepoch() * 1000);
"
```

### Test scenarios

**T4.1 — Webhook delivery:**

Note: webhook dispatch is not yet wired into the broker's live send path — it's implemented as a standalone function `dispatchWebhook()`. To test manually:

```bash
node -e "
import { openDatabase } from './dist/bus/index.js';
import { runMigrations } from './dist/bus/index.js';
import { dispatchWebhook } from './dist/bus/index.js';
const db = openDatabase('$HOME/.lattice/team.db');
runMigrations(db);
const result = await dispatchWebhook(
  db, 1, 'webhook-agent', { alert: 'disk usage 90%' },
  'monitoring-agent', 'event', null, null, Date.now()
);
console.log('Delivered:', result);
db.close();
"
```

Expected: the webhook receiver prints the POST body with HMAC signature.

**T4.2 — Verify HMAC signature:**

The webhook receiver should verify the signature:
```javascript
import crypto from 'node:crypto';
const expected = crypto.createHmac('sha256', 'my-webhook-secret')
  .update(rawBody, 'utf8').digest('hex');
const received = req.headers['x-lattice-signature'].replace('sha256=', '');
console.log('Signature valid:', expected === received);
```

---

## Multi-host conversation test (the "golden path")

This is the end-to-end test that proves v0.2.0 works:

### Participants
| Agent | Host | Contract | Transport |
|-------|------|----------|-----------|
| `claude-code-agent` | Claude Code | Contract 1 | Channel push |
| `codex-agent` | Codex CLI | Contract 2 | `lattice_wait` poll |
| `antigravity-agent` | Antigravity | Contract 2 | `lattice_wait` poll |
| `ollama-agent` | SDK script | Contract 3 | Native WebSocket |

### Scenario

1. **All agents subscribe to `team-chat` topic** (via their respective tools/SDK).

2. **Claude Code broadcasts:** "Everyone, I'm starting the code review for PR #42."
   ```
   lattice_send_message(topic: "team-chat", type: "broadcast", payload: {task: "review PR #42"})
   ```

3. **Verify all 3 other agents receive the broadcast.**
   - Codex: `lattice_wait` returns the broadcast
   - Antigravity: `lattice_wait` returns the broadcast
   - Ollama bridge: prints the broadcast to console

4. **Codex replies directly to Claude Code:**
   ```
   lattice_send_message(to: "claude-code-agent", type: "direct", payload: {status: "reviewing now"})
   ```

5. **Claude Code receives the reply** via channel push.

6. **Kill the broker.** Wait 5 seconds. Restart the broker.

7. **All agents reconnect automatically** (SDK-based agents within 10-30s; MCP shims restart on next tool call).

8. **Ollama agent sends to `team-chat`** after reconnect.

9. **All agents receive the post-reconnect broadcast.**

### What to verify

- Messages arrive at the correct recipients (no misdirection)
- Topic broadcasts reach ALL subscribers
- Direct messages reach ONLY the named recipient
- Messages arrive in order (per-recipient FIFO)
- Reconnect works transparently (no manual intervention)
- `bus_stats` reflects the live state (connections_active = N, messages_total incrementing)
- Structured logs in the broker stderr show every event

---

## Observability during testing

While tests run, monitor:

```bash
# Live stats (poll every 5s)
watch -n 5 'curl -s http://127.0.0.1:8787/bus_stats | python3 -m json.tool'

# Live structured logs (already streaming on broker stderr)
# Look for: welcome, send, ack, replay_start, replay_gap, close, dead_letter

# Database inspection
sqlite3 "$LATTICE_WORKSPACE" "
  SELECT COUNT(*) AS total_messages FROM bus_messages;
  SELECT COUNT(*) AS dead_letters FROM bus_dead_letters;
  SELECT agent_id, last_acked_cursor FROM bus_agent_cursors;
  SELECT agent_id, topic FROM bus_topics;
  SELECT agent_id, url FROM bus_webhooks;
"
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `lattice_wait` always returns null | Agent token doesn't match the `to` field | Verify LATTICE_AGENT_ID matches what senders use in `to:` |
| "unauthorized" on connect | Bad or revoked token | Re-create with `lattice token create` |
| Channel notifications don't appear in Claude Code | Missing `--dangerously-load-development-channels` | Restart Claude Code with the flag |
| "unsupported_protocol_version" | SDK/shim version mismatch with broker | Rebuild all: `npm run build` |
| Broker exits on start | Port already in use | Use `--port 0` for auto-assign, or check `lsof -i :8787` |
| Messages not delivered after reconnect | SDK reconnect backoff (10-30s) | Wait up to 30s; check broker logs for `welcome` |
| `bus_stats` shows 0 messages_total | Counter is in-memory, resets on broker restart | Normal — only monotonic within a process lifetime |
| Webhook not receiving | No row in `bus_webhooks` | Check registration: `sqlite3 ... "SELECT * FROM bus_webhooks"` |

---

## Environment variable reference

All shims and SDK agents accept these:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LATTICE_URL` | Yes | — | WebSocket URL, e.g. `ws://127.0.0.1:8787` |
| `LATTICE_AGENT_ID` | Yes | — | This agent's identity |
| `LATTICE_TOKEN` | Yes | — | Bearer token from `lattice token create` |
| `LATTICE_TOPICS` | No | — | Comma-separated topics to subscribe at startup |
| `LATTICE_CHANNEL_SOURCE` | No | `lattice` | Source tag in channel notifications (E2 only) |

Broker CLI flags:

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--workspace <path>` | — | — | SQLite DB path (required) |
| `--port <n>` | `LATTICE_PORT` | `8787` | Listen port (0 for auto) |
| `--host <addr>` | — | `127.0.0.1` | Listen address |
| `--retention-days <n\|forever>` | `LATTICE_RETENTION_DAYS` | `30` | Message retention |
| `--inbox-limit <n>` | `LATTICE_INBOX_LIMIT` | `10000` | Per-agent inbox depth cap |
