# Automation Engine — Design & Implementation Plan

**Issue:** #3653
**Status:** Planning (pre-implementation)
**Author:** design pass with Yeraze, 2026-06-22

A generic, user-creatable automation engine (Home Assistant / Node-RED inspired) that
replaces the "one hardcoded form per automation type" model with a flexible
trigger → condition → action graph. The legacy hardcoded automations ("Beginner Mode")
keep running unchanged; the new engine is the "Advanced Mode" and ships alongside them.

---

## 1. Decisions (locked with Yeraze)

| Topic | Decision |
|-------|----------|
| **Editor data model** | Full **graph** schema (`nodes[]` + `edges[]`) from day one. |
| **Editor UI v1** | Constrained **linear single-chain** editor over the graph schema. Canvas + Fanout/Collapse unlock in a later UI pass — no schema rewrite. |
| **Scoping** | **Global** automations (NOT per-source). A dedicated global **`automations` permission**. A **source-filter condition block** scopes a workflow to a subset of sources when desired. Deliberate exception to the per-source invariant (joins `channel_database`, `estimated_positions`). |
| **State** | **Full stateful workflows**, but **split**: Phase **1a** = synchronous runs (cooldowns + single-run variables, no waits). Phase **1b** = persisted `flow.delay`/wait-for-event + cross-event variables + restart rehydration. |
| **Branching** | **If / ElseIf / Else** replaces hardcoded routing matrices (esp. the ~15-key auto-ack matrix). Conditions are **routers with `true`/`false` ports**; ElseIf = cascaded conditions. UI shows a friendly If/ElseIf/Else widget compiling to labeled condition edges. |
| **Scripts** | **Deferred** from Phase 1 (no `RunScript` action yet). Import EULA-gate hook still built so scripts slot in later. |
| **Export format** | **JSON only.** |
| **Phase-1 triggers** | Packet/Message received · Node discovered/updated · Telemetry threshold · Timer/cron + system events. |
| **Phase-1 actions** | Send message/tapback · Node management (delete/ignore/ban/favorite) · Notify (Apprise/webhook) · Delay/wait + set-variable. |
| **Live test / dry-run** | **Deferred to Phase 2.** Phase 1 ships a per-automation **execution run-log** instead (needed for stateful debugging anyway). |
| **Migration of legacy automations** | None in Phase 1. Legacy "Beginner Mode" stays on the old engine. Migrate one automation type per release later (template-as-config is the eventual end state). |
| **MeshCore parity** | Per-source surfacing in Phase 2 (show MeshCore blocks for MeshCore sources). Phase 1 targets Meshtastic event/action set; engine is protocol-aware via the source-filter + block availability. |

### Naming collision to avoid
There is **already** a per-source `'automation'` permission resource (`src/types/permission.ts:71`,
in `SOURCEY_RESOURCES`) and an `'automation'` `TabType` (`src/types/ui.ts`) used by the **legacy**
auto-ack/announce/responder/timer settings sections. The new engine must use **new, distinct**
identifiers so the two coexist:
- Permission resource: **`automations`** (plural, global — NOT added to `SOURCEY_RESOURCES`).
- Tab: **`automations`** (plural) — new top-level tab, separate from the legacy `automation` settings section.

---

## 2. Architecture overview

```
                         dataEventEmitter ('data' bus, 17+ event types)
                                  │
                                  ▼
   cronScheduler ──►   AutomationEngineService  ◄──  /api/automations (CRUD/import/export/run-log)
   (timer triggers)         │                              ▲
                            │ loads enabled automations    │ permission: `automations`
                            ▼                              │
                    ┌──────────────────┐         AutomationsPage (new global tab)
                    │ per-automation    │         ├─ linear-chain builder (UI v1)
                    │ graph evaluator   │         ├─ import/export (JSON) modal
                    │ + run manager     │         └─ run-log viewer
                    └──────────────────┘
                            │ actions
                            ▼
        sendTextMessage / sendAdminCommand / appriseNotificationService / webhook
        (per target source via sourceManagerRegistry.getManager(sourceId))
```

