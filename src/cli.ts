#!/usr/bin/env node

/**
 * Lattice CLI — `npx lattice <command>`
 *
 * Subcommands:
 *   init     Set up a new team (created by cli-dev-1)
 *   status   Show server health, stats, and recent events
 */

import { createInterface } from 'node:readline';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
};

function green(s: string) { return `${c.green}${s}${c.reset}`; }
function red(s: string) { return `${c.red}${s}${c.reset}`; }
function yellow(s: string) { return `${c.yellow}${s}${c.reset}`; }
function cyan(s: string) { return `${c.cyan}${s}${c.reset}`; }
function bold(s: string) { return `${c.bold}${s}${c.reset}`; }
function dim(s: string) { return `${c.dim}${s}${c.reset}`; }

// ── HTTP helper ───────────────────────────────────────────────────────────────

interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
}

function fetch(url: string, headers: Record<string, string> = {}): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ ok: res.statusCode! >= 200 && res.statusCode! < 300, status: res.statusCode!, body });
      });
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ── readline helper ──────────────────────────────────────────────────────────

function ask(rl: ReturnType<typeof createInterface>, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` ${dim(`(${defaultVal})`)}` : '';
  return new Promise((res) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      res(answer.trim() || defaultVal || '');
    });
  });
}

// ── init command ─────────────────────────────────────────────────────────────

async function initCommand(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(bold('\n  Lattice Setup\n'));

  // 1. Team name
  const workspaceName = await ask(rl, 'Team name', 'My Team');
  const defaultId = workspaceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || `team-${randomBytes(4).toString('hex')}`;
  const workspaceId = await ask(rl, 'Team ID (lowercase, hyphens ok)', defaultId);

  if (!/^[a-z0-9_-]+$/.test(workspaceId)) {
    console.error(red('\n  Team ID must be lowercase letters, numbers, hyphens, or underscores.\n'));
    rl.close();
    process.exit(1);
  }

  // 2. DB path
  const dbPath = await ask(rl, 'Database path', './data/lattice.db');
  const resolvedDbPath = resolvePath(dbPath);

  // 3. Port
  const portStr = await ask(rl, 'Server port', '3000');
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(red('\n  Invalid port number.\n'));
    rl.close();
    process.exit(1);
  }

  rl.close();

  // 4. Create DB + team + API key
  console.log(dim('\n  Initializing database...'));
  const { createSqliteAdapter } = await import('./db/connection.js');
  const adapter = createSqliteAdapter(resolvedDbPath);

  const existing = await adapter.get<{ id: string }>('SELECT id FROM workspaces WHERE id = ?', workspaceId);
  if (existing) {
    console.log(yellow(`  Team "${workspaceId}" already exists — generating a new API key.\n`));
  } else {
    await adapter.run('INSERT INTO workspaces (id, name) VALUES (?, ?)', workspaceId, workspaceName);
    console.log(green(`  Team "${workspaceId}" created.`));
  }

  const rawKey = `lt_${randomBytes(24).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  await adapter.run('INSERT INTO api_keys (workspace_id, key_hash, label, scope) VALUES (?, ?, ?, ?)', workspaceId, keyHash, 'cli-init', 'write');
  await adapter.close();

  console.log(green('  API key generated.\n'));

  // 5. Output .mcp.json snippet
  const mcpSnippet = {
    mcpServers: {
      lattice: {
        type: 'sse',
        url: `http://localhost:${port}/mcp`,
        headers: {
          Authorization: `Bearer ${rawKey}`,
        },
      },
    },
  };

  console.log('  ' + dim('━'.repeat(48)));
  console.log(bold('\n  Add this to your .mcp.json:\n'));
  const jsonLines = JSON.stringify(mcpSnippet, null, 2).split('\n');
  for (const line of jsonLines) {
    console.log(`  ${cyan(line)}`);
  }
  console.log('\n  ' + dim('━'.repeat(48)));

  // 6. Getting started
  console.log(`
  ${bold('Getting Started')}

  1. Start the server:
     ${cyan(`DB_PATH=${dbPath} PORT=${port} npx lattice start`)}

  2. Add the .mcp.json snippet above to your project.

  3. Your agents can now use Lattice MCP tools:
     ${dim('register_agent, broadcast, save_context, get_context,')}
     ${dim('create_task, update_task, send_message, get_messages')}

  4. See the agent preamble template at:
     ${dim('.claude/agents/lattice-agent.md')}
`);
}

// ── start command ────────────────────────────────────────────────────────────

async function startCommand(): Promise<void> {
  await import('./index.js');
}

// ── status command ────────────────────────────────────────────────────────────

function resolveBaseUrl(): string {
  return process.env.LATTICE_URL || 'http://localhost:3000';
}

