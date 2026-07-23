# TX-Disabled Support — Phase 1 Implementation Spec (Backend)

**Epic:** #4294 — TX-disabled (receive-only) support
**Phase:** 1 of 3 — Backend: honor `lora.txEnabled` + central transmit guard
**Branch:** `feature/tx-disabled-backend` (off `origin/main`)
**Companion doc:** `docs/internal/dev-notes/TX_DISABLED_SUPPORT_EPIC.md` (inventory + decisions)
**Scope:** backend only. All UI/i18n gating is Phase 2 — see "Out of scope" at the end.

All line numbers below were validated against this worktree on 2026-07-23. They will drift as
edits land; treat them as anchors, re-grep the named symbol before editing.

---

## 1. Problem & goal

Today the backend force-overwrites `lora.txEnabled` to `true` on every LoRa-config write and on
every import/export path, so a user can never legitimately run a Meshtastic source in receive-only
mode. Saving an unrelated LoRa field (e.g. hop limit) silently flips TX back on — the reported bug
(#4294: a ROUTER_LATE listen-only MQTT relay whose TX-off config MeshMonitor reverts).

Phase 1:
1. Stop forcing `txEnabled: true`; pass through / preserve the device's value.
2. Add one typed `TxDisabledError` guard at the transmit primitives so every OTA send path — routes,
   schedulers, automation, v1 API — fails cleanly and consistently when TX is disabled.
3. Local-node admin over TCP stays fully functional (it's how the user re-enables TX).

### Firmware semantics (already verified in the epic doc)
`tx_enabled=false` is a hard radio kill switch: every outbound LoRa packet is dropped at the radio.
RX, decode, TCP API (config read/write, **local** node admin, channel reads) keep working.
Remote-node sends (messages, traceroute, requests, remote admin) and the node's own
NodeInfo/Position/Telemetry broadcasts silently die.

---

## 2. How the manager knows TX state (state model)

`MeshtasticManager` already holds the device config in memory:

- `private actualDeviceConfig: any = null;` — `meshtasticManager.ts:783`. Merged from TCP config
  frames at `meshtasticManager.ts:4266` (`this.actualDeviceConfig = { ...this.actualDeviceConfig, ...parsed.data }`).
  Config updates arrive over TCP on change, so this field is fresh without any DB hit.
- The existing `GET /api/device/tx-status` route (`deviceStatusRoutes.ts:9`) already derives TX
  state as `deviceConfig?.lora?.txEnabled !== false` (default-true when unknown).

**Add a cheap synchronous accessor** — the single source of truth for the guard and the pre-checks:

```ts
// meshtasticManager.ts — public method, place near getDeviceConfig() (~8756)
/**
 * Current transmit state for THIS source, read from the in-memory device config.
 * Defaults to true when config hasn't arrived yet (fail-open: don't block sends
 * before we know the radio's state). No DB access — safe to call per packet.
 */
isTxEnabled(): boolean {
  return this.actualDeviceConfig?.lora?.txEnabled !== false;
}
```

Rationale for default-true: matches the existing `tx-status` route semantics exactly, and avoids
blocking legitimate sends during the brief window before the first config frame is decoded.

### Once-per-state-change logging (no per-tick spam)
Do the state-transition log at the **config-merge point**, not in each tick. In the handler around
`meshtasticManager.ts:4266`, capture `txEnabled` before and after the merge; when it flips, log once
at `info`:

```ts
const prevTx = this.actualDeviceConfig?.lora?.txEnabled !== false;
this.actualDeviceConfig = { ...this.actualDeviceConfig, ...parsed.data };
const nextTx = this.actualDeviceConfig?.lora?.txEnabled !== false;
if (prevTx !== nextTx) {
  logger.info(nextTx
    ? `📡 [${this.sourceId}] TX re-enabled — autonomous senders resume`
    : `🚫 [${this.sourceId}] TX disabled — pausing autonomous senders (node is now receive-only)`);
}
```

Individual scheduler/event pre-checks then just return early at `debug` level, so re-enable needs no
restart and the log stays quiet.

---

## 3. Typed error

There is **no** central server error module today; the only precedent is `SsrfBlockedError`
(`src/server/utils/ssrfGuard.ts:124`). Its tests re-declare the class via `vi.hoisted` because
`instanceof` across mocked module boundaries is unreliable. Avoid that trap by making the guard
identity **property-branded**, not `instanceof`-based.

**New file: `src/server/errors/txDisabledError.ts`**

```ts
export const TX_DISABLED_CODE = 'TX_DISABLED' as const;

export class TxDisabledError extends Error {
  /** Brand for cross-module-safe detection (see isTxDisabledError). */
  readonly isTxDisabledError = true as const;
  readonly code = TX_DISABLED_CODE;
  constructor(message = 'Transmit is disabled on this source’s radio') {
    super(message);
    this.name = 'TxDisabledError';
  }
}

/** Structural check — survives module duplication / mocking (does not rely on instanceof). */
export function isTxDisabledError(e: unknown): e is TxDisabledError {
  return !!e && typeof e === 'object' && (e as { isTxDisabledError?: boolean }).isTxDisabledError === true;
}
```

Route/scheduler/automation code branches on `isTxDisabledError(error)`, never `instanceof`.

---

## 4. Transmit-primitive guard (the choke point)

Each primitive already opens with `if (!this.isConnected || !this.transport) throw new Error('Not connected...')`.
Add the TX guard immediately after that connection check:

```ts
if (!this.isTxEnabled()) {
  throw new TxDisabledError();
}
```

**Primitives to guard** (all in `meshtasticManager.ts`):

| Method | Line | Notes |
|---|---|---|
| `sendTextMessage` | 8772 | covers user sends, auto-ack/responder/ping, auto-announce, cron/timer messages, automation, warning sends |
| `sendTraceroute` | 8939 | covers traceroute route, traceroute scheduler, auto-responder traceroutes |
| `sendPositionRequest` | 8987 | |
| `sendNodeInfoRequest` | 9062 | covers key-repair scheduler NodeInfo exchanges + `sendNodeInfoBroadcast` (9426 delegates here) |
| `sendNeighborInfoRequest` | 9131 | |
| `sendTelemetryRequest` | 9353 | covers remote LocalStats scheduler |

Guarding these six covers **every** meshtastic OTA send transitively, including the auto-* senders
and services that call `this.sendTextMessage` (auto-ack ~9949, auto-ping replies ~10058, tapbacks,
`autoAnnounceService`, timer/cron messages, `nodesRoutes.ts:1243` warning send, automation via
`meshActionDeps.ts:82`).

### Remote-admin guard (remote target only)
Local-node admin MUST keep working. Admin sends live in `src/server/services/remoteAdminService.ts`;
each method computes `isLocalNode` the same way (e.g. `sendRebootCommand` at line 563):

```ts
const localNodeNum = this.mgr.getLocalNodeInfo()!.nodeNum;
const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;
```

Add a private helper and call it in every method that transmits to a potentially-remote target,
right after `isLocalNode` is computed:

```ts
// remoteAdminService.ts
private assertTxForRemoteTarget(isLocalNode: boolean): void {
  if (!isLocalNode && !this.mgr.isTxEnabled()) {
    throw new TxDisabledError('Remote admin requires transmit; TX is disabled on this source');
  }
}
```

Apply to the remote-capable senders in `remoteAdminService.ts`: `sendRebootCommand`,
`sendSetTimeCommand`, remote config/owner setters, `requestRemoteConfig`, and
`requestRemoteSessionPasskey`. (Grep the file for `isLocalNode` to enumerate — every site that
computes it and then calls `this.mgr.sendLocalAdminPacket(...)` for a remote target needs the
assert.) `deviceAdminService.ts` is local-only (local position write, config-from-actual builder) —
**do not** guard it. **Never** guard `sendLocalAdminPacket` itself (shared with local admin).

Do NOT gate: the time-sync scheduler (local admin), MQTT bridge downlink, MeshCore managers,
DB-only services.

---

## 5. Route error mapping

`ok()`/`fail()` live in `src/server/utils/apiResponse.ts`. `fail(res, status, code, message, extra?)`
is always safe for the frontend (`ApiService` reads `error`/`code` only). Map every guarded route:

### 5a. messageRoutes.ts
- Send at `1310`; catch at `1316` currently `res.status(500).json({ error: 'Failed to send message' })`.
- Add `import { fail } from '../utils/apiResponse.js';` (not currently imported) and:
  ```ts
  } catch (error) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
  ```
  (Leave the existing 500 shape as-is — bare-`{error}` handlers convert opportunistically, only the
  new TX branch uses `fail`.)

### 5b. meshRequestRoutes.ts
- Five handlers: traceroute (send 34 / catch 39), position (69 / 118), nodeinfo (150 / 196),
  neighborinfo (264 / 275), telemetry (314 / 329).
- These use `res.json({ success, error, message })` and already special-case `'Not connected'` → 503.
  Add a TX branch **before** the not-connected check in each catch:
  ```ts
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error sending traceroute:', error);
    if (error?.message?.includes('Not connected')) { /* existing 503 */ }
    ...
  }
  ```

### 5c. adminRoutes.ts (remote target) + configRoutes.ts (remote module-config-request)
- `configRoutes.ts:282` `requestModuleConfig(configType)` for a remote target → wrap its catch (284)
  with the TX branch → `fail(res, 409, 'TX_DISABLED', ...)`.
- adminRoutes remote admin command handlers (remote reboot/set-config/etc.) → same TX branch in their
  catches. Local-target admin never throws `TxDisabledError`, so local admin is unaffected.

### 5d. v1 API — follow v1's own convention (NOT the fail() envelope)
v1 formats errors as `res.status(N).json({ success: false, error: '...' })` (e.g.
`v1/actions.ts:105`). Add a code field for the TX case:
```ts
} catch (error) {
  if (isTxDisabledError(error)) {
    return res.status(409).json({ success: false, error: 'Transmit is disabled on this source', code: 'TX_DISABLED' });
  }
  logger.error('[v1/actions] Error sending traceroute:', error);
  res.status(500).json({ success: false, error: 'Failed to send traceroute' });
}
```
- `v1/actions.ts`: traceroute, position, nodeinfo, neighborinfo handlers.
- `v1/messages.ts`: send at `536` (single-packet path). The multi-part path queues via
  `messageQueueService` (202 accepted) — the queue drains through `sendTextMessage` later, so a
  queued send that hits TX-disabled is handled by the queue's own error path, not the request. Gate
  the synchronous `536` send; note the queued path as a known async-skip (acceptable for Phase 1).

---

## 6. Import / export preservation

Decision (epic §5): imports/restores **preserve the device's current `txEnabled`** — strip the field
before applying. Exports emit the **actual** value. Only the LoRa config UI changes it (§7).

| Site | File:line | Change |
|---|---|---|
| LoRa config write | `configRoutes.ts:132-138` | Remove `txEnabled: true`. Pass through the submitted `req.body.txEnabled` (this is the one UI that legitimately sets it — exit criterion 1). |
| Channel-URL export | `channelRoutes.ts:1064` | Replace `txEnabled: true` with `txEnabled: deviceConfig.lora.txEnabled`. |
| Channel-URL import | `channelRoutes.ts:1180-1189` | Strip `txEnabled` from `decoded.loraConfig` before `setLoRaConfig`: `const { txEnabled: _drop, ...rest } = decoded.loraConfig; await configImportManager.setLoRaConfig(rest);` |
| Remote/local config export | `adminRoutes.ts:1066` (local), `adminRoutes.ts:1086` (remote) | Replace `txEnabled: true` with the real source value (`deviceConfig.lora.txEnabled` / `loraConfigData.txEnabled`). |
| Config import (`/import-config`) | `adminRoutes.ts:1109`, applies via the shared local import logic (~1140) | The channel-import fix (above) covers this path since it reuses that logic. Verify no separate `txEnabled: true` remains in the apply branch. |
| Backup restore | `systemRestoreService.ts` / `systemBackupService.ts` | **No change** — grep confirms neither writes `lora`/`txEnabled`. Add a one-line comment or a test asserting restore never calls `setLoRaConfig`, to lock in exit criterion 2. |

---

## 7. Autonomous senders — skip at tick, no spam

**Design decision:** the primitive guard is the correctness backstop. To avoid a thrown
`TxDisabledError` on every tick (and per-tick error logs), add a **cheap `isTxEnabled()` pre-check
that returns early** at the top of each autonomous tick. The once-per-state-change info log already
lives at the config-merge point (§2), so ticks stay silent (debug-level early return).

| Sender | Location | Action |
|---|---|---|
| Traceroute scheduler | tick in `startTracerouteScheduler` (`meshtasticManager.ts:2197`, sends at 2267) | early-return if `!isTxEnabled()` |
| Key-repair scheduler | `startKeyRepairScheduler` (2852, sends 2944/2964) | early-return |
| Remote LocalStats scheduler | `startRemoteLocalStatsScheduler` (2358) | early-return |
| Remote-admin scanner | `startRemoteAdminScanner` (2624) | early-return (all its sends are remote admin) |
| Auto-announce | `autoAnnounceService.ts` tick (~78, guarded today by `isDeviceConnected()`) | add `&& this.mgr.isTxEnabled()` to the same guard |
| Waypoint rebroadcast | `waypointRebroadcastSchedulerService.ts` tick (~50) | early-return if the source's `isTxEnabled()` is false |
| Timer/cron messages | `startTimerScheduler` (3216) / cron job (3274) | early-return in the job body |
| Auto-ack | send site `meshtasticManager.ts:~9949` | pre-check in the auto-ack decision path before building the reply |
| Auto-responder | auto-responder decision path (near auto-ack) | pre-check |
| Auto-ping | reply sites (~10058) | pre-check before replying |
| Position-estimation traceroutes | verified: `positionEstimationService`/`Scheduler` do **not** call `sendTraceroute` (they consume observed traceroute/neighbor data). No change; covered by primitive guard if a future path sends. |

For the schedulers that poll one target per tick, the early-return leaves the interval running so TX
re-enable resumes automatically — matching the existing passive-mode skip philosophy
(`meshtasticManager.ts:1786-1826`).

**Note on passive mode:** passive mode skips *starting* certain schedulers at connect
(`meshtasticManager.ts:1785`). TX-disabled is orthogonal — the schedulers still start, they just
skip *sending* at tick time. Do not conflate the two flags.

---

## 8. Automation engine — skip-and-record

The automation engine records per-action outcomes as `{ skipped: true, reason: '...' }` objects
(existing pattern in `src/server/services/automation/actionExecutor.ts:317,338,363,409` for
MeshCore-unsupported actions). Run status is `'completed' | 'failed'`
(`automationEngineService.ts:66`); a skipped action does **not** fail the run.

The mesh send flows through `meshActionDeps.ts` → `sendTextVia` (line ~79) → `raw.sendTextMessage(...)`
which will now throw `TxDisabledError` when TX is off. **Catch it in the action executor and convert
to a skip**, mirroring the existing MeshCore-unsupported skips:

- In `actionExecutor.ts`, wrap the mesh-send action invocation (`deps.sendMessage`/`sendTapback`/the
  meshRequest/remote-admin actions) so `isTxDisabledError(e)` returns
  `{ skipped: true, reason: 'TX_DISABLED' }` (or pushes it to `results`) instead of rethrowing.
- Because the guard is Meshtastic-only, the MeshCore branch of `sendTextVia` never throws
  `TxDisabledError` — no MeshCore behavior changes.

Acceptance: a send action against a TX-disabled source yields an `automation_runs` entry with the run
`status: 'completed'` and the action step marked skipped/`TX_DISABLED` — not `status: 'failed'`.

---

## 9. Work packages

Sized for one Sonnet implementer each. **Tests are folded into their owning WP** (each WP lands
green). Dependency order is strict: WP1 → {WP2, WP3} → WP4-doc.

### WP1 — Error type, manager state accessor, primitive + remote-admin guards
**Depends on:** nothing.
**Files:**
- New `src/server/errors/txDisabledError.ts` (§3).
- `meshtasticManager.ts`: add `isTxEnabled()` (§2); add state-change info log at the config-merge
  point (~4266); add the guard to the six primitives (§4).
- `remoteAdminService.ts`: add `assertTxForRemoteTarget()` + call it in every remote-capable sender (§4).
**Tests:**
- `meshtasticManager` guard unit tests: each primitive throws `TxDisabledError` when
  `actualDeviceConfig.lora.txEnabled === false`; succeeds (no throw for TX reason) when true/undefined.
- `isTxEnabled()` default-true when config absent.
- `remoteAdminService`: remote target + TX off → throws; local target (dest 0 / local nodeNum) + TX
  off → does NOT throw (mock `sendLocalAdminPacket`).
**Acceptance:** guard unit tests green; local admin path proven unaffected; no route/scheduler changes yet.

### WP2 — Route error mapping + import/export/config passthrough
**Depends on:** WP1 (imports `isTxDisabledError`, `TxDisabledError`).
**Files:**
- `configRoutes.ts` (POST /lora passthrough §6; module-config-request 409 §5c).
- `channelRoutes.ts` (export actual value; import strip §6).
- `adminRoutes.ts` (export actual value; remote-admin 409; verify import apply §6).
- `messageRoutes.ts`, `meshRequestRoutes.ts`, `v1/actions.ts`, `v1/messages.ts` (409 mapping §5).
**Tests (route harness — `createRouteTestApp`, per CLAUDE.md; `src/server/test-helpers/routeTestApp.ts`):**
- `POST /api/config/lora` with `txEnabled:false` passes it through to `setLoRaConfig` (no force-true).
- Channel import does **NOT** call `setLoRaConfig` with a `txEnabled` key (strip assertion).
- Channel/admin export emits the source's actual `txEnabled`.
- Each guarded route returns **409 + code `TX_DISABLED`** when the (mocked) manager primitive throws
  `TxDisabledError`: messages send, meshRequest ×5, config module-request (remote), v1 actions ×N,
  v1 messages single-send.
- Backup-restore test: restore path never writes lora `txEnabled` (exit criterion 2).
Mock the `sourceManagerRegistry`/resolved manager so the primitive throws `TxDisabledError`
(non-DB mocks stay per CLAUDE.md); use the harness only for the auth/session/permission wiring.

### WP3 — Autonomous sender skips + automation skip-and-record
**Depends on:** WP1 (`isTxEnabled`, `isTxDisabledError`).
**Files:**
- `meshtasticManager.ts` scheduler ticks + auto-ack/responder/ping pre-checks (§7).
- `autoAnnounceService.ts`, `waypointRebroadcastSchedulerService.ts` (§7).
- `services/automation/actionExecutor.ts` (catch → skip §8).
**Tests:**
- Scheduler-skip unit tests: with TX off, the traceroute/key-repair/remote-LocalStats ticks do not
  call their primitive; with TX on they do.
- Auto-ack/responder/ping: no reply attempted when TX off.
- Automation: send action against TX-disabled source produces a run with `status:'completed'` and a
  skipped/`TX_DISABLED` action result (extend `actionExecutor.test.ts` / `automationEngineService.test.ts`).
- Verify no per-tick error log (assert logger not called at error level on repeated ticks).
**Acceptance:** no unhandled promise rejections from ticks; state-change logged once.

### WP4 — v1 API doc note + full-suite green (fold into WP2/WP3 if preferred)
**Depends on:** WP2, WP3.
- Confirm full Vitest suite green (§Testing). No new doc pages (user docs are Phase 3) — only a
  short code comment where `TX_DISABLED` is emitted so the Phase 3 docs pass can find them.
This WP is optional bookkeeping; the reviewer may merge it into WP2/WP3.

---

## 10. Testing notes

- Run the **full** Vitest suite before PR (not just targeted files) — the guard touches
  `meshtasticManager`, which many suites import.
- New/changed route tests **must** use `createRouteTestApp` (harness at
  `src/server/test-helpers/routeTestApp.ts`: `harness.grant(userId, resource, action, sourceId)`,
  `harness.loginAs`, `harness.limited`, `harness.sourceA`, `harness.cleanup`). Non-DB mocks
  (`sourceManagerRegistry`, resolved manager) remain hand-mocked.
- Lint gate: `npm run lint:ci` must exit 0 (ignore `.claude/worktrees/` FAIL lines per CLAUDE.md).
  The new error file + guard code must not add `no-explicit-any` sites (type the error as `unknown`
  and narrow via `isTxDisabledError`).
- No migration, no schema change, no new setting key — nothing to add to `VALID_SETTINGS_KEYS` or
  the migration registry. `txEnabled` already flows through the existing device-config plumbing.

---

## 11. Out of scope (Phase 2 / Phase 3)

- **All frontend gating and i18n** (Phase 2): disabling send buttons, the "Transmit Disabled"
  banner styling, tooltips, the LoRa-config danger-confirm dialog, `useTxStatus` consumers beyond
  the existing banner, removing the frontend defensive `txEnabled:true` defaults
  (`useAdminCommandsState.ts:223`, `AdminCommandsTab.tsx:503,1059`). Phase 1 only makes the backend
  correct; the UI continues to work (sends now surface a 409 instead of silently succeeding).
- **Automations builder warning badge, v1 API docs, user-facing receive-only docs, locale string
  verification** (Phase 3).
- **MeshCore / MQTT-bridge** TX gating — intentionally never gated (different transport, no such flag).