**Key integration points (verified):**
- Event bus: `src/server/services/dataEventEmitter.ts` — single `emit('data', event)`, `DataEvent` discriminated by event name (`message:new`, `node:updated`, `telemetry:batch`, `connection:status`, `meshcore:*`, …).
- Scheduler: `scheduleCron(expr, cb)` / `validateCron` in `src/server/utils/cronScheduler.ts` (croner, `catch:true` for missed-run recovery). Register a singleton service started from `src/server/server.ts`, mirroring `positionEstimationScheduler`.
- Send/admin: `meshtasticManager.sendTextMessage()` (`:8396`), `sendAdminCommand*` / `sendFavoriteNodeAwaitAck` (`:13416`), favorite/ignore via `protobufService.createSet*NodeMessage()` → `sendAdminCommand()`.
- Notify: `appriseNotificationService.notify({title, body, type, sourceId, sourceName})`.
- Permissions: `requirePermission(resource, action)` → `checkPermissionAsync(userId, sourceId, resource, action)`. Global resource = leave out of `SOURCEY_RESOURCES`.
- Tab registration: add to `TabType` (`src/types/ui.ts`), `VALID_TABS` (`src/contexts/UIContext.tsx` ~L660), and render block in `src/App.tsx`. **Forgetting `VALID_TABS` silently bounces the tab to #nodes.**

---

## 3. Data model

### 3.1 Workflow graph (the `config` JSON)

A workflow is a directed graph. Stored as a JSON document validated by a Zod schema.

```jsonc
{
  "version": 1,
  "nodes": [
    { "id": "n1", "type": "trigger.message",      "params": { "portnum": "TEXT_MESSAGE_APP", "textContains": "ping" } },
    { "id": "n2", "type": "condition.sourceFilter","params": { "sourceIds": ["default"] } },
    { "id": "n3", "type": "condition.distance",    "params": { "op": "<", "km": 5 } },
    { "id": "n4", "type": "collapse",              "params": { "mode": "ALL" } },
    { "id": "n5", "type": "action.tapback",        "params": { "emoji": "👍" } }
  ],
  "edges": [
    { "from": "n1", "to": "n2" },
    { "from": "n2", "to": "n4", "port": "true" },
    { "from": "n1", "to": "n3" },
    { "from": "n3", "to": "n4", "port": "true" },
    { "from": "n4", "to": "n5" }
  ]
}
```

- **Node kinds:** `trigger.*` (exactly one entry node in v1), `condition.*`, `action.*`, `flow.fanout`, `flow.collapse`, `flow.delay`, `flow.setVar`.
- **Edge ports:** an edge may carry `"port"`. Condition nodes have two ports — **`true`** and **`false`** — so they are *routers*, not just pass/prune gates. A condition with only a `true` edge behaves as a simple gate (backwards-compatible). Non-condition nodes use the default single output.
- **If / ElseIf / Else:** authored as one friendly widget, compiled to cascaded condition routers: `cond1 --true--> A`, `cond1 --false--> cond2 --true--> B`, `cond2 --false--> C(else)`. This is how the legacy auto-ack 2×2 matrix is rebuilt by the user (e.g. `if hops==0 → tapback, else → sendMessage`) instead of being hardcoded.
- **Fanout:** one input → many outputs (just multiple outgoing edges; no special node strictly required, but an explicit node aids the canvas UI).
- **Collapse:** many inputs → one output, gated by `mode ∈ {ANY, ALL, NONE}` over the boolean/`reached` state of incoming branches.
- **UI v1 constraint:** editor emits a single linear chain plus inline If/ElseIf/Else blocks; the schema/engine already support the full graph so the Phase-2 free-form canvas is additive.

### 3.2 Database tables

**`automations`** (global — no `sourceId`):

| col | type | notes |
|-----|------|-------|
| `id` | TEXT/UUID PK | |
| `name` | TEXT | |
| `description` | TEXT nullable | |
| `enabled` | bool | |
| `config` | TEXT/JSON | the graph document above |
| `createdAt` / `updatedAt` | bigint | |
| `createdByUserId` | int nullable | audit |

