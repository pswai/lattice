import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { BrokerServer } from '../../src/bus/broker.js';
import { runMigrations } from '../../src/bus/migrations.js';
import { runTokenCreate, runTokenRevoke } from '../../src/cli/token.js';
import { createTmpDb, type TmpDb } from '../fixtures/tmp-db.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextFrame(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout: no frame received')), 2000);
    ws.once('message', (data) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch {
        reject(new Error('response is not valid JSON'));
      }
    });
    ws.once('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once('close', () => resolve());
  });
}

// Capture stdout output from a synchronous fn; restore afterwards
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

// Run a fn that is expected to call process.exit(1); capture stderr output
function captureExit1(fn: () => void): string {
  const stderrChunks: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
    throw new Error(`process.exit(${code})`);
  });
  try {
    expect(() => fn()).toThrow('process.exit(1)');
  } finally {
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return stderrChunks.join('');
}

// ── fixture ───────────────────────────────────────────────────────────────────

let tmp: TmpDb;
let broker: BrokerServer;
let port: number;

beforeAll(async () => {
  tmp = createTmpDb();
  runMigrations(tmp.db);

  broker = new BrokerServer(tmp.db);
  await broker.start(0);
  port = broker.address()!.port;
});

afterAll(async () => {
  await broker.close();
  tmp.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── token create → hello succeeds ─────────────────────────────────────────────

describe('token create', () => {
  test('creates a token that authenticates successfully via hello', async () => {
    let plaintext = '';
    const stdout = captureStdout(() => {
      runTokenCreate(['agent-new', '--workspace', tmp.path]);
    });

    // Parse the token from stdout output ("  lat_live_..." line)
    const match = stdout.match(/(lat_(?:live|admin)_\S+)/);
    expect(match).not.toBeNull();
    plaintext = match![1]!;

    // Use the minted token to connect
    const ws = await connect(port);
    const framePromise = nextFrame(ws);
    ws.send(JSON.stringify({ op: 'hello', agent_id: 'agent-new', token: plaintext, protocol_version: 1 }));
    const frame = await framePromise;

    expect(frame.op).toBe('welcome');
    expect(frame.agent_id).toBe('agent-new');

    ws.close();
    await waitForClose(ws);
  });

  test('token row persisted in bus_tokens with correct agent_id and scope', () => {
    captureStdout(() => {
      runTokenCreate(['agent-persisted', '--workspace', tmp.path]);
    });

    const row = tmp.db
      .prepare('SELECT agent_id, scope, revoked_at FROM bus_tokens WHERE agent_id = ?')
      .get('agent-persisted') as { agent_id: string; scope: string; revoked_at: number | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.agent_id).toBe('agent-persisted');
    expect(row!.scope).toBe('agent'); // default scope
    expect(row!.revoked_at).toBeNull();
  });

  test('--scope admin mints an admin-scoped token', () => {
    captureStdout(() => {
      runTokenCreate(['agent-admin', '--workspace', tmp.path, '--scope', 'admin']);
    });

    const row = tmp.db
      .prepare('SELECT scope FROM bus_tokens WHERE agent_id = ?')
      .get('agent-admin') as { scope: string } | undefined;

    expect(row?.scope).toBe('admin');
  });

  test('stdout contains the plaintext token', () => {
    const stdout = captureStdout(() => {
      runTokenCreate(['agent-stdout', '--workspace', tmp.path]);
    });

    expect(stdout).toMatch(/lat_live_/);
    expect(stdout).toContain('save this');
  });

  test('missing agent_id → error + exit 1', () => {
    const stderr = captureExit1(() => {
      runTokenCreate(['--workspace', tmp.path]);
    });
    expect(stderr).toContain('agent_id is required');
  });

  test('missing --workspace → error + exit 1', () => {
    const stderr = captureExit1(() => {
      runTokenCreate(['agent-x']);
    });
    expect(stderr).toContain('--workspace');
  });

  test('workspace file does not exist → error + exit 1', () => {
    const stderr = captureExit1(() => {
      runTokenCreate(['agent-x', '--workspace', '/nonexistent/path/team.db']);
    });
    expect(stderr).toContain('workspace not found');
  });
});

// ── token revoke → hello fails with token_revoked ─────────────────────────────

describe('token revoke', () => {
  test('revoke → subsequent hello returns token_revoked + close', async () => {
    // Create a token via the CLI
    let plaintext = '';
    const stdout = captureStdout(() => {
      runTokenCreate(['agent-to-revoke', '--workspace', tmp.path]);
    });
    const match = stdout.match(/(lat_(?:live|admin)_\S+)/);
    expect(match).not.toBeNull();
    plaintext = match![1]!;

    // Verify it works before revoking
    const ws1 = await connect(port);
    const frame1Promise = nextFrame(ws1);
    ws1.send(JSON.stringify({ op: 'hello', agent_id: 'agent-to-revoke', token: plaintext, protocol_version: 1 }));
    const frame1 = await frame1Promise;
    expect(frame1.op).toBe('welcome');
    ws1.close();
    await waitForClose(ws1);

    // Revoke via the CLI
    const revokeStdout = captureStdout(() => {
      runTokenRevoke([plaintext, '--workspace', tmp.path]);
    });
    expect(revokeStdout).toBe('Revoked.\n');

    // Now hello with the revoked token fails
    const ws2 = await connect(port);
    const frame2Promise = nextFrame(ws2);
    const closePromise = waitForClose(ws2);
    ws2.send(JSON.stringify({ op: 'hello', agent_id: 'agent-to-revoke', token: plaintext, protocol_version: 1 }));
    const [frame2] = await Promise.all([frame2Promise, closePromise]);

    expect(frame2.op).toBe('error');
    expect(frame2.code).toBe('token_revoked');
  });

  test('revoked_at is set in bus_tokens after revoke', () => {
    let plaintext = '';
    captureStdout(() => {
      runTokenCreate(['agent-revoked-check', '--workspace', tmp.path]);
    });
    // get the token hash from DB
    const before = tmp.db
      .prepare('SELECT token_hash, revoked_at FROM bus_tokens WHERE agent_id = ?')
      .get('agent-revoked-check') as { token_hash: string; revoked_at: number | null };
    expect(before.revoked_at).toBeNull();

    // extract plaintext from stdout
    const stdout = captureStdout(() => {
      runTokenCreate(['agent-rev2', '--workspace', tmp.path]);
    });
    const match = stdout.match(/(lat_(?:live|admin)_\S+)/);
    plaintext = match![1]!;

    captureStdout(() => {
      runTokenRevoke([plaintext, '--workspace', tmp.path]);
    });

    const after = tmp.db
      .prepare('SELECT revoked_at FROM bus_tokens WHERE agent_id = ?')
      .get('agent-rev2') as { revoked_at: number | null };
    expect(after.revoked_at).not.toBeNull();
    expect(typeof after.revoked_at).toBe('number');
  });

  test('revoking an unknown token → error + exit 1', () => {
    const stderr = captureExit1(() => {
      runTokenRevoke(['lat_live_doesnotexist', '--workspace', tmp.path]);
    });
    expect(stderr).toContain('token not found');
  });

  test('revoking an already-revoked token → idempotent exit 0, stdout "already revoked"', () => {
    // Create and revoke
    const stdout = captureStdout(() => {
      runTokenCreate(['agent-double-revoke', '--workspace', tmp.path]);
    });
    const match = stdout.match(/(lat_(?:live|admin)_\S+)/);
    const plaintext = match![1]!;

    captureStdout(() => {
      runTokenRevoke([plaintext, '--workspace', tmp.path]);
    });

    // Revoke again → idempotent no-op, exit 0, message on stdout
    const secondStdout = captureStdout(() => {
      runTokenRevoke([plaintext, '--workspace', tmp.path]);
    });
    expect(secondStdout).toContain('already revoked');
  });

  test('missing token argument → error + exit 1', () => {
    const stderr = captureExit1(() => {
      runTokenRevoke(['--workspace', tmp.path]);
    });
    expect(stderr).toContain('token is required');
  });

  test('missing --workspace → error + exit 1', () => {
    const stderr = captureExit1(() => {
      runTokenRevoke(['lat_live_sometoken']);
    });
    expect(stderr).toContain('--workspace');
  });
});
