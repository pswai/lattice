import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/worktrees/**',
      // Fault-injection harness runs as a separate CI step via `npm run test:fault`.
      // Excluded here so `npm test` stays fast (< 30s) and fault iterations don't
      // count against the default test budget.
      'tests/fault-injection/**',
    ],
  },
});