**`automation_runs`** (execution log + stateful instance store):

| col | type | notes |
|-----|------|-------|
| `id` | TEXT/UUID PK | |
| `automationId` | FK → automations.id | |
| `sourceId` | TEXT nullable | which source's event triggered this run |
| `status` | TEXT | `pending` · `waiting` · `completed` · `failed` · `cancelled` |
| `state` | TEXT/JSON | persisted variables + which nodes reached + pending waits |
| `triggerEvent` | TEXT/JSON | snapshot of the event payload that fired it |
| `startedAt` / `updatedAt` | bigint | |
| `log` | TEXT/JSON | ordered step results (node id, outcome, action result/error) |

Both tables follow the 3-backend Drizzle pattern (`src/db/schema/settings.ts` exemplar; BIGINT for ids on PG/MySQL; bool 0/1 vs true/false handled by Drizzle). New repository `src/db/repositories/automations.ts` extending `BaseRepository`; exposed via `DatabaseService` `*Async` methods. New migration **#098** (`098_create_automations`) registered in `src/db/migrations.ts`, count test updated.

> **Stateful persistence (Phase 1b):** `waiting` runs survive restarts via `automation_runs.state`. On boot the engine re-hydrates `waiting`/`pending` runs and re-arms their pending waits (timeouts/event-subscriptions). Editing or disabling an automation **cancels** its in-flight runs. In Phase 1a runs complete synchronously, so a run row is created at status `completed`/`failed` purely as a log.

---

## 4. Engine design (`src/server/services/automationEngineService.ts`)

1. **Load:** on boot, read all `enabled` automations; build an in-memory index keyed by trigger event type for fast dispatch (avoid evaluating every workflow on every packet).
2. **Dispatch:** subscribe once to `dataEventEmitter` `'data'`. For each event, look up only workflows whose trigger matches the event name, then apply the trigger's tight pre-filters (portnum / from / to / textContains) before any heavier work. Timer/cron triggers are armed via `scheduleCron`.
3. **Evaluate (per run):** create an `automation_runs` row, seed `state` with the trigger payload + empty vars, then walk the graph from the trigger node:
   - `condition.*` → evaluates, then routes: follow `true`-port edges on pass, `false`-port edges on fail (If/ElseIf/Else). A condition with no `false` edge is a plain gate.
   - `flow.collapse` → resolves ANY/ALL/NONE over incoming branch reachability.
   - `flow.delay` / wait-for-event → **(Phase 1b)** persist `state`, set status `waiting`, return; resume on timer fire or matching event. (Phase 1a runs are fully synchronous and never enter `waiting`.)
   - `flow.setVar` → mutate `state.vars`.
   - `action.*` → execute against the target source via `sourceManagerRegistry.getManager(sourceId)`; record result in `log`.
4. **Safety rails (critical):**
   - **Loop guard:** max action count per run + max graph-step count; an action that re-triggers its own workflow must not recurse infinitely (track originating run id / depth).
   - **Cooldown / rate-limit** per automation (carry over the existing `autoAckCooldownSeconds` concept) to prevent mesh spam.
   - **Airtime awareness:** respect existing `automationAirtimeCutoff*` settings before send actions.
   - Action failures are caught, logged to the run, and do not crash the engine.
5. **Variable interpolation:** `{{ ... }}` templating in action params, resolving from `state.vars`, the trigger payload (`{{ trigger.from }}`, `{{ trigger.text }}`), and system vars (`{{ CURRENT_SOURCE_NODE_ID }}`, `{{ NOW }}`). Import strips/normalizes personal node ids via these system vars so shared workflows are portable.

---

## 5. Block catalog (Phase 1)

