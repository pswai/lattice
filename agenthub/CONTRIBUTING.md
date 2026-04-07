# Contributing to Lattice

Thanks for your interest in contributing! Lattice is an MCP-native coordination layer for AI agent teams, and we welcome contributions of all kinds.

## Quick Start

```bash
# Clone and install
git clone https://github.com/pswai/lattice.git
cd lattice
npm install

# Build
npm run build

# Run tests
npm test

# Start the server
npm start
```

## Development Setup

**Prerequisites:**
- Node.js 20+
- npm 10+

**Project structure:**
```
src/
  cli.ts          # CLI commands (init, start, status)
  index.ts        # Server bootstrap
  config.ts       # Environment configuration
  db/             # Database layer (SQLite + Postgres)
  http/           # Hono HTTP routes + middleware
  mcp/            # MCP server (35 tools)
  models/         # Data access layer
  services/       # Background services
dashboard/        # React 19 + Tailwind frontend
tests/            # Vitest test suites
docs/             # Documentation
examples/         # Usage examples
```

**Building the dashboard:**
```bash
cd dashboard && npm install && npm run build
```

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run a specific test file
npx vitest run tests/tasks.test.ts
```

Tests use in-memory SQLite databases, so they're fast and require no external setup.

## Making Changes

1. **Fork the repo** and create a feature branch from `main`
2. **Write tests** for any new functionality
3. **Run the full test suite** before submitting (`npm test`)
4. **Keep changes focused** — one feature or fix per PR
5. **Follow existing patterns** — look at similar code for style guidance

## Code Style

- TypeScript strict mode
- All inputs validated with Zod schemas
- Use the structured logger (`getLogger()`) instead of `console.log`
- Error types: `AppError`, `ValidationError`, `AuthError`
- Tests go in `tests/` with the naming pattern `feature-name.test.ts`

## Commit Messages

Use descriptive commit messages:
```
feat: add task priority filtering to list_tasks
fix: handle FTS query with special characters
test: add coverage for webhook retry logic
docs: update getting-started with Docker instructions
```

## Pull Request Process

1. Update documentation if your change affects user-facing behavior
2. Add or update tests as needed
3. Ensure all tests pass and the build succeeds
4. Describe what your PR does and why in the description
5. Link any related issues

## Reporting Bugs

Open a GitHub issue with:
- Steps to reproduce
- Expected vs actual behavior
- Lattice version and environment (Node.js version, OS)

## Feature Requests

Open a GitHub issue describing:
- The problem you're trying to solve
- Your proposed solution
- Any alternatives you considered

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
