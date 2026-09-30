# Waypoint broadcast automation + hop limit (#5482) — spec

Requested by a user who broadcasts border-wait-time waypoints for two ports of
entry and needs them to reach a bounded radius, not the whole mesh.

## Decisions (maintainer, 2026-09-30)

| Question | Decision |
|---|---|
| Default hop limit when none is given | The node's **configured** LoRa hop limit (`getConfiguredHopLimit()`), for every waypoint send — UI, REST, rebroadcast scheduler, automation. Replaces today's hardcoded `3`. |
| Maximum hop limit | The node's configured hop limit. A setting can only **lower** reach (`clampHopLimitOverride`, `src/utils/hopLimitOverride.ts`). |
| Minimum interval between automation broadcasts of the same waypoint | **30 minutes**, enforced from the persisted `waypoints.lastBroadcastAt`, never an in-memory field. Saving the automation or restarting MeshMonitor must not re-arm it or count as a send. |
| Re-send when unchanged? | **Configurable per action**: `onlyWhenChanged` (default `false` = send every allowed run). |

## Airtime (for the PR body)

~110-byte packet ≈ 1 s at LongFast. A flood is rebroadcast once by every node
within the hop limit: ~30 transmissions (~30 s) per send on a ~30-node local
mesh at hop 3. At the 30-minute floor that is ≈1.7 % channel use per waypoint;
hop 0 is a single transmission.

## 1. Hop limit on the send path

- `meshtasticProtobufService.createWaypointMessage` takes an optional
  `hopLimit`; drop the hardcoded `3`.
- `meshtasticManager.broadcastWaypoint(waypoint, { ..., hopLimit })` resolves the
  effective value: `clampHopLimitOverride(hopLimit ?? inherit, getConfiguredHopLimit())`.
- `want_ack` stays off for broadcasts. For a DM waypoint with an effective hop
  limit of 0, force `want_ack` off too (firmware rewrites hop 0 on want_ack
  packets to the node default — #5121).
- `broadcastWaypointDelete` uses the waypoint's stored hop limit.

## 2. Persistence (migration 183, all three backends)

- `waypoints.hopLimit` integer, nullable. `NULL` = inherit the node's
  configured value. Idempotent helpers; update hand-written PG/MySQL test DDL
  where a suite uses it.
- The rebroadcast scheduler (`waypointService.rebroadcastTick`) passes the
  stored hop limit.

## 3. REST API (`src/server/routes/waypoints.ts`)

- POST and PATCH accept `hop_limit` (alias `hopLimit`): integer 0–7, or
  `null` to inherit. Validate with the existing `parseHopLimitOverride`; reject
  out-of-range with `fail(res, 400, 'INVALID_HOP_LIMIT', …)`. The stored value
  is what was asked for; the clamp to the device limit happens at send time.
- GET returns `hopLimit`.

## 4. Automation action `action.broadcastWaypoint`

Params (all string fields accept `{{ }}` templates, so a preceding
`action.runScript` with `resultVariable` can supply values):

- `sourceId` (required; a Meshtastic source)
- `waypointKey` (required, string; identifies this automation's waypoint so
  each run UPDATES the same waypoint id instead of creating a new one)
- `latitude`, `longitude` (required, numeric after interpolation, range-checked)
- `name` (≤ 29 bytes after firmware limits — reuse existing waypoint
  validation), `description`, `icon` (emoji), `expireHours` (optional)
- `channel` (0–7), `hopLimit` (optional, same field and clamp as
  `action.sendMessage`'s hop limit — reuse `HOP_LIMIT_FIELD` / `hopLimitParamError`)
- `onlyWhenChanged` (bool, default false)

Behaviour on each run:
1. Resolve the waypoint for `(sourceId, automationId, waypointKey)`. Store the
   mapping so the id is stable across runs and restarts (a small column on
   `waypoints` such as `automationKey`, or an automation variable — pick one,
   persisted).
2. Upsert the waypoint row (owner = local node, not virtual) with the new
   fields and `hopLimit`.
3. **Floor:** if `now - lastBroadcastAt < 30 min`, skip the send and record a
   skipped result with the reason (the row update still happens, so the
   periodic rebroadcaster and the UI see fresh content).
4. If `onlyWhenChanged` and name, description, position, icon, expiry, channel
   and hop limit are unchanged, skip the send.
5. Otherwise `broadcastWaypoint(..., { origin: 'automation', hopLimit })` and
   persist `lastBroadcastAt = now`.
6. Respect TX-disabled / receive-only states the same way `action.sendMessage`
   does.

Validation lives in `src/types/automation.ts` alongside the other actions; the
executor in `src/server/services/automation/actionExecutor.ts`; the real dep in
`meshActionDeps.ts`. The trigger-level `rateLimit` / cooldown still apply on
top.

## 5. UI

- `src/components/automations/catalog.ts`: a catalog entry for the new action
  with the fields above; show a warning next to the hop limit and a note that
  sends are at most once per 30 minutes per waypoint. Tester preview in
  `AutomationTester.tsx`.
- `WaypointEditorModal.tsx`: a hop-limit input (blank = node default), with the
  same warning text used for the message hop limit.
- Locale keys in `public/locales/en.json`.

## Tests

Protobuf hop limit + want_ack; clamp to device value; migration (SQLite + PG +
MySQL containers); REST validation via `createRouteTestApp`; rebroadcast uses
stored hop limit; action: stable id across runs, 30-minute floor survives a
simulated restart (floor read from DB), `onlyWhenChanged`, template
interpolation from a script variable, TX-disabled skip; catalog/editor
component tests.