**Triggers** (exactly one per workflow in v1):
- `trigger.message` — packet/text received; pre-filters: portnum, from, to, textContains/regex.
- `trigger.nodeDiscovered` / `trigger.nodeUpdated` — new node / field change (name, role, hwModel, position).
- `trigger.telemetry` — telemetry value crosses a bound (battery, temp, …).
- `trigger.schedule` — cron/interval; plus `trigger.system` for bootup / source-connect.

**Conditions** (each is a `true`/`false` router → enables If/ElseIf/Else):
- `condition.sourceFilter` — restrict to a subset of source ids (the "global but scopeable" knob).
- `condition.numeric` — `>,<,>=,<=,==,!=` on a numeric field (e.g. `hops == 0`, `battery < 20`).
- `condition.string` — exact / contains / regex.
- `condition.distance` — distance from a reference node/point `< / > km`.
- `condition.timeRange` — within a time-of-day / day-of-week window.
- `condition.logical` — AND/OR/NOT wrapper (Collapse covers most of this at the graph level).

**Flow:**
- `flow.fanout` — split to multiple branches.
- `flow.collapse` — join with `ANY | ALL | NONE`.
- `flow.setVar` — set/increment a workflow variable (single-run scope in 1a; cross-event in 1b).
- `flow.delay` — **(Phase 1b)** wait N seconds / until-event (stateful).

> **If/ElseIf/Else widget:** a UI affordance, not a distinct node type — it emits one or more `condition.*` routers wired by `true`/`false` ports, with each branch holding its own action(s). This is the user-built replacement for the hardcoded auto-ack matrix; `action.tapback` therefore stays minimal (emoji + target) and carries no routing logic.

### 5.1 Trigger field contract (`{{ trigger.* }}`)

This is the contract conditions evaluate against and `{{ }}` interpolation resolves from. Derived
strictly from the real `DataEvent` payloads (`dataEventEmitter.ts` + `DbMessage`/`DbNode`/`DbTelemetry`
in `src/services/database.ts`). **Resolution rules (apply to every field):**
- Missing/undefined field → numeric/string comparisons yield **false** (never throw); interpolation renders **empty string**.
- nodeNum/packetId coerced via `Number()` before compare (PG/MySQL BIGINT safety, per CLAUDE.md).
- Broadcast address compared against the shared constant in `src/server/constants/meshtastic.ts` (`0xFFFFFFFF`), never a magic number.

**`trigger.message`** — payload `DbMessage` (event `message:new`). Pre-filters: `portnum`, `from`, `to`, `textContains`/`regex`, `channel`.
| field | source | notes |
|-------|--------|-------|
| `trigger.from` / `trigger.fromId` | `fromNodeNum` / `fromNodeId` | |
| `trigger.to` / `trigger.toId` | `toNodeNum` / `toNodeId` | |
| `trigger.text` | `text` | |
| `trigger.channel` | `channel` | |
| `trigger.portnum` | `portnum` | |
| `trigger.hops` | `hopStart − hopLimit` | **only when both defined**, else undefined. `== 0` ⇒ direct/zero-hop. Powers the auto-ack-matrix replacement. |
| `trigger.hopStart` / `trigger.hopLimit` | raw | |
| `trigger.isDM` | `toNodeNum !== 0xFFFFFFFF` | DM vs broadcast |
| `trigger.isBroadcast` | `toNodeNum === 0xFFFFFFFF` | |
| `trigger.wantAck` | `wantAck` | |
| `trigger.replyId` / `trigger.emoji` | raw | emoji != 0 ⇒ this message *is* a tapback |
| `trigger.snr` / `trigger.rssi` | `rxSnr` / `rxRssi` | |
| `trigger.viaMqtt` | `viaMqtt` | |
| `trigger.decryptedBy` | `'node'｜'server'｜null` | |
| `trigger.node.*` | hydrated `DbNode` for `fromNodeNum` | full sender record (role, hwModel, position, …) |

