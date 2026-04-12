import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });

const result = spawnSync('npx tsc', { stdio: 'inherit', shell: true });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

cpSync('src/bus/migrations', 'dist/bus/migrations', { recursive: true });
chmodSync('dist/cli.js', 0o755);

// Build the TypeScript SDK package
const sdkResult = spawnSync('npx tsc -p packages/sdk-ts/tsconfig.json', {
  stdio: 'inherit',
  shell: true,
});
if (sdkResult.status !== 0) {
  process.exit(sdkResult.status ?? 1);
}

// Build the Claude Code channel shim (depends on sdk-ts dist)
const shimResult = spawnSync('npx tsc -p packages/shim-claude-code/tsconfig.json', {
  stdio: 'inherit',
  shell: true,
});
if (shimResult.status !== 0) {
  process.exit(shimResult.status ?? 1);
}
chmodSync('packages/shim-claude-code/dist/index.js', 0o755);

console.log('build: tsc + migration SQL copy + cli chmod + sdk-ts + shim-claude-code complete');
