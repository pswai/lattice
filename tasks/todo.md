# Dashboard Dogfood Fixes

## Issues from User Testing

- [x] **1. Completion rate always 0%** — Fixed: frontend was reading `byStatus` (camelCase) but analytics returns `by_status` (snake_case). Now uses pre-computed `completion_rate` from backend.
- [x] **2. Tooltip too slow** — Fixed: replaced native `title` attr with JS tooltip using existing `.tip` element. Instant display on hover.
- [x] **3. Task graph too wide** — Fixed: separated isolated nodes from connected graph. Connected nodes use hierarchical BFS layout; isolated nodes render in a compact grid below.
- [x] **4. Hash routing** — Fixed: added hash-based routing (`#graph`, `#playbooks`, etc). Refresh and back/forward now work.
- [x] **5. Run button unclear** — Fixed: added confirmation dialog explaining the action, tooltip on hover, and auto-refresh after run.
- [x] **6. Members page** — No backend invite API exists. Members are added via OAuth or direct DB. Read-only by design for now.
- [x] **7. Audit log IP** — Fixed: shows "local" instead of "--" for empty IP. Backend captures IP from X-Forwarded-For/X-Real-IP headers (empty for localhost).
- [x] **8. Usage not working** — Fixed TWO bugs: (1) `setUsageTracking(true)` was never called, so counters were always no-ops. (2) Dashboard snapshot query used wrong column name `period` instead of `period_ym`.
- [x] **9. API Keys page** — Read-only by design (key management requires admin auth). Added help text pointing to admin API.

## Files Changed

- `agenthub/src/dashboard.ts` — completion rate fix, JS tooltip, graph layout, hash routing, run button UX, audit IP display
- `agenthub/src/http/routes/dashboard-snapshot.ts` — fixed `period` -> `period_ym` column name
- `agenthub/src/index.ts` — enabled usage tracking on startup

## Verification

- TypeScript: compiles clean
- Tests: 627/627 passing