**`trigger.nodeDiscovered` / `trigger.nodeUpdated`** — payload `NodeUpdateData {nodeNum, node: Partial<DbNode>}` (event `node:updated`).
> ⚠️ The emitter has **no separate "discovered" event** and `node` is a **partial** (changed fields only). Engine must: (a) **hydrate the full `DbNode`** from the DB for conditions; (b) expose the partial as `trigger.changed` (which fields changed — for "role changed" style triggers); (c) derive `trigger.isNew` (first-ever `node:updated` for that nodeNum, tracked by the engine, or `createdAt === updatedAt` heuristic). `nodeDiscovered` = `node:updated` where `isNew`; `nodeUpdated` = the rest.
| field | source |
|-------|--------|
| `trigger.nodeNum` | `nodeNum` |
| `trigger.node.*` | hydrated full `DbNode` (longName, shortName, hwModel, role, hopsAway, latitude/longitude, batteryLevel, isFavorite, …) |
| `trigger.changed` | the `Partial<DbNode>` delta |
| `trigger.isNew` | derived |

**`trigger.telemetry`** — payload `TelemetryBatchData {[nodeNum]: DbTelemetry[]}` (event `telemetry:batch`).
> Engine **fans the batch out** into individual readings and evaluates the trigger once per reading. Pre-filter on `telemetryType`.
| field | source |
|-------|--------|
| `trigger.nodeNum` | batch key |
| `trigger.telemetryType` | `telemetryType` (`batteryLevel`, `voltage`, `temperature`, `channelUtilization`, `airUtilTx`, …) |
| `trigger.value` / `trigger.unit` | raw |
| `trigger.timestamp` | `timestamp` |
| `trigger.node.*` | hydrated `DbNode` |

**`trigger.schedule`** — armed via `scheduleCron`/interval; **no mesh payload, no implicit source.**
| field | source |
|-------|--------|
| `trigger.firedAt` | fire timestamp |
> Action blocks under a schedule trigger **must name a target source** (specific source, or "all enabled sources"). There is no ambient `sourceId`.

**`trigger.system`** — engine bootup + source connect/disconnect (from `connection:status`).
| field | source |
|-------|--------|
| `trigger.event` | `'bootup' ｜ 'source-connected' ｜ 'source-disconnected'` |
| `trigger.sourceId` | the source (absent for `bootup`) |
| `trigger.nodeNum` / `trigger.reason` | from `ConnectionStatusData` |

**Global system vars** (all triggers): `{{ CURRENT_SOURCE_NODE_ID }}` (resolved per target source at action time), `{{ NOW }}`, `{{ trigger.sourceId }}`, `{{ trigger.timestamp }}`. Export rewrites personal node ids back into these so shared workflows are portable.

**Actions:**
- `action.sendMessage` — text to channel or DM (`sendTextMessage`).
- `action.tapback` — reaction/tapback.
- `action.nodeManage` — delete / ignore / ban / setFavorite (admin commands).
- `action.notify` — Apprise / webhook (`appriseNotificationService`).

---

## 6. API (`src/server/routes/automationRoutes.ts`)

All gated by `requirePermission('automations', <action>)` (global resource):

- `GET    /api/automations` — list.
- `POST   /api/automations` — create (validates graph via Zod; rejects unknown block types / cycles where illegal).
- `GET    /api/automations/:id` — fetch.
- `PUT    /api/automations/:id` — update (cancels in-flight runs).
- `DELETE /api/automations/:id`.
- `POST   /api/automations/:id/enable` · `/disable`.
- `GET    /api/automations/:id/runs` — execution run-log.
- `POST   /api/automations/import` — JSON import. **Admin-gated by default**; imported automations land **disabled**; future `RunScript` blocks trigger the scroll-to-accept EULA gate before enable.
- `GET    /api/automations/:id/export` — JSON export (interpolates personal ids back to system vars).

---

## 7. Frontend

