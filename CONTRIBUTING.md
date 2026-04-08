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

## How to Add a New MCP Tool

Lattice uses a declarative registry pattern for MCP tools. You define a `ToolDefinition` object and the framework handles authentication, audit logging, tier filtering, error handling, and secret scanning automatically.

### Step 1: Define the tool

Create or open a domain file under `src/mcp/tools/`. Each file exports an array of `ToolDefinition` objects. The interface is defined in `src/mcp/tools/types.ts`:

```ts
export interface ToolDefinition {
  name: string;                // Tool name (snake_case, e.g. "archive_task")
  description: string;         // Human-readable description shown to the agent
  schema: Record<string, z.ZodTypeAny>;  // Zod schema for input parameters
  tier: ToolTier;              // "automation" | "persist" | "coordinate" | "observe"
  write?: boolean;             // If true, requires write scope on the API key
  autoRegister?: boolean;      // If true, auto-registers the calling agent
  secretScan?: string[];       // Field names to scan for leaked secrets
  handler: (ctx: ToolContext, params: Record<string, unknown>) => Promise<unknown>;
}
```

The handler receives a `ToolContext` with:

- `db` -- the database adapter (`DbAdapter`)
- `workspaceId` -- the authenticated workspace
- `agentId` -- the calling agent's identity

### Step 2: Write the tool definition

Here is a concrete example of adding a hypothetical `archive_task` tool. Create the definition in `src/mcp/tools/tasks.ts` (or a new file if it belongs to a new domain):

```ts
import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { archiveTask } from '../../models/tasks.js';

export const archiveTools: ToolDefinition[] = [
  {
    name: 'archive_task',
    description: 'Archive a completed task so it no longer appears in active listings.',
    schema: {
      agent_id: z.string().min(1).describe('Your agent identity'),
      task_id: z.number().describe('ID of the task to archive'),
    },
    tier: 'coordinate',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return archiveTask(ctx.db, ctx.workspaceId, params.task_id as number);
    },
  },
];
```

### Step 3: Register the tool

Import the tool array in `src/mcp/server.ts` and spread it into the `registerTools()` call:

```ts
import { archiveTools } from './tools/archives.js';

registerTools(server, db, [
  ...contextTools,
  ...taskTools,
  ...archiveTools,   // <-- add here
  // ...
], enabledTiers);
```

The registration loop in `src/mcp/tools/registry.ts` takes care of the rest:

- **Auth**: extracts workspace and agent identity from the MCP auth context.
- **Write scope**: blocks the call if `write: true` and the key lacks write scope.
- **Auto-registration**: registers the agent on first use when `autoRegister: true`.
- **Secret scanning**: checks fields listed in `secretScan` for leaked API keys before the handler runs.
- **Audit**: writes an audit log entry for tools that appear in the audit map.
- **Tier filtering**: skips registration if the tool's tier is not enabled via the `LATTICE_TOOLS` environment variable.
- **Error handling**: catches `AppError` and returns structured MCP error responses.

### Field reference

| Field | Required | Default | Purpose |
|---|---|---|---|
| `name` | yes | -- | Unique tool name (snake_case) |
| `description` | yes | -- | Shown to agents; be specific about what the tool does |
| `schema` | yes | -- | Zod schema object; each key becomes a tool parameter |
| `tier` | yes | -- | Controls which tier group the tool belongs to |
| `write` | no | `false` | Require write scope on the API key |
| `autoRegister` | no | `false` | Auto-register the calling agent if not already known |
| `secretScan` | no | `undefined` | List of field names to scan for leaked secrets |
| `handler` | yes | -- | Async function that implements the tool logic |

### Tips

- If your tool accepts array parameters from MCP clients, use the `arrayParam()` helper from `src/mcp/tools/helpers.js` to handle clients that stringify arrays.
- Add an entry to `TOOL_AUDIT_MAP` in `src/mcp/tools/registry.ts` if your tool performs a mutation that should be audit-logged.
- Write tests in `tests/` following the existing pattern (e.g. `tests/tasks.test.ts`).

## How to Add a New HTTP Route

HTTP routes follow the factory pattern: a function that accepts `db: DbAdapter` and returns a `Hono` router instance.

### Step 1: Create the route file

Create a new file under `src/http/routes/`. Use the naming convention `domain.ts` (e.g. `src/http/routes/archives.ts`):

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import { validate, optionalInt, requireInt } from '../validation.js';

const CreateArchiveSchema = z.object({
  task_id: z.number(),
  reason: z.string().max(500).optional(),
});

export function createArchiveRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = validate(CreateArchiveSchema, body);
    const { workspaceId, agentId } = c.get('auth');
    // ... call model layer ...
    return c.json(result, 201);
  });

  router.get('/:id', async (c) => {
    const id = requireInt(c.req.param('id'), 'id', { min: 1 });
    const limit = optionalInt(c.req.query('limit'), 'limit', { min: 1 });
    // ... call model layer ...
    return c.json(result);
  });

  return router;
}
```

### Step 2: Mount in the app

Import and mount the router in `src/http/app.ts` inside the authenticated `api` group:

```ts
import { createArchiveRoutes } from './routes/archives.js';

// Inside createApp(), alongside other api.route() calls:
api.route('/archives', createArchiveRoutes(db));
```

This gives your routes the path prefix `/api/v1/archives` and ensures they run behind the auth, rate-limit, and audit middleware.

### Validation helpers

All three helpers are in `src/http/validation.ts`:

- `validate(schema, body)` -- parse a request body against a Zod schema. Throws `ValidationError` with field-level details on failure.
- `optionalInt(raw, name, opts?)` -- parse an optional query/path param as an integer. Returns `undefined` when absent.
- `requireInt(raw, name, opts?)` -- parse a required query/path param as an integer. Throws `ValidationError` when missing or invalid.

Both `optionalInt` and `requireInt` accept an optional `{ min }` constraint.

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
