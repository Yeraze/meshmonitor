# Automation Engine — Simulated System-Test Proposal (#3653)

**Status:** proposal • **Scope:** end-to-end tests that exercise triggers + condition
sets **without real Meshtastic/MeshCore hardware**.

The engine already has strong *unit* coverage (graph eval, condition evaluator,
trigger context, compile/decompile, geofence, apprise notifyDirect, …). What is
missing is **system-level** coverage: an automation, created through the real HTTP
API and loaded by the running engine, actually fires against a realistic event and
produces the expected side effect + run-log row — across all three DB backends.

---

## 1. The harness problem

The current `tests/system-tests.sh` suite drives the app over HTTP but depends on a
**real node** (TCP virtual node / firmware) or live MQTT to produce mesh events.
That is too slow and flaky for exercising the automation matrix, because:

- The engine is **event-driven** off `dataEventEmitter` (`message:new`,
  `node:updated`, `telemetry:batch`, `connection:status`). There is **no HTTP route**
  today that injects a synthetic event, and **no manual-fire / dry-run endpoint** on
  `automationRoutes.ts`.
- MQTT injection is indirect: decryption, the 1-second telemetry batch window, and
  node-hydration timing make assertions racy.
- Schedule / system / geofence triggers can't be produced by sending a chat message
  at all.

### Recommended substrate: a gated **simulate** endpoint

Add one test-oriented route (also genuinely useful as a "Test this automation"
button in the UI):

```
POST /api/automations/simulate        (requirePermission('automations','write'))
  body: { event: { kind, ...fields }, automationId? }
  → { fired: [{ automationId, status, steps }], evaluated: N }
```

`kind` ∈ `message | nodeUpdated | nodeDiscovered | telemetry | system | geofence`.
Internally it builds the same `TriggerContext` the live path uses and calls the
matching engine entry point (`onMessage` / `onNode` / `onTelemetry` / `onSystem` /
`checkGeofences`), but with a **recording ActionDeps** (and a stub NodeDataProvider
seeded from the request or DB) so no real IO occurs and the response carries exactly
which automations fired and every action step.

Why this over MQTT: **deterministic** (no batching/timing), **total trigger
coverage** (system/schedule/geofence included), and it doubles as a shippable
feature. Gate writes behind the existing `automations:write` permission; optionally
require `NODE_ENV==='test'` or an `AUTOMATION_SIMULATE_ENABLED` flag to keep the
no-IO recording mode out of production.

> Alternative if we don't want a new endpoint: stand up a Mosquitto container, create
> an `mqtt_broker` source via `POST /api/sources`, and publish crafted packets. Keep
> this as a *second*, smaller suite that proves the real ingestion → engine path, but
> don't build the bulk of the matrix on it.

Each test follows the same shape:

1. `POST /api/automations` (config JSON) → enable.
2. `POST /api/automations/simulate` with a crafted event (or publish via MQTT).
3. Assert the response **and** `GET /api/automations/:id/runs` (status + log).
4. For real-IO E2E variants, assert the side effect (outbound message recorded, node
   favorited, variable row written, apprise POST received by a stub server).

Reuse `scripts/api-test.sh` for auth/CSRF; reuse the `down -v` volume teardown from
`system-tests.sh`; run the matrix once per backend (SQLite default, then
`DATABASE_URL` postgres/mysql) for parity.

---

## 2. Test-case matrix

Legend: **[S]** simulate-endpoint test (fast, deterministic) · **[E2E]** full
real-IO path · **[DB]** run on all three backends for parity.

### 2.1 Trigger coverage

| # | Trigger | Case | Expected |
|---|---------|------|----------|
| T1 | message | `textContains:"ping"` matches `"ping me"` | fires; non-match `"hello"` does not | [S] |
| T2 | message | `regex:"^(test\|ping)"` | fires on `test`, not on `xtest`; invalid regex never matches | [S] |
| T3 | message | `channel`/`from` filters | only fires for matching channel & sender | [S] |
| T4 | message | DM vs broadcast (`isDM`/`isBroadcast` fields) | both routable | [S] |
| T5 | nodeDiscovered | new node | fires once | [S] |
| T6 | nodeUpdated | `changed` includes `latitude` | fires; condition can read `changed` | [S] |
| T7 | telemetry | `telemetryType:"batteryLevel"` filter | fires only for battery, not voltage | [S] |
| T8 | telemetry | no filter | fires for any metric | [S] |
| T9 | schedule | cron tick (simulate fire) | runs without a mesh event | [S] |
| T10 | system | `event:"bootup"` | fires on bootup, **not** on source-connected (prefilter) | [S] |
| T11 | system | `event:"source-connected"` / `"source-disconnected"` | fires only on its event | [S] |
| T12 | system | `event:"upgrade-available"` | fires; `trigger.latestVersion`/`currentVersion` available | [S] |
| T13 | geofence | enter: outside→inside | baseline (1st sighting) no-fire; enter fires once; no re-fire while inside | [S] |
| T14 | geofence | exit: inside→outside | fires on crossing only | [S] |
| T15 | geofence | dwell: inside→inside | fires while remaining inside | [S] |

### 2.2 Condition coverage