- **New global tab `automations`** — register in `TabType` (`src/types/ui.ts`), `VALID_TABS` (`UIContext.tsx`), render in `App.tsx`. Model the page after `MapAnalysisPage` (global, iterates sources, doesn't depend on `SourceContext`).
- **`AutomationsPage`** — list of automations (enable toggle, run-status badge, edit/delete), "New automation" button.
- **`AutomationBuilder` (UI v1)** — constrained linear editor: pick one trigger → ordered conditions → ordered actions. Emits valid graph JSON. Block params are typed forms. Designed so the Phase-2 React Flow canvas is a drop-in replacement reading/writing the same JSON.
- **Import/Export modal** — paste/show JSON, Zod-validate before accept, copy-to-clipboard. EULA scroll-gate component built but inert until scripts exist.
- **Run-log viewer** — per-automation list of recent runs with step outcomes.

---

## 8. Phasing

**Phase 1a (this effort) — synchronous engine + linear builder, Meshtastic:**
- Migration #098 (`automations` + `automation_runs` with full schema incl. `status`/`state`, 3 backends) + count test. (1a never sets `waiting`.)
- `automations` global permission resource (`permission.ts` union + RESOURCES + admin/default sets; NOT in SOURCEY_RESOURCES).
- `automationEngineService` (load, event-type-indexed dispatch, graph eval with `true`/`false` condition routing, scheduler-armed timer triggers, safety rails, single-run var interpolation), started in `server.ts`.
- Zod block-catalog schema + types (shared FE/BE).
- `automationRoutes` CRUD/enable/disable/runs/import/export.
- `AutomationsPage` + `AutomationBuilder` (linear chain + inline If/ElseIf/Else widget) + import/export modal + run-log viewer + new tab.
- Tests: engine unit (each trigger fires / condition routes true+false / If-ElseIf-Else cascade / action exec / collapse ANY-ALL-NONE / fanout / loop-guard / cooldown), migration test, API CRUD + import-security tests, global-scope + sourceFilter test.

**Phase 1b — stateful waits:**
- `flow.delay` / wait-for-event; `automation_runs` `waiting` status; cross-event + global variables.
- Restart rehydration of `waiting` runs; cancel-on-edit/disable.
- Tests: wait→persist→resume on event/timer; restart rehydration; edit/disable cancels in-flight runs.

**Phase 2 — canvas + test + MeshCore:**
- React Flow graph canvas; Fanout/Collapse UI; multi-trigger.
- Dry-run / simulate mode + Packet Monitor pre-filtered live test.
- MeshCore trigger/action blocks surfaced per source.

**Phase 3+ — convergence:**
- Migrate legacy "Beginner Mode" automations to template-as-config, one type per release.
- Workflow Gallery on the website; `RunScript` action with EULA-gated import; eventual sunset of the legacy engine.

---

## 9. Risks & open items

- **Per-source invariant exception** must be documented in `CLAUDE.md` (add `automations` to the global-by-design list alongside `channel_database` / `estimated_positions`).
- **Double-fire:** a user can build an Advanced automation duplicating a still-active Beginner automation (e.g. two acks). Acceptable in Phase 1; surface a hint later.
- **Loop/recursion safety** is the highest-risk area — an action that emits a packet that re-triggers the same workflow. Mandatory depth/step/cooldown guards + tests.
- **Stateful run recovery** across restarts and across automation edits/deletes needs explicit cancel + rehydrate logic and tests.
- **Performance:** trigger pre-filtering and event-type indexing are load-bearing — never run all workflows on every packet.
- **Permission/tab naming** must not reuse the legacy `automation` identifiers.

---

## 10. Test coverage targets (Phase 1)

- Engine unit (1a): each trigger type fires; each condition routes both `true` and `false`; If/ElseIf/Else cascade picks first match; collapse ANY/ALL/NONE; fanout; single-run variable interpolation; loop-guard trips; cooldown enforced; action errors isolated.
- Stateful (1b): wait → persist → resume on event/timer; restart rehydration of `waiting` runs; edit/disable cancels in-flight runs.
- Migration test (count + last-name) across SQLite/PG/MySQL shape.
- API: CRUD, import lands disabled + admin-gated, export round-trips through Zod, run-log returns steps.
- Global-scope test: automation with no source filter evaluates across all sources; with `sourceFilter` restricts correctly.
