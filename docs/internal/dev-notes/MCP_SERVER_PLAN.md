# MCP Server Integration — Design & Implementation Plan

**Status:** Proposed (not yet implemented)
**Issue:** TBD
**Author:** design session 2026-06-25

## Goal

Expose an **optional**, in-process **Model Context Protocol (MCP)** server so that AI
agents (Claude, OpenClaw, etc.) can monitor mesh activity and debug / reconfigure
MeshMonitor and nodes — **always gated by the calling user's existing permissions**.

The MCP server is off by default and enabled via a Docker env var. A connecting agent
authenticates with the user's **existing `mm_v1_` Personal API token** as the HTTP
Bearer; from there the agent inherits exactly that user's capabilities — no more, no
less.

## Decisions (locked)

| Fork | Decision |
|------|----------|
| Topology | **In-process Express route** mounted in the existing server, conditional on env flag. Reuses `requireAPIToken`, `sourceManagerRegistry`, permission checks, and (phase 2) `dataEventEmitter` directly — no IPC, no second container. |
| Capability scope | **Two tiers.** Default = read + safe control. A separate **FULL ACCESS** env flag additionally unlocks destructive ops. *Both tiers are still gated per-call by the user's real permissions* — the env flag is necessary-but-not-sufficient. |
| MCP auth | **Reuse existing `mm_v1_` API tokens.** No new token type. Revocation, audit, and per-source permissions all already work. |
| Realtime | **Tools first (phase 1); streaming notifications phase 2** fed by `dataEventEmitter`. |

## Why these primitives already fit

- **Bearer auth exists.** `requireAPIToken()` (`src/server/auth/authMiddleware.ts:449`)
  validates `Authorization: Bearer mm_v1_...`, attaches `req.user`, and audits. One token
  per user, bcrypt-hashed, revocable (`POST /api/token/generate`, `DELETE /api/token`).
- **CSRF is already Bearer-exempt.** `csrfProtection` (`src/server/middleware/csrf.ts:51`)
  returns `next()` for any `Authorization: Bearer ...` request. A headless MCP client needs
  no CSRF token.
- **Permission gate exists.** `checkPermissionAsync(userId, resource, action, sourceId)` and
  `getUserPermissionSetsBySourceAsync(userId)` (`src/services/database.ts:8491` / `:8588`),
  26 resources × {read, write, viewOnMap}, admin bypass, per-source scoping.
- **Capability surface exists.** `sourceManagerRegistry.getManager(sourceId)` exposes
  send-message, traceroute / position / nodeinfo / telemetry requests, device reboot/config,
  channel mgmt, MeshCore admin CLI; repositories expose all reads; Automation Engine for
  reactive workflows.
- **Realtime exists.** `dataEventEmitter` emits typed `DataEvent`s
  (`message:new`, `telemetry:batch`, `node:updated`, `traceroute:complete`, …) — the phase-2
  push source.

## Dependency

- `@modelcontextprotocol/sdk@^1.29` (pin to 1.x; **ignore main-branch v2 pre-alpha docs**).
  ESM, `.js` subpath imports (matches our NodeNext setup), Node ≥18. Peer `zod` (already a dep).

## Architecture

```
Agent (Claude/OpenClaw)
   │  HTTP POST/GET/DELETE  /mcp   (Streamable HTTP transport)
   │  Authorization: Bearer mm_v1_...
   ▼
[ mcpLimiter ] → [ requireAPIToken ]            ← reuses existing middleware
   │  req.user resolved
   ▼
mcpRouter (src/server/routes/mcpRoutes.ts)
   │  stateful session map: mcp-session-id → { transport, userId }
   ▼
McpServer (built per session, closes over the authenticated user)
   │  each tool/resource handler:
   │    1. assert env tier allows this tool
   │    2. checkPermissionAsync(user.id, resource, action, sourceId)   ← THE gate
   │    3. call the SAME service/manager/repository the REST route uses (in-process, no HTTP loopback)
   ▼
sourceManagerRegistry / databaseService / dataEventEmitter
```

### Mount point

Mount as a **top-level route, NOT under `apiRouter`**, to avoid the shared `apiLimiter`
(tuned for browser bursts) and keep the MCP surface isolated:

```ts
if (env.mcpServerEnabled) {
  app.use(`${BASE_URL}/mcp`, mcpLimiter, requireAPIToken, mcpRouter);
  app.use('/mcp',            mcpLimiter, requireAPIToken, mcpRouter); // BASE_URL-less fallback, mirrors /api
}
```

`requireAPIToken` runs on **every** request (POST init + subsequent POST/GET/DELETE), so the
Bearer is re-validated each time, not just at session init.

### Session + auth binding

Stateful transport (`sessionIdGenerator: () => randomUUID()`), session map keyed by the
`mcp-session-id` header. Bind `sessionId → userId` at init; on every subsequent request assert
the re-validated `req.user.id` matches the session's bound `userId`, else 403. The per-session
`McpServer` is built by `buildMcpServer(user)` and closes over the authenticated user, so every
tool handler has the user without threading `authInfo`.

### Capability tiers

```ts
// env.mcpServerEnabled      → server exists at all (default tier: read + safe control)
// env.mcpFullAccessMode     → ALSO register destructive tools
```

A tool in the full-access tier is only **registered** when `mcpFullAccessMode` is true AND is
still **permission-checked** at call time. So a user without `configuration:write` cannot reboot
a node even in full-access mode.

## Tool / resource surface (phase 1)

Every tool declares `(resource, action)`; the handler runs `checkPermissionAsync` (admin
bypasses) before doing work. Per-source tools take a `sourceId` arg.

### Read tools (tier: default)

