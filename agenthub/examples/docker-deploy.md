# Deploying Lattice with Docker

Lattice ships with a Dockerfile and `docker-compose.yml` so you can run the
full stack (HTTP API + MCP endpoint + dashboard) with one command. SQLite data
is persisted to a host-mounted volume.

## Prerequisites

- Docker 20.10+ and Docker Compose v2
- A shell with `curl` for the smoke tests below

## 1. Clone and enter the repo

```bash
git clone https://github.com/your-org/tools-for-ai.git
cd tools-for-ai/lattice
```

## 2. Set your admin key

The admin endpoints (`/admin/*`) are used to create teams and mint API keys.
They are gated by `ADMIN_KEY`. Do **not** leave it on the default.

Either export it in your shell:

```bash
export ADMIN_KEY="$(openssl rand -hex 32)"
```

…or drop a `.env` file next to `docker-compose.yml`:

```bash
echo "ADMIN_KEY=$(openssl rand -hex 32)" > .env
```

## 3. Bring up the stack

```bash
docker compose up -d --build
```

First build compiles TypeScript inside a `node:20-alpine` builder stage and
copies only `dist/` + production `node_modules` into the runtime image.

## 4. Health check

```bash
curl http://localhost:3000/health
# => {"status":"ok"}
```

Docker also runs the same check internally every 30 seconds — watch it with:

```bash
docker compose ps
```

## 5. Create your first team

The admin routes use bearer auth with your `ADMIN_KEY`.

```bash
curl -X POST http://localhost:3000/admin/teams \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"my-team","name":"My Team"}'
```

Response:

```json
{ "team_id": "my-team", "api_key": "ah_<64-hex-chars>" }
```

**Save the `api_key`** — it is shown only once. If you lose it, mint a new one:

```bash
curl -X POST http://localhost:3000/admin/teams/my-team/keys \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label":"laptop"}'
```

## 6. Use the API key

Every `/api/v1/*` request needs the team API key:

```bash
curl http://localhost:3000/api/v1/tasks \
  -H "Authorization: Bearer ah_<your-key>"
```

Point your MCP clients at `http://localhost:3000/mcp` with the same bearer
token.

## 7. Open the dashboard

Visit [http://localhost:3000/dashboard](http://localhost:3000/dashboard) in a
browser to see live tasks, agents, events, and context for your team.

## Data persistence

The SQLite DB lives at `./data/lattice.db` on the host (mounted into the
container at `/data`). Back it up with a plain file copy while the container
is stopped, or use `sqlite3 lattice.db ".backup backup.db"` while it runs.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `DB_PATH` | `/data/lattice.db` | SQLite file path inside the container |
| `ADMIN_KEY` | *(required)* | Bearer token for `/admin/*` routes |
| `EVENT_RETENTION_DAYS` | `30` | How long events are kept before cleanup |

## Updating

```bash
git pull
docker compose up -d --build
```

The volume survives rebuilds, so tasks, context, and API keys are preserved.

## Tearing down

```bash
docker compose down          # stop containers, keep data
docker compose down -v       # stop and remove the data volume too
```