async function statusCommand(): Promise<void> {
  const baseUrl = resolveBaseUrl();
  const adminKey = process.env.ADMIN_KEY;
  const apiKey = process.env.LATTICE_API_KEY;

  console.log(bold('\n  Lattice Status\n'));

  // 1. Health check
  let healthy = false;
  try {
    const res = await fetch(`${baseUrl}/health`);
    healthy = res.ok;
  } catch {
    healthy = false;
  }

  const badge = healthy
    ? `${c.bgGreen}${c.bold}${c.white} OK ${c.reset}`
    : `${c.bgRed}${c.bold}${c.white} DOWN ${c.reset}`;
  console.log(`  Server:  ${badge}  ${dim(baseUrl)}`);

  if (!healthy) {
    console.log(red('\n  Server is not reachable. Is Lattice running?\n'));
    process.exit(1);
  }

  // 2. Admin stats (optional — only if ADMIN_KEY is set)
  if (adminKey) {
    try {
      const res = await fetch(`${baseUrl}/admin/stats`, { Authorization: `Bearer ${adminKey}` });
      if (res.ok) {
        const stats = JSON.parse(res.body) as {
          teams: number;
          active_agents: number;
          context_entries: number;
          events: number;
          tasks: Record<string, number>;
        };

        console.log('');
        console.log(`  ${bold('Teams:')}           ${cyan(String(stats.teams))}`);
        console.log(`  ${bold('Active agents:')}   ${cyan(String(stats.active_agents))}`);
        console.log(`  ${bold('Context entries:')} ${cyan(String(stats.context_entries))}`);
        console.log(`  ${bold('Events:')}          ${cyan(String(stats.events))}`);

        // Task breakdown
        const taskEntries = Object.entries(stats.tasks);
        if (taskEntries.length > 0) {
          const taskLine = taskEntries
            .map(([status, count]) => {
              const color = status === 'completed' ? green : status === 'escalated' ? red : yellow;
              return `${color(String(count))} ${status}`;
            })
            .join(dim(' · '));
          console.log(`  ${bold('Tasks:')}           ${taskLine}`);
        } else {
          console.log(`  ${bold('Tasks:')}           ${dim('none')}`);
        }
      } else {
        console.log(yellow(`\n  ⚠ Admin stats: HTTP ${res.status} (check ADMIN_KEY)`));
      }
    } catch (err) {
      console.log(yellow(`\n  ⚠ Could not fetch admin stats: ${(err as Error).message}`));
    }
  } else {
    console.log(dim('\n  Set ADMIN_KEY to see server stats'));
  }

  // 3. Recent events (optional — only if LATTICE_API_KEY is set)
  if (apiKey) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/events?limit=5`, { Authorization: `Bearer ${apiKey}` });
      if (res.ok) {
        const data = JSON.parse(res.body) as {
          events: Array<{
            id: number;
            eventType: string;
            message: string;
            createdBy: string;
            createdAt: string;
          }>;
        };

        if (data.events.length > 0) {
          console.log(`\n  ${bold('Recent events:')}\n`);
          for (const evt of data.events) {
            const ts = new Date(evt.createdAt);
            const timeStr = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
            const typeColor = evt.eventType === 'ERROR' ? red
              : evt.eventType === 'ESCALATION' ? yellow
              : evt.eventType === 'LEARNING' ? green
              : cyan;
            const truncMsg = evt.message.length > 80 ? evt.message.slice(0, 77) + '...' : evt.message;
            console.log(`  ${dim(timeStr)}  ${typeColor(evt.eventType.padEnd(11))}  ${bold(evt.createdBy.padEnd(16))}  ${truncMsg}`);
          }
        } else {
          console.log(dim('\n  No recent events'));
        }
      } else {
        console.log(yellow(`\n  ⚠ Events: HTTP ${res.status} (check LATTICE_API_KEY)`));
      }
    } catch (err) {
      console.log(yellow(`\n  ⚠ Could not fetch events: ${(err as Error).message}`));
    }
  } else {
    console.log(dim('  Set LATTICE_API_KEY to see recent events'));
  }

  console.log('');
}

// ── CLI router ────────────────────────────────────────────────────────────────

const USAGE = `
  ${bold('Usage:')} npx lattice <command>

  ${bold('Commands:')}
    init      Create a new team and get API keys
    start     Start the Lattice server
    status    Show server health, stats, and recent events

  ${bold('Environment variables:')}
    LATTICE_URL       Server URL (default: http://localhost:3000)
    ADMIN_KEY          Admin key for server stats
    LATTICE_API_KEY   Team API key for events
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'status':
      await statusCommand();
      break;
    case 'init':
      await initCommand();
      break;
    case 'start':
      await startCommand();
      break;
    case '--help':
    case '-h':
    case undefined:
      console.log(USAGE);
      break;
    default:
      console.error(red(`Unknown command: ${command}`));
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(red(`Fatal: ${err.message}`));
  process.exit(1);
});
