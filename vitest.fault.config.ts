import { defineConfig } from 'vitest/config';

// Separate vitest config for the fault-injection harness.
// Used by `npm run test:fault`; NOT included in the default `npm test` run.
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/fault-injection/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/worktrees/**'],
    testTimeout: 15000,
    pool: 'forks', // each test file gets its own process — important for subprocess management
  },
});