| Tool | Perm (resource/action) | Backed by |
|------|------------------------|-----------|
| `list_sources` | `sources`/read (or any) | `sourceManagerRegistry.getAllStatuses()` |
| `list_nodes` | `nodes`/read | nodes repo |
| `get_node` | `nodes`/read | nodes repo |
| `list_messages` | `messages` or `channel_N`/read | messages repo |
| `get_telemetry` | `info`/read | telemetry repo |
| `list_traceroutes` | `traceroute`/read | traceroutes repo |
| `list_neighbors` | `info`/read | neighbors repo |
| `list_channels` | `nodes`/read | channels repo |
| `get_dashboard` | `dashboard`/read | unified dashboard service |
| `list_packets` | `packetmonitor`/read | packet log service |
| `list_automations` | `automations`/read | automations repo |
| `get_recent_activity` | union of granted reads | recent rows across messages/nodes/traceroutes (phase-1 polling stand-in for streaming) |

### Safe-control tools (tier: default)

| Tool | Perm | Backed by |
|------|------|-----------|
| `send_message` | `messages` or `channel_N`/write | `manager.sendTextMessage(...)` |
| `request_traceroute` | `traceroute`/write | `manager.sendTraceroute(...)` |
| `request_position` | `nodes`/write | `manager.sendPositionRequest(...)` |
| `request_telemetry` | `info`/write (or `nodes`/write) | `manager.sendTelemetryRequest(...)` |
| `request_nodeinfo` | `nodes`/write | `manager.sendNodeInfoRequest(...)` |

### Full-access tools (tier: FULL ACCESS only, still permission-checked)

| Tool | Perm | Backed by |
|------|------|-----------|
| `reboot_node` | `configuration`/write | `manager` reboot |
| `set_device_config` | `configuration`/write | `manager` config |
| `manage_node` (ignore/purge) | `nodes`/write | nodes service |
| `manage_channel` (create/update/delete) | `nodes`/write (+ `channel_database` for PSK) | channels service |
| `meshcore_admin_cli` | `remote_admin`/write | meshcore admin route logic |
| `manage_automation` (create/update/enable/disable) | `automations`/write | automation engine |

> **Guardrail:** `action.runScript` automations and `meshcore_admin_cli` are the sharpest edges.
> They require: full-access env flag **AND** the relevant write permission **AND** are flagged in
> the tool description as destructive. The existing MeshCore "danger guard" still applies.

### Resources (phase 1, read-only context)

- `meshmonitor://status` — overall + per-source status
- `meshmonitor://sources` — source list
- `meshmonitor://nodes/{sourceId}` — node list for a source
- `meshmonitor://messages/{sourceId}` — recent messages for a source

Resource reads enforce the same permission checks as the equivalent read tool.

## Phase 2 (streaming, separate PR)

- Declare `capabilities.resources.subscribe = true`.
- Track per-session subscriptions; subscribe a `dataEventEmitter` listener per MCP session.
- On `message:new` / `node:updated` / `telemetry:batch` / `traceroute:complete`, call
  `server.server.sendResourceUpdated({ uri })` for subscribed URIs (filtered by the session
  user's permitted sources/resources).
- Clean up the emitter listener in `transport.onclose`.

## Files to add / change (phase 1)

**Add:**
- `src/server/mcp/mcpServerFactory.ts` — `buildMcpServer(user)`; registers tools/resources by tier; central permission-check helper `requireMcpPermission(user, resource, action, sourceId)`.
- `src/server/mcp/tools/*.ts` — tool implementations grouped (reads, safeControl, fullAccess), each calling existing services/managers.
- `src/server/mcp/resources.ts` — resource registrations.
- `src/server/routes/mcpRoutes.ts` — Express router: session map, POST/GET/DELETE handlers, session↔user binding.
- `src/server/middleware/rateLimiters.ts` — add `mcpLimiter`.
- Tests: `src/server/mcp/*.test.ts` — permission-gating (denied/allowed/admin), tier-gating (full-access tool absent in default mode), session↔user mismatch rejection.

**Change:**
- `src/server/config/environment.ts` — add `mcpServerEnabled` (`ENABLE_MCP_SERVER`, default false) and `mcpFullAccessMode` (`MCP_FULL_ACCESS`, default false) via `parseBoolean`, plus optional `mcpRateLimit`.
- `src/server/server.ts` — conditional mount (see above); log a clear banner when enabled (and a louder one when full-access is on).
- `package.json` / `package-lock.json` — add `@modelcontextprotocol/sdk`.
- `CLAUDE.md` + `docs/` — document the env vars, the security model, and how to point an MCP client at `/mcp`.
- Version bump across the five version files per the release rule.

## Security model (explicit)

1. **Off by default.** No `/mcp` route exists unless `ENABLE_MCP_SERVER=true`.
2. **Bearer = user identity.** The agent is the user; it cannot exceed that user's permissions.
3. **Per-call permission checks**, not just at connect — every tool re-checks `checkPermissionAsync` with the right `(resource, action, sourceId)`.
4. **Destructive ops double-gated**: full-access env flag **and** write permission.
5. **Audit**: `requireAPIToken` already audit-logs token use; tool invocations should also write to the audit log (resource = `mcp`, includes tool name + sourceId).
6. **Revocation is instant**: revoking the API token kills all the agent's access on the next request (re-validated each call).
7. **Rate-limited** via a dedicated `mcpLimiter`.

## Open questions for implementation

- Audit granularity: one audit row per tool call, or sampled? (Lean: one per write/destructive call, debounce reads.)
- `get_recent_activity` shape — unified cross-source feed vs per-source. (Lean: unified, capped, `since` cursor.)
- Whether to expose a `whoami`/`capabilities` tool returning the user's `getUserPermissionSetsBySourceAsync` so the agent can self-discover what it may do. (Lean: yes — cheap, improves agent behavior.)
