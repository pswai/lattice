/**
 * BrokerProc — manages a Lattice broker subprocess for fault-injection tests.
 *
 * Lifecycle:
 *   BrokerProc.create(agentIds) → fresh tmpdir + DB + tokens + broker started
 *   proc.kill()                 → SIGKILL (immediate, simulates process crash)
 *   proc.stop()                 → SIGTERM + wait (graceful shutdown)
 *   proc.restart()              → kill() + start new process on same DB (new port)
 *   proc.cleanup()              → kill + delete temp dir
 *
 * Port discovery: parse stderr for JSON {"event":"broker_start","port":N},
 * then confirm with GET /readyz before returning from start().
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import http from 'node:http';
import { openDatabase } from '../../src/bus/db.js';
import { runMigrations } from '../../src/bus/migrations.js';
import { mintToken } from '../../src/bus/tokens.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, '../../dist/cli.js');

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGetStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume(); // drain body
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.once('error', reject);
    req.setTimeout(500, () => { req.destroy(new Error('timeout')); });
  });
}

export class BrokerProc {
  port = 0;
  baseUrl = '';
  readonly dbPath: string;
  readonly dir: string;
  private proc: ChildProcess | null = null;
  readonly tokens = new Map<string, string>();
  private readonly agentIds: string[];

  private constructor(dir: string, dbPath: string, agentIds: string[]) {
    this.dir = dir;
    this.dbPath = dbPath;
    this.agentIds = agentIds;
  }

  /**
   * Create a fresh broker with a new temp DB. Tokens are minted for each agentId
   * before the subprocess starts so they're available immediately on connect.
   */
  static async create(agentIds: string[]): Promise<BrokerProc> {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-fault-'));
    const dbPath = join(dir, 'bus.db');

    const db = openDatabase(dbPath);
    runMigrations(db);
    const proc = new BrokerProc(dir, dbPath, agentIds);
    for (const agentId of agentIds) {
      const { plaintext } = mintToken(db, { agent_id: agentId, scope: 'agent' });
      proc.tokens.set(agentId, plaintext);
    }
    db.close();

    await proc.start();
    return proc;
  }

  /**
   * Open a read-only connection to the DB from the test process.
   * Safe to call after kill() — broker is not running.
   * Caller is responsible for closing the returned DB.
   */
  openDb() {
    return openDatabase(this.dbPath);
  }

  async start(): Promise<void> {
    const proc = spawn(
      process.execPath,
      [CLI_PATH, 'start', '--workspace', this.dbPath, '--port', '0'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.proc = proc;

    // Parse port from structured broker_start log line on stderr
    this.port = await new Promise<number>((resolve, reject) => {
      let buf = '';
      const deadline = setTimeout(
        () => reject(new Error('broker did not emit broker_start within 5s')),
        5000,
      );

      proc.stderr!.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as Record<string, unknown>;
            if (obj['event'] === 'broker_start' && typeof obj['port'] === 'number') {
              clearTimeout(deadline);
              resolve(obj['port'] as number);
            }
          } catch {
            // Non-JSON stderr lines — ignore
          }
        }
      });

      proc.once('error', (err) => { clearTimeout(deadline); reject(err); });
      proc.once('exit', (code, signal) => {
        clearTimeout(deadline);
        reject(new Error(`broker exited early (code=${code ?? 'null'}, signal=${signal ?? 'none'})`));
      });
    });

    this.baseUrl = `http://127.0.0.1:${this.port}`;

    // After start promise resolves, re-attach exit handler to null out proc reference
    this.proc.once('exit', () => { this.proc = null; });

    await this.waitReady(3000);
  }

  private async waitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const status = await httpGetStatus(`${this.baseUrl}/readyz`);
        if (status === 200) return;
      } catch {
        // not ready yet
      }
      await sleep(50);
    }
    throw new Error(`broker did not become ready within ${timeoutMs}ms`);
  }

  /** SIGKILL — immediate crash simulation. Does NOT wait for clean shutdown. */
  async kill(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    if (p.exitCode !== null) return; // already exited
    p.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      if (p.exitCode !== null) { resolve(); return; }
      p.once('exit', resolve);
      setTimeout(resolve, 1000); // fallback
    });
  }

  /** SIGTERM — graceful shutdown. Waits for exit, falls back to SIGKILL after 2s. */
  async stop(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    if (p.exitCode !== null) return;
    p.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        p.kill('SIGKILL');
        resolve();
      }, 2000);
      p.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  /**
   * Kill the running broker and start a fresh process on the same DB.
   * After restart, this.port and this.baseUrl are updated to the new address.
   */
  async restart(): Promise<void> {
    await this.kill();
    await sleep(150); // brief pause to let OS release file locks
    await this.start();
  }

  /** Kill (if running) and delete the temp dir. Call in afterAll/afterEach. */
  cleanup(): void {
    if (this.proc) {
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}
