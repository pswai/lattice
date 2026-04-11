import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });

const result = spawnSync('npx tsc', { stdio: 'inherit', shell: true });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

cpSync('src/bus/migrations', 'dist/bus/migrations', { recursive: true });

console.log('build: tsc + migration SQL copy complete');