| # | Condition | Case | Expected |
|---|-----------|------|----------|
| C1 | numeric (event field) | `hops == 0` on a zero-hop message | true-branch taken | [S] |
| C2 | numeric (node field) | `node.batteryLevel < 20` (hydrated node) | routes on hydrated value | [S] |
| C3 | numeric (telemetry field) | `telemetry.temperature > 30` | reads latest telemetry for subject node | [S] |
| C4 | numeric (var operand) | `value > {{ var.threshold }}` using a `readonly` constant var | compares against stored var | [S] |
| C5 | numeric | every op `== != > < >= <=` | each evaluated correctly | [S] |
| C6 | string | `node.longName contains "Base"`; `node.shortName`, `node.roleName eq "ROUTER"` | matches hydrated strings | [S] |
| C7 | string | all ops `contains/eq/startsWith/endsWith/regex/notContains` | each correct; bad regex = no match | [S] |
| C8 | sourceFilter | `sourceIds:["srcA"]` | continues for srcA, blocks srcB; empty = any | [S][DB] |
| C9 | distance | `within 5km` / `farther than 5km` of a point | haversine threshold both directions | [S] |
| C10 | variable | flag set vs unset (`is set / true`) | welcome-once style routing | [S] |
| C11 | variable | numeric compare on an integer var | routes correctly | [S] |
| C12 | timeRange | inside window `08:00–20:00`; outside; **wrap-around** `22:00–06:00` | correct for all three | [S] |

### 2.3 Flow / map-reduce coverage

| # | Case | Expected |
|---|------|----------|
| F1 | linear single-rule (no combine) | trigger→cond→action chain runs | [S] |
| F2 | If/Else (`port:true`/`port:false`) | correct branch executes, other skipped | [S] |
| F3 | fanout + collapse **ANY** | proceeds if any sub-rule true | [S] |
| F4 | collapse **ALL** | proceeds only if all true | [S] |
| F5 | collapse **NONE** | proceeds only if none true | [S] |
| F6 | `flow.setVar` set / increment / clear | variable row reflects op | [S][DB] |
| F7 | `flow.setVar` **flag** + TTL | flag auto-clears after duration (clock-injected) → anti-spam | [S] |
| F8 | per-node flag isolation | node A welcomed once; node B independent | [S][DB] |
| F9 | `maxActions` cap | run stops at cap, logged | [S] |

### 2.4 Action coverage

| # | Action | Case | Expected |
|---|--------|------|----------|
| A1 | tapback | replies with emoji; replyId = trigger packetId; DM vs channel routing | recorded send w/ emoji flag | [S], [E2E] |
| A2 | sendMessage | channel default = trigger channel; explicit channel; DM to `{{ trigger.from }}`; reply-to-trigger; `{{ }}` interpolation | correct destination/text | [S], [E2E] |
| A3 | nodeManage | favorite / ignore / delete subject node | manager called / DB row gone | [S], [E2E][DB] |
| A4 | notify (apprise) | success → completed run | POST hits stub apprise `/notify` with title/body/type | [E2E] |
| A5 | notify | failure (apprise 4xx/timeout) → **failed** run-log step | run status `failed` | [S] |
| A6 | notify | `urls` newline/comma list + interpolation | parsed into array, forwarded | [S] |

### 2.5 Engine / lifecycle semantics

| # | Case | Expected |
|---|------|----------|
| L1 | cooldown | second event within `cooldownSeconds` does not fire; after window fires | [S] |
| L2 | run-log | completed vs failed status + serialized steps + `triggerEvent` | [S][DB] |
| L3 | invalid/unparseable config | skipped on `load()`, doesn't break others | [S] |
| L4 | enable/disable | disabled automation doesn't fire; re-enable reloads engine | [S][DB] |
| L5 | import | imported automation lands **disabled** for review | [DB] |
| L6 | variable scope persistence | global / source / node / sourceNode rows isolated and survive reload | [DB] |
| L7 | permission gating | non-admin lacking `automations` perm → 403 on CRUD + simulate | [E2E] |
| L8 | catalog | `GET /api/automations/catalog` returns triggers/conditions/actions incl. geofence, upgrade-available | [E2E] |

### 2.6 Real-ingestion smoke (MQTT, small)

| # | Case | Expected |
|---|------|----------|
| M1 | create `mqtt_broker` source, publish a text packet, automation `textContains` fires | run row appears | [E2E][DB-sqlite] |
| M2 | publish telemetry packet → telemetry trigger + numeric condition fires | run row appears | [E2E] |

---

## 3. Suggested file layout

```
tests/automation/
  lib.sh                     # helpers: create/enable automation, simulate event, poll runs, assert status
  test-triggers.sh           # T1–T15
  test-conditions.sh         # C1–C12
  test-flow-mapreduce.sh     # F1–F9
  test-actions.sh            # A1–A6 (apprise stub container for A4)
  test-lifecycle.sh          # L1–L8
  test-mqtt-ingest.sh        # M1–M2
```

- An **apprise stub** = tiny HTTP server returning 200/4xx on `/notify`, captured for
  assertions (A4/A6). A `mosquitto` container covers M1–M2.
- Wire these into `system-tests.sh` behind an `automation-tests` step, gated by the
  existing `system-test` PR label so they run in CI alongside the rest.

## 4. Build order

1. **Simulate endpoint** (`POST /api/automations/simulate`) + recording deps — the
   substrate everything else needs.
2. `lib.sh` + `test-triggers.sh` + `test-conditions.sh` (highest value, pure
   deterministic).
3. `test-flow-mapreduce.sh`, `test-actions.sh`, `test-lifecycle.sh`.
4. Apprise stub + MQTT ingest smoke.
5. Multi-backend parity pass ([DB] rows) and CI wiring.
