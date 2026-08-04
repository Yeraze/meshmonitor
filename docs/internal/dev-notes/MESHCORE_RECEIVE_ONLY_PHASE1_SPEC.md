# MeshCore Strict Receive-Only — Phase 1 Implementation Spec (Backend)

**Epic:** #4547 · **Epic plan:** `docs/internal/dev-notes/MESHCORE_RECEIVE_ONLY_EPIC.md`
**Branch:** `feature/meshcore-receive-only-backend` · **Worktree:** `/home/yeraze/Development/meshmonitor-mc-rxonly-p1`
**Scope:** Phase 1 only — the setting, the command-aware TX guard, scheduler skips, route
mapping, and the backend half of the frontend read path. No UI work. No Virtual Node work.

Every line reference in this document was verified against the worktree on 2026-08-04. Where
the epic plan's numbers had drifted or were wrong, the correction is called out inline.

---

## 1. Reuse inventory (read this before writing any code)

Nothing in this list may be re-implemented. Extend it or call it.

### 1.1 Error type — reuse verbatim

`src/server/errors/txDisabledError.ts` (16 lines, complete):

```ts
export const TX_DISABLED_CODE = 'TX_DISABLED' as const;
export class TxDisabledError extends Error {
  readonly isTxDisabledError = true as const;
  readonly code = TX_DISABLED_CODE;
  constructor(message = 'Transmit is disabled on this source’s radio') { … }
}
export function isTxDisabledError(e: unknown): e is TxDisabledError
```

Do **not** create a `MeshCoreReceiveOnlyError`. The whole point of reusing `TxDisabledError`
is that `actionExecutor` (§1.3) and the frontend's `code === 'TX_DISABLED'` handling already
work. Pass a MeshCore-specific *message* to the existing constructor instead.

### 1.2 Guard idiom — mirror `MeshtasticManager`

- `isTxEnabled()` — `src/server/meshtasticManager.ts:9095` — raw device truth, sync, no DB.
- `canTransmit()` — `:9141` — `isTxEnabled() || isUdpBroadcastRelayEnabled()`. **Synchronous
  and free of DB access.** This is non-negotiable for MeshCore too: `computeSourceRadioSummary`
  (§1.7) is a sync function, and per-packet guards must not hit SQLite.
- **User-initiated → throw:** `:9167`, `:9349`, `:9401`, `:9480`, `:9553`, `:9784`, `:10512`,
  `:10620` — all the shape `if (!this.canTransmit()) throw new TxDisabledError();`
- **Scheduler → silent skip:** `:2278` (auto-ack), `:2440` (auto-responder), `:3354` (timer
  trigger), `:4373`-ish (auto-traceroute), `:10156`, `:10931` — all the shape
  `if (!this.canTransmit()) { logger.debug('… Skipping - TX disabled on this source'); return; }`
- **State-change-only log:** `src/server/meshtasticManager.ts:4373-4387` — captures
  `prevCanTransmit`, mutates, re-reads `nextCanTransmit`, and emits `logger.info` **only when
  the two differ**. Copy this shape exactly. Everything else is `logger.debug`.

### 1.3 Automation — zero new code required

`src/server/services/automation/actionExecutor.ts:145-155` (note: the epic plan's path
`automation/actionExecutor.ts` is wrong — it lives under `services/`):

```ts
async function pushOrSkipTxDisabled<T>(results: unknown[], fn: () => Promise<T>): Promise<void> {
  try { results.push(await fn()); }
  catch (error) {
    if (isTxDisabledError(error)) { results.push({ skipped: true, reason: 'TX_DISABLED' }); return; }
    throw error;
  }
}
```

Because MeshCore send primitives will throw the same branded error, MeshCore automation
actions degrade to `{ skipped: true, reason: 'TX_DISABLED' }` with **no change to
`actionExecutor.ts` or `meshActionDeps.ts`**. Do not touch those files.

### 1.4 Route plumbing — extend, do not fork

`src/server/routes/meshcoreRouteShared.ts`:
- `managerFor(_req, res): MeshCoreManager` (`:31`) — returns `res.locals.meshcoreManager`,
  already narrowed and cached by the router-level guard. Never call `getManager()` again in a
  handler.
- `meshcoreRouteGuard(req, res, next)` (`:43`) — validates `:id`, resolves + narrows via
  `isMeshCoreManager`, caches on `res.locals`. Every new TX guard **must run after this**.
- `VALIDATION` (`:66`) and `auditMeshcoreEvent` (`:162`) — reuse as-is.

`src/server/utils/apiResponse.ts`:
- `ok(res, data?)` → `{ success: true, data }`. **Do not** convert existing bare-payload
  handlers; Phase 1 adds no new success shapes.
- `fail(res, status, code, message, extra?)` → `{ success: false, error, code, ...extra }`.
  Always safe. This is how every 409 is emitted.

### 1.5 Per-source settings plumbing

- `src/server/constants/settings.ts` — `VALID_SETTINGS_KEYS` (~`:100`-`:340`),
  `PER_SOURCE_SETTINGS_KEYS` (`:346`), `PerSourceSettingKey` (`:555`),
  `GLOBAL_ONLY_SETTINGS_KEYS` (`:590`-ish), `PER_SOURCE_KEYS_NOT_POSTABLE` (`:605`-ish).
  Existing MeshCore per-source neighbours to copy: `meshcoreRespondToDiscovery`,
  `meshcoreAutoPathfindingEnabled` (`:431`), `meshcoreAutoResponderEnabled` (`:475`),
  `meshcoreDefaultScope` (`:480`).
- `databaseService.settings.getSettingForSource(sourceId, key)` — the only read API. Existing
  MeshCore uses: `meshcoreManager.ts:1606`, `:3229`, `:3929`, `:6433`, `:6601`, `:6714`.
- **Settings-write side-effect channel:** `SettingsCallbacks` in
  `src/server/routes/settingsRoutes.ts:~120-160`, injected via `setSettingsCallbacks()` and
  implemented in `src/server/server.ts` (see `restartAnnounceScheduler` at `server.ts:848`).
  The per-source write branch is `settingsRoutes.ts:806-882`. This is the mechanism for cache
  invalidation on settings write — **do not invent an event bus.**

### 1.6 Backend state push — the `setRespondToDiscovery` precedent

The exact pattern for pushing manager state into `MeshCoreNativeBackend` already exists:
- `MeshCoreNativeBackend.setRespondToDiscovery(enabled)` — `meshcoreNativeBackend.ts:782`
- `MeshCoreManager.setRespondToDiscovery(enabled)` — `meshcoreManager.ts:3937`
- Applied on connect inside `startNativeBackend()` — `meshcoreManager.ts:1604-1613`
- Applied on settings write from a route — `meshcoreConfigRoutes.ts:60`

Copy this exact three-point pattern for receive-only. Nothing new is required.

### 1.7 Frontend read path — already exists

- `computeSourceRadioSummary(sourceId)` — `src/server/routes/sourceRoutes.ts:434`, synchronous,
  try/catch-wrapped, already has an `isMeshCoreManager(mgr)` branch returning
  `{ frequencyMhz }`. Attached at `sourceRoutes.ts:496` to `GET /api/sources`.
- Server interface `SourceRadioSummary` — `sourceRoutes.ts:414` (already carries
  `txEnabled` / `udpRelayEnabled` / `canTransmit` for Meshtastic).
- Client mirror — `src/types/elevation.ts:40`, consumed by `src/hooks/useDashboardData.ts:34`.
- `GET /api/device/tx-status` — `src/server/routes/deviceStatusRoutes.ts:9`, shape
  `{ txEnabled, udpRelayEnabled, canTransmit }`, resolved via `resolveSourceManager`.

### 1.8 Test utilities

- `createRouteTestApp()` / `RouteTestHarness` — `src/server/test-helpers/routeTestApp.ts`
  (`:135` factory; `:72` `sourceA`, `:74` `sourceB`, `:78` `limited`, `:96` `grant`,
  `loginAs`, `cleanup`). **Mandatory for all new route tests.**
- Canonical template: `src/server/routes/sourceRoutes.permissions.test.ts`.
- Existing MeshCore route-test files (mock `sourceManagerRegistry`, not the DB — that part
  stays correct): `meshcoreRoutes.test.ts` (see the `setRespondToDiscovery` mock at `:65` and
  its assertions at `:2045-2077`), `meshcoreRoutes.zeroHopPing.test.ts`,
  `meshcoreMessagingRoutes.channelPermissions.test.ts`.
- Discovery-responder harness already exists: `src/server/meshcoreNativeBackend.discovery.test.ts`
  (`:271-303` drives `setRespondToDiscovery(true)` and asserts frames). Extend this file's
  patterns rather than building a new backend harness.
- `*.perSource.test.ts` precedent: `src/server/meshtasticManager.autoAckTokens.perSource.test.ts`,
  `src/server/services/meshcoreObserverPublisher.perSource.test.ts`.
- Source-extraction test precedent (for the denylist-completeness test):
  `src/server/server.settings-persistence.test.ts` reads source text and asserts on it.

### 1.9 New subsystems, justified

| New thing | Closest existing | Why new |
|---|---|---|
| `src/server/constants/meshcoreTx.ts` | `meshcoreRouteShared.ts` `DANGEROUS_CLI_COMMANDS` | The denylist must be importable by the manager, the native backend, the routes **and** a test that cross-checks it against source text. Putting it in `meshcoreRouteShared.ts` would make the manager import a routes module (layering inversion). `constants/` is where `settings.ts` and `meshtastic.ts` already live. |
| `requireMeshcoreTx` middleware | `requireMeshcoreChannelAccess` (`meshcoreRouteShared.ts:351`) | Same file, same idiom — this is an extension of existing plumbing, not a new subsystem. |
| Nothing else | — | No new error class, no new event bus, no new DB column, no migration, no new API surface beyond two additive response fields. |

---

## 2. File-by-file changes

### 2.1 `src/server/constants/settings.ts` — the setting key

Add `'meshcoreReceiveOnly'` to **both** arrays:

1. `VALID_SETTINGS_KEYS` — insert adjacent to `'meshcoreDefaultScope'` (currently `:310`).
2. `PER_SOURCE_SETTINGS_KEYS` — insert adjacent to `'meshcoreDefaultScope'` (currently `:480`).

Do **not** add it to `GLOBAL_ONLY_SETTINGS_KEYS` or `PER_SOURCE_KEYS_NOT_POSTABLE`.

Storage: `source:{sourceId}:meshcoreReceiveOnly`, string `'true'` / `'false'`. No migration.

**`PerSourceSettingKey` needs no third edit — verified 2026-08-04.** `settings.ts:555` reads
exactly:

```ts
export type PerSourceSettingKey = typeof PER_SOURCE_SETTINGS_KEYS[number];
```

It is a **derived** type, not a hand-written union, and `PER_SOURCE_SETTINGS_KEYS` closes with
`] as const;` at `:553`. Adding the string literal to the array widens the type automatically.
WP1 therefore edits exactly two array literals in this file and nothing else.

**Correction to the epic plan.** The epic says the key "must be added to the exact-equality
assertion in `settings.allowlist.test.ts`". It must not — that test is fully structural:
`:27-28` (`missing` ⊆ not-postable), `:44-47` (disjointness), `:77-88` (no duplicates),
`:135-136` (`PER_SOURCE_KEYS_NOT_POSTABLE.size === 17`). Adding the key to **both** arrays
keeps all four green with zero test edits. Adding it to only `PER_SOURCE_SETTINGS_KEYS` breaks
the size-17 pin. Implementers must run `settings.allowlist.test.ts` and confirm it passes
**unmodified** — a required edit there means the key was added to the wrong place.

### 2.2 `src/server/constants/meshcoreTx.ts` — NEW: the denylist

```ts
/**
 * MeshCore receive-only mode (#4547) — bridge-command classification.
 *
 * `sendBridgeCommand` carries BOTH over-the-air commands and local serial
 * config commands, so the receive-only gate must be command-name aware.
 *
 * FAIL-CLOSED: `isRfBridgeCommand()` returns true for any name not explicitly
 * listed as serial-only. A bridge command added in the future without touching
 * this file is therefore BLOCKED in receive-only mode rather than silently
 * transmitting. `meshcoreTx.test.ts` additionally fails the build so the
 * omission is caught at review time, not at runtime.
 */

/** Commands that put energy on the LoRa radio. Blocked in receive-only mode. */
export const RF_BRIDGE_COMMANDS: ReadonlySet<string> = new Set([
  'send_message',
  'send_advert',
  'send_cli',
  'discover_path',
  'discover_nodes',
  'request_owner',
  'request_regions',
  'request_telemetry',
  'trace_path',
  'share_contact',
  'get_neighbours',
  'login',
  'get_status',
  'reset_path',
]);

/** Local-serial-only commands. Allowed in receive-only mode. */
export const SERIAL_ONLY_BRIDGE_COMMANDS: ReadonlySet<string> = new Set([
  'get_channels', 'set_channel', 'delete_channel',
  'get_self_info', 'get_contacts', 'remove_contact',
  'export_contact', 'import_contact',
  'export_private_key', 'import_private_key',
  'set_name', 'set_radio', 'set_tx_power', 'set_coords',
  'set_advert_loc_policy', 'set_other_params', 'set_flood_scope', 'set_out_path',
  'set_telemetry_mode_base', 'set_telemetry_mode_loc', 'set_telemetry_mode_env',
  'get_stats', 'get_device_time', 'set_device_time', 'device_query',
  'reboot', 'shutdown', 'ping',
]);

export function isRfBridgeCommand(cmd: string): boolean {
  return !SERIAL_ONLY_BRIDGE_COMMANDS.has(cmd);
}

/** Local-CLI verbs (Companion synthetic CLI and Repeater serial CLI) that transmit. */
export const RF_LOCAL_CLI_VERBS: ReadonlySet<string> = new Set(['advert']);

export function isTransmittingLocalCliVerb(command: string): boolean {
  const verb = command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return RF_LOCAL_CLI_VERBS.has(verb);
}

/** Single user-facing message for every receive-only rejection. */
export const MESHCORE_RECEIVE_ONLY_MESSAGE =
  'Transmission blocked: this MeshCore source is configured for receive-only operation.';
```

**Counts, verified.** `meshcoreManager.ts` issues 37 distinct `sendBridgeCommand` literals;
`meshcoreNativeBackend.ts`'s dispatch switch handles 42 cases (the 37 plus
`set_telemetry_mode_base|loc|env`, `shutdown`, `ping`). 14 RF + 28 serial-only = 42. The
completeness test (§3.1) pins this.

**`reset_path` rationale.** It does not itself put a frame on the air; it clears the stored
out-path so the *next* send floods. It is denylisted deliberately: in receive-only mode there
is no legitimate next send, the UI groups it with discover-path, and blocking it keeps the
route surface coherent. Documented here so a future reader does not "fix" it.

**`import_contact` / `export_contact` / `share_contact`.** `share_contact` transmits (it
broadcasts our contact card) → RF. `import_contact` / `export_contact` are local record
operations → serial-only. Do not conflate them.

**`ping` and `shutdown` — verified serial-only, do not re-derive.** Both appear only in the
native backend's dispatch switch, never in the manager's inventory, so they were classified
from source, not from the survey. Bodies read on 2026-08-04:

```ts
// meshcoreNativeBackend.ts:1815-1816
case 'shutdown':
  await this.disconnect();
  return { ok: true };

// meshcoreNativeBackend.ts:1819-1820
case 'ping':
  return { pong: true };
```

`shutdown` tears down the local transport (`this.disconnect()`) — no `c.*` connection call, no
frame. `ping` is a pure in-process liveness reply that never touches `this.connection` at all;
it is **not** a zero-hop radio probe (the radio probe is `pingContactZeroHop`, which goes out
as `trace_path` and is correctly on the RF list). Both stay in
`SERIAL_ONLY_BRIDGE_COMMANDS`. Do not move them.

### 2.3 `src/server/meshcoreManager.ts` — state, gate, guards, skips

#### 2.3.1 State (add near the other per-source cached settings)

```ts
/** Cached per-source `meshcoreReceiveOnly`. Sync-readable; refreshed on connect and on settings write. */
private receiveOnly = false;

/** True when this source is configured strictly receive-only (#4547). */
isReceiveOnly(): boolean { return this.receiveOnly; }

/**
 * Whether this source may put energy on the radio. Sync, no DB access —
 * mirrors MeshtasticManager.canTransmit() (meshtasticManager.ts:9141) so
 * per-command guards and the sync computeSourceRadioSummary can both use it.
 */
canTransmit(): boolean { return !this.receiveOnly; }

/**
 * Apply a new receive-only value. Logs ONLY on a state change (info), never
 * per tick. Pushes the value into the native backend so chokepoint B
 * (handleDiscoverRequest) sees it too.
 */
setReceiveOnly(enabled: boolean): void {
  const prev = this.receiveOnly;
  this.receiveOnly = enabled;
  this.nativeBackend?.setReceiveOnly(enabled);
  if (prev !== enabled) {
    logger.info(enabled
      ? `🚫 [MeshCore:${this.sourceId}] Receive-only mode ON — all transmissions blocked, autonomous senders paused`
      : `📡 [MeshCore:${this.sourceId}] Receive-only mode OFF — transmissions and autonomous senders resume`);
  }
}

/**
 * Re-read `meshcoreReceiveOnly` from the DB and apply it. On read failure the
 * PREVIOUS cached value is retained — a transient DB error must never silently
 * re-enable transmission on a source the user configured receive-only.
 */
async refreshReceiveOnly(): Promise<boolean> {
  try {
    const raw = await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreReceiveOnly');
    this.setReceiveOnly(raw === 'true');
  } catch (err) {
    logger.warn(`[MeshCore:${this.sourceId}] Failed to read meshcoreReceiveOnly, keeping cached value (${this.receiveOnly}):`, err);
  }
  return this.receiveOnly;
}

/** Throw the shared TxDisabledError when this source is receive-only. */
private requireTransmit(): void {
  if (!this.canTransmit()) throw new TxDisabledError(MESHCORE_RECEIVE_ONLY_MESSAGE);
}
```

Import `TxDisabledError` from `./errors/txDisabledError.js` and the constants from
`./constants/meshcoreTx.js`.

#### 2.3.2 Refresh points — must survive reconnects

1. **`connect()` (`:1131`)** — `await this.refreshReceiveOnly();` **early**, before the
   auto-announce-on-start block at `:1289` and before `startNativeBackend()` (`:1563`). Placing
   it inside `startNativeBackend()` is wrong: that method runs only for Companion sources, and
   receive-only applies to repeater/serial sources too (interview decision 4).
   `connect()` re-arms four autonomous TX schedulers on every reconnect, so this refresh is
   what makes the guard survive a reconnect.
2. **`startNativeBackend()` (`:1604`-`:1613`)** — add
   `this.nativeBackend.setReceiveOnly(this.receiveOnly);` immediately alongside the existing
   `setRespondToDiscovery` call, so a freshly-constructed backend inherits the cached value.
3. **Settings write** — via the new `SettingsCallbacks` entry (§2.6).

#### 2.3.3 Chokepoint A — `sendBridgeCommand` (`:1620`)

```ts
private async sendBridgeCommand(cmd: string, params: Record<string, any>, timeout = 30000): Promise<BridgeResponse> {
  if (!this.nativeBackend) throw new Error('Native backend not ready');
  // Receive-only (#4547): command-name aware — this method carries BOTH RF and
  // local serial commands. Fail-closed on unknown names (see meshcoreTx.ts).
  if (this.receiveOnly && isRfBridgeCommand(cmd)) {
    throw new TxDisabledError(MESHCORE_RECEIVE_ONLY_MESSAGE);
  }
  return this.nativeBackend.sendCommand(cmd, params, timeout);
}
```

This is the belt-and-braces net. The explicit per-method guards below exist because they
produce better error sites and stop work earlier (e.g. before a multi-step loop starts) —
they do not replace this.

#### 2.3.4 Explicit guards — 24 methods

Each method below gets `this.requireTransmit();`. Line numbers verified 2026-08-04.
**`requestNeighbors` is deliberately absent — see §2.3.4b.**

| Method | Line | Method | Line |
|---|---|---|---|
| `sendMessage` | 3072 | `shareContact` | 4310 |
| `sendMessageWithResult` | 3083 | `getNeighbours` | 4667 |
| `performScopedSend` | 3253 | `loginToNode` | 4787 |
| `sendAdvert` | 3669 | `requestNodeStatus` | 4825 |
| `resetContactPath` | 3710 | `ensureGuestLogin` | 4893 |
| `discoverContactPath` | 3753 | `ensureSavedLogin` | 4924 |
| `discoverNodes` | 3789 | `loginToRoom` | 4957 |
| `fetchOwnerName` | 3888 | `sendRoomPost` | 4990 |
| `discoverRegions` | 4021 | `sendCliCommand` | 5185 |
| `traceContactPath` | 4106 | `runCliCommandLocked` | 5228 |
| `tracePathRaw` | 4171 | `requestRemoteTelemetry` | 5678 |
| `pingContactZeroHop` | 4223 | `requestRemoteTelemetryRaw` | 5725 |

`sendAdvert` (`:3669`) matters twice: its Companion branch goes through
`sendBridgeCommand('send_advert')` (`:3687`) and its Repeater branch goes through
`sendRepeaterCommand('advert')` (`:3676`), which bypasses the bridge gate entirely. The guard
at the top of `sendAdvert` is the only thing covering the repeater branch.

##### Insertion point — the rule, and the six methods where it is not "line 1"

**Rule.** The guard goes **after** every existing validation / early-return check (device-type,
`!this.connected`, key-format, cache-hit short-circuits) and **before** the first statement
that mutates instance state, acquires a lock, starts a timer, or performs I/O. A guard placed
after a mutation leaves orphaned state behind when it throws.

The 18 methods not listed below open with a run of pure validation checks, so the guard is
simply the first statement after that run. The six that need care — each was read in full on
2026-08-04:

| Method | Line | First mutation / cost | Correct insertion point |
|---|---|---|---|
| `sendMessageWithResult` | 3083 | Acquires the per-source scope-assert→send lock (the comment block at `:3096`-onward) | After the `!this.connected` (`:3084`) and `REPEATER` (`:3089`) early returns, **before** the lock chain |
| `performScopedSend` | 3253 | Body is one big `try {` (`:3261`) whose first act is asserting the device's global flood scope — a real device write | **Before** the `try`, i.e. the first statement of the method body |
| `getNeighbours` | 4667 | `await this.ensureSavedLogin(publicKey)` at `:4677` — itself an RF login, and it sits *outside* the `try` | After the two early returns at `:4671`-`:4672`, **before** the `ensureSavedLogin` call, so the login is never attempted |
| `ensureGuestLogin` | 4893 | — (cache read first: `guestLoggedInNodes.has(publicKey)` at `:4894`) | **After** the cache-hit short-circuit. An already-established session must still return `true` — no TX is needed to reuse it. Guarding at line 1 would wrongly fail a cached session |
| `sendCliCommand` | 5185 | Installs a promise into `this.cliCommandLocks` at `:5211`-`:5216` | After the validation run ending at `:5203` (`trimmed.length === 0`), **before** `const prior = this.cliCommandLocks.get(...)` |
| `runCliCommandLocked` | 5228 | The whole body is `return new Promise(...)`; the executor's first act is tearing down a stale `pendingCliReplies` entry (`:5236`-`:5241`) and it later installs a timer + pending entry | **Before** `return new Promise(...)` — the first statement of the method body. A throw inside the executor would become a rejection only *after* the stale-entry teardown has run |

**`recordMeshTx()` is not a hazard — verified.** All four call sites (`:4187` `tracePathRaw`,
`:4274` `pingContactZeroHop`, `:5706` `requestRemoteTelemetry`, `:5739`
`requestRemoteTelemetryRaw`) sit **after** a successful `sendBridgeCommand` response, as
post-send bookkeeping. A guard at the top of those methods short-circuits long before
`recordMeshTx()` is reachable, so no last-TX timestamp can be corrupted. Recorded here so
implementers do not re-derive it.

**Contract change to expect.** Several of these methods currently return `false` / `null` /
a structured `{ ok: false, reason }` rather than throwing (`sendAdvert`, `resetContactPath`,
`discoverContactPath`, `pingContactZeroHop`, `shareContact`, `sendRoomPost`, …). Adding
`requireTransmit()` makes them *throw* in receive-only mode. That is intended and matches the
Meshtastic pattern: schedulers never reach the throw (they silent-skip first, §2.3.6), and
routes convert it via `failIfTxDisabled` (§2.5.1). Any other caller that treats a rejection as
fatal must be checked during WP2.

#### 2.3.4b `requestNeighbors` (`:5051`) — gate the remote branch only

**Do NOT put `requireTransmit()` at the top of this method.** Verified body: it has two
mutually exclusive branches selected by `validateMeshCorePubKey(publicKey)`:

```ts
const sanitizedTargetKey = validateMeshCorePubKey(publicKey);
let reply: string;
if (sanitizedTargetKey !== null) {
  await this.ensureSavedLogin(sanitizedTargetKey);              // RF  (:5069)
  const result = await this.sendCliCommand(sanitizedTargetKey, 'neighbors'); // RF (:5070)
  reply = result.reply;
} else {
  const result = await this.sendLocalCliCommand('neighbors');   // serial-only (:5074)
  reply = result.reply;
}
```

The local branch (`publicKey` absent) reads the **locally attached** node's neighbour table
over serial and puts nothing on the air. Interview decision 2 keeps local serial reads working,
so blocking it would be a functional regression.

**Implementation:** add no guard here at all. The remote branch is already covered — both
`ensureSavedLogin` (`:4924`) and `sendCliCommand` (`:5185`) carry their own guards from the
§2.3.4 table, so the remote path throws `TxDisabledError` naturally at `:5069`, while the local
path (`sendLocalCliCommand`, whose only gate is the `advert` verb, §2.3.5) runs untouched.
The everything-downstream-is-guarded property is what makes the no-guard choice safe; the WP2
test in §3.2 pins both halves so a later refactor cannot silently break it.

#### 2.3.5 Local CLI — gate the verb, not the CLI

- **`sendLocalCliCommand` (`:5304`)** — after the existing empty-command check, add:
  ```ts
  if (this.receiveOnly && isTransmittingLocalCliVerb(trimmed)) {
    throw new TxDisabledError(MESHCORE_RECEIVE_ONLY_MESSAGE);
  }
  ```
  This single site covers **both** dispatch branches: the Repeater/Room-Server
  `sendRepeaterCommand` path (`:5322`) and the Companion `runSyntheticLocalCli` path (`:5327`).
  `ver`, `stats`, `clock`, `help` and every repeater `get`/`set` verb stay working.
- **`runSyntheticLocalCli` (`:5344`)** — the `advert` branch is already covered by
  `sendBridgeCommand('send_advert')`; no additional guard needed there. Do **not** gate the
  whole method.
- **Do NOT gate `sendRepeaterCommand` (`:2707`) wholesale.** Its other callers are pure config:
  `get name` / `get radio` (`:2842`-`:2843`), `set name` (`:5408`), `set radio` (`:5439`),
  `set tx` (`:5479`). Blocking them would break interview decision 2 (local serial config stays
  allowed).

#### 2.3.6 Scheduler / timer / auto-* silent skips

Shape at every site (mirrors `meshtasticManager.ts:2278`, `:2440`, `:3354`):

```ts
if (!this.canTransmit()) {
  logger.debug(`⏭️ [MeshCore:${this.sourceId}] <what>: Skipping - receive-only mode`);
  return;
}
```

`logger.debug` only. The single `logger.info` lives in `setReceiveOnly()` and fires only on a
state change.

**Placement rule — this is the load-bearing detail.** The skip must be the **first** statement
inside the timer/interval/cron callback, *before* it reaches any guarded primitive. A guarded
primitive throwing inside a bare `setTimeout` callback produces an unhandled rejection, not a
skip. Verified sites:

| Path | Callback / entry | TX site |
|---|---|---|
| DM ACK retry | `scheduleDmAckTimeout` `:3417`, `setTimeout` cb `:3428` | → `performScopedSend` |
| Channel retry | retry `setTimeout` cb `:3593` | → `performScopedSend` |
| Auto-pathfinding | `:6429`-ish loop; jitter `setTimeout` `:6545`; inner sleeps `:6528` | `:6503`, `:6506` |
| Auto-announce | `:6597` / `:6660` | `:6702`, `:6722` |
| Auto-announce advert | `autoAnnounceAdvertTimer` `:6719` | `:6722` |
| Timer triggers | `:6754` / `:6824` | `:6842`, `:6846` |
| Auto-responder | `checkAutoResponder` `:7050` | `:7113`, `:7117` |
| Auto-acknowledge | `checkAutoAcknowledge` `:7313` | `:7442`, `:7446` |

For the auto-pathfinding loop, the check goes both at loop entry **and** inside the per-target
iteration, because the loop `await`s between targets (`:6528`) and the flag can flip mid-run.

**Confirmed NOT gated** (no RF): `startDeviceTimeSync` (`:4639`), `schedulePathRefresh`
(`:2908` — verified: its callback calls `refreshContacts()` → `get_contacts`, serial-only),
`services/meshcoreTelemetryPoller.ts`, `services/meshcoreObserverPublisher.ts`,
`startHeartbeat` (`:6221`), `scheduleNextReconnect` (`:6388`).

### 2.4 `src/server/meshcoreNativeBackend.ts` — chokepoint B

The backend is a **different class** from the manager and holds no `databaseService` handle.
It learns the state by push, exactly like `respondToDiscovery`:

```ts
/** Receive-only mirror pushed by the manager (#4547). Same mechanism as respondToDiscovery. */
private receiveOnly = false;

/** Set by MeshCoreManager.setReceiveOnly() and on connect in startNativeBackend(). */
setReceiveOnly(enabled: boolean): void { this.receiveOnly = enabled; }
```

Place `setReceiveOnly` immediately after `setRespondToDiscovery` (`:782`).

**Guard 1 — `handleDiscoverRequest` (`:798`).** First statement, before the existing
`if (!this.respondToDiscovery) return;`:

```ts
if (this.receiveOnly) {
  logger.debug(`[MeshCoreNative:${this.sourceId}] Discovery request ignored - receive-only mode`);
  return;
}
```

This is the highest-risk path in the epic: it is push-driven (`PushCodes` handler at `:687`),
it never touches `sendCommand`/`dispatch`, and it calls `c.sendToRadioFrame(out)` directly at
`:831`. It is already rate-limited to 4/120s, so `logger.debug` here cannot spam.

**Guard 2 — `sendCommand()` (belt-and-braces, also pre-covers Phase 3).** At the top of the
public `sendCommand(cmd, params, timeout)`:

```ts
if (this.receiveOnly && isRfBridgeCommand(cmd)) {
  throw new TxDisabledError(MESHCORE_RECEIVE_ONLY_MESSAGE);
}
```

This closes the gap for any caller that reaches the backend without going through
`MeshCoreManager.sendBridgeCommand` (the Virtual Node server in Phase 3, and the raw
ANON_REQ / discover frames at `:1084`, `:1129`, `:1200`, `:1272`, which sit inside `dispatch`
and are therefore reached only via `sendCommand`). Double-gating is harmless — both throw the
identical branded error.

### 2.5 Routes — `409 TX_DISABLED`

#### 2.5.1 Two new exports in `src/server/routes/meshcoreRouteShared.ts`

```ts
/**
 * Router middleware: reject a request on a receive-only MeshCore source with
 * 409 TX_DISABLED. MUST be placed AFTER requirePermission(...) so a 403 still
 * wins over a 409 for an unauthorized caller, and after meshcoreRouteGuard so
 * res.locals.meshcoreManager is populated.
 */
export function requireMeshcoreTx() {
  return (req: Request, res: Response, next: NextFunction) => {
    const mgr = res.locals.meshcoreManager as MeshCoreManager | undefined;
    if (mgr?.isReceiveOnly?.()) {
      return fail(res, 409, TX_DISABLED_CODE, MESHCORE_RECEIVE_ONLY_MESSAGE);
    }
    next();
  };
}

/**
 * Inline guard for handlers that transmit only on some inputs (e.g. POST /cli
 * with the `advert` verb). Returns true when it has already sent the 409.
 */
export function rejectIfReceiveOnly(req: Request, res: Response): boolean {
  if (managerFor(req, res).isReceiveOnly()) {
    fail(res, 409, TX_DISABLED_CODE, MESHCORE_RECEIVE_ONLY_MESSAGE);
    return true;
  }
  return false;
}

/**
 * Catch-block mapping: converts a TxDisabledError raised mid-request (the flag
 * flipped between the pre-check and the send) into 409 instead of 500.
 * Returns true when it has already sent the response.
 */
export function failIfTxDisabled(res: Response, error: unknown): boolean {
  if (isTxDisabledError(error)) {
    fail(res, 409, TX_DISABLED_CODE, MESHCORE_RECEIVE_ONLY_MESSAGE);
    return true;
  }
  return false;
}
```

Every touched handler's existing `catch` block gets `if (failIfTxDisabled(res, error)) return;`
as its first line, ahead of the existing 500 path.

#### 2.5.2 Route call sites — verified line numbers

`requireMeshcoreTx()` inserted after `requirePermission(...)` in the middleware list:

| File | Line | Method + path |
|---|---|---|
| `meshcoreMessagingRoutes.ts` | 255 | `POST /messages/send` |
| | 365 | `POST /rooms/login` |
| | 419 | `POST /rooms/login-with-saved` |
| | 474 | `POST /rooms/post` |
| `meshcoreContactsRoutes.ts` | 167 (`'/contacts/:publicKey/reset-path'` @168) | `POST` |
| | 205 (`…/discover-path` @206) | `POST` |
| | 247 (`'/discover'` @248) | `POST` |
| | 290 (`'/regions/discover'` @291) | `POST` |
| | 313 (`…/trace-path` @314) | `POST` |
| | 358 (`…/ping` @359) | `POST` |
| | 486 (`…/share` @487) | `POST` |
| | **652 (`…/neighbours` @653)** | **`GET`** ← easy miss |
| | 757 (`'/nodes/:publicKey/telemetry/poll'` @758) | `POST` |
| `meshcoreAdminRoutes.ts` | 44 | `POST /admin/login` |
| | 127 | `POST /admin/cli` |
| | 360 | `POST /admin/login-with-saved` |
| | **433** | **`GET /admin/status/:publicKey`** ← easy miss |
| `meshcoreDeviceRoutes.ts` | 262 | `POST /advert` |
| `meshcoreAutomationRoutes.ts` | 580 (`'/automation/announce/send'` @581) | `POST` |
| | 646 (`'/automation/timers/:triggerId/run'` @647) | `POST` |

Conditional transmitters — **do NOT add the `requireMeshcoreTx()` middleware to these**; an
unconditional 409 would break a path that never touches the radio:

| File | Line | Route | Handling |
|---|---|---|---|
| `meshcoreAdminRoutes.ts` | 230 | `POST /cli` | Inline `rejectIfReceiveOnly(req, res)` guarded by `isTransmittingLocalCliVerb(body.command)` — 409 for `advert`, normal execution for `ver` / `stats` / `clock` / `help` |
| `meshcoreContactsRoutes.ts` | 1011 | `POST /neighbors/request` | **No pre-check.** Rely on the primitive throw + `failIfTxDisabled(res, error)` in the catch block |

**`POST /neighbors/request` — correction (see §2.3.4b).** The epic plan listed this as an
unconditional 409 route. It is not: the handler forwards to
`MeshCoreManager.requestNeighbors(publicKey?)`, which reads the **local** node's neighbour
table over serial when `publicKey` is absent. Blocking the whole route would break a
receive-only-legal local read. Correct handling:

- Add **no** `requireMeshcoreTx()` middleware.
- Add `if (failIfTxDisabled(res, error)) return;` as the first line of the existing catch block.
- A request **with** a `publicKey` → `requestNeighbors` → `ensureSavedLogin` throws
  `TxDisabledError` → catch maps it to `409 TX_DISABLED`.
- A request **without** a `publicKey` → local serial read → normal `200`, even while
  receive-only.

**Two GET routes transmit** (`contacts/:pk/neighbours` @652, `admin/status/:pk` @433). A
POST-only sweep misses both. Call this out in the PR description.

**Explicitly NOT gated** (serial-only, must keep working): `PUT /contacts/:publicKey/out-path`
(`meshcoreContactsRoutes.ts:407`), `GET/POST /contacts/:publicKey/export|import` (`:571`,
`:607`), `DELETE /contacts/:publicKey` (`:525`), every `/config/*` route in
`meshcoreConfigRoutes.ts` (`/config/discoverable` `:28`/`:50`, `/config/default-scope` `:75`/
`:98`, `/config/sync-time` `:212`, `/config/reboot` `:251`, `/config/private-key` `:290`/`:321`),
`POST /connect` / `POST /disconnect` (`meshcoreDeviceRoutes.ts:50`, `:105`), and all
`GET` read routes.

### 2.6 `src/server/routes/settingsRoutes.ts` + `src/server/server.ts` — cache invalidation

`settingsRoutes.ts`, in `interface SettingsCallbacks` (~`:155`, next to
`restartAutoDeleteByDistanceService`):

```ts
// MeshCore receive-only (#4547): the manager caches the flag for sync,
// DB-free guards, so a scoped save must push the new value immediately
// rather than waiting for the source to reconnect.
refreshMeshcoreReceiveOnly?: (sourceId: string) => void;
```

In the per-source write branch (`:806`-`:882`), next to the existing
`localStatsIntervalMinutes` / `autoDeleteByDistance*` blocks:

```ts
if ('meshcoreReceiveOnly' in filteredSettings) {
  callbacks.refreshMeshcoreReceiveOnly?.(sourceId);
}
```

`server.ts`, in the `setSettingsCallbacks({...})` object (alongside `restartAnnounceScheduler`
at `:848`):

```ts
refreshMeshcoreReceiveOnly: (sourceId: string) => {
  const mgr = sourceManagerRegistry.getManager(sourceId);
  if (mgr && isMeshCoreManager(mgr)) void mgr.refreshReceiveOnly();
},
```

Use `isMeshCoreManager` from `sourceManagerTypes.ts` — never `instanceof`, never an `as any`
cast (CLAUDE.md hard rule, and `no-explicit-any` is an ESLint error).

The callback fires **after** `setSourceSettings()` has persisted, so `refreshReceiveOnly()`'s
DB read observes the value the user just saved (same post-write-read rationale documented at
`settingsRoutes.ts:~857`).

### 2.7 Frontend read contract (Phase 1 ships the backend half)

**Decision: `GET /api/sources` → `radio` is the primary read path.** Rationale:
- It is already per-source and already multi-source-aware, which is what a MeshCore receive-only
  UI needs (one source can be receive-only while its siblings transmit).
- `computeSourceRadioSummary` is already synchronous and already has an `isMeshCoreManager`
  branch — `canTransmit()` being sync (§2.3.1) makes this a two-line change.
- The client type and consumer already exist (`src/types/elevation.ts:40`,
  `src/hooks/useDashboardData.ts:34`), so Phase 2 gets the data with no new fetch.
- Rejected alternative: a new `GET /api/sources/:id/meshcore/tx-status` endpoint — an extra
  round trip per source and a fourth place to keep in sync.

`src/server/routes/sourceRoutes.ts`:
- Extend `interface SourceRadioSummary` (`:414`) with:
  ```ts
  /** MeshCore only (#4547). True when the source is configured strictly receive-only. */
  receiveOnly?: boolean;
  ```
  (`canTransmit?: boolean` already exists at the end of the interface — reuse it, do not add a
  second field.)
- In the `isMeshCoreManager(mgr)` branch of `computeSourceRadioSummary` (~`:487`):
  ```ts
  const freq = mgr.getLocalNode()?.radioFreq;
  return {
    frequencyMhz: typeof freq === 'number' && Number.isFinite(freq) ? freq : null,
    receiveOnly: mgr.isReceiveOnly(),
    canTransmit: mgr.canTransmit(),
  };
  ```
  Both are sync and cannot throw; the surrounding try/catch already covers the accessor.

`src/types/elevation.ts` — mirror `receiveOnly?: boolean` onto the client
`SourceRadioSummary` (`:40`). `canTransmit` should already be there; add it if not. Purely
additive, no consumer changes in Phase 1.

**Secondary: `GET /api/device/tx-status`.** Extend `deviceStatusRoutes.ts:9` so `useTxStatus` +
`AppBanners` keep working unchanged on a MeshCore-primary install:

```ts
const mgr = resolveSourceManager(txSourceId);
if (isMeshCoreManager(mgr)) {
  const canTx = mgr.canTransmit();
  return res.json({ txEnabled: canTx, udpRelayEnabled: false, canTransmit: canTx });
}
// …existing Meshtastic path unchanged…
```

Keep the existing bare-object wire shape (`res.json`, not `ok()`) — `ApiService` does not
unwrap `data` and `useTxStatus` reads the fields directly. **Implementer must first verify
that `resolveSourceManager(sourceId)` (`src/server/utils/resolveSourceManager.ts`) returns
MeshCore managers for an explicit `?sourceId=`.** If it is Meshtastic-only, resolve via
`sourceManagerRegistry.getManager(sourceId)` + `isMeshCoreManager` inside this handler instead
and note it in the PR. If neither works cleanly, drop this secondary path — `/api/sources` is
the required one and is sufficient for Phase 2.

---

## 3. Test plan

All tests are standard Vitest files inside the existing suite. No standalone scripts. All
DatabaseService mocks use `mockResolvedValue`. No `any` (ESLint ratchet).

### 3.1 `src/server/constants/meshcoreTx.test.ts` — denylist completeness (REQUIRED)

The regression net for "someone adds a new bridge command and forgets to classify it."

- Read `src/server/meshcoreNativeBackend.ts` and `src/server/meshcoreManager.ts` as text
  (`fs.readFileSync`, precedent: `server.settings-persistence.test.ts`).
- Extract every `case '<name>':` in the backend's dispatch switch and every
  `sendBridgeCommand('<name>'` / `sendBridgeCommand(\n '<name>'` literal in the manager
  (there is one multi-line call site at `meshcoreManager.ts:4259-4260` — the regex must
  tolerate a newline between `(` and the literal).
- Assert every extracted name appears in exactly one of `RF_BRIDGE_COMMANDS` /
  `SERIAL_ONLY_BRIDGE_COMMANDS`. Failure message must name the unclassified command and point
  at `meshcoreTx.ts`.
- Assert the two sets are disjoint.
- Assert current sizes: 14 RF / 28 serial-only / 42 total (a deliberate pin, like
  `PER_SOURCE_KEYS_NOT_POSTABLE.size`).
- Assert fail-closed: `isRfBridgeCommand('some_command_that_does_not_exist') === true`.
- Assert `isTransmittingLocalCliVerb`: `'advert'`, `'ADVERT'`, `' advert '` → true;
  `'ver'`, `'stats radio'`, `'clock'`, `'help'`, `'get name'` → false.

### 3.2 `src/server/meshcoreManager.receiveOnly.test.ts` — guards

- `canTransmit()` / `isReceiveOnly()` default to transmit-allowed on a fresh manager.
- `refreshReceiveOnly()` reads `getSettingForSource(sourceId, 'meshcoreReceiveOnly')`
  (`mockResolvedValue('true')`) and flips the flag.
- A DB read that rejects leaves the previously-cached value intact (fail-safe, §2.3.1).
- `setReceiveOnly` emits exactly one `logger.info` on a change and **zero** on a repeat of the
  same value (spy on the logger).
- Every method in the §2.3.4 table rejects with an error satisfying `isTxDisabledError(err)`
  and carrying `code === 'TX_DISABLED'`.
- `sendBridgeCommand` (exercised via a serial-only public method, e.g. `getChannels` /
  `setDeviceName`) still reaches the backend while receive-only. At minimum cover
  `get_channels`, `set_name`, `set_radio`, `get_stats`, `device_query`, `set_device_time`.
- `sendBridgeCommand('send_message', …)` throws even when the calling method's own guard is
  bypassed (call the private via a narrowly-typed test accessor, not `as any`).
- `sendLocalCliCommand('advert')` throws; `sendLocalCliCommand('ver')` does not.
- **`requestNeighbors` branch split (§2.3.4b) — REQUIRED.** While receive-only:
  - `requestNeighbors('<64-hex key>')` (remote branch) rejects with an
    `isTxDisabledError`-satisfying error, and `sendCliCommand` is never reached.
  - `requestNeighbors()` and `requestNeighbors(undefined)` (local branch) **resolve normally**,
    reach `sendLocalCliCommand('neighbors')`, and return parsed neighbours. This is the
    regression net for the "gate the whole method" mistake.
- **Insertion-point checks (§2.3.4).** For each of the six methods with a non-trivial insertion
  point, assert that throwing left no orphaned state: `sendCliCommand` did not add an entry to
  `cliCommandLocks`; `runCliCommandLocked` did not add an entry to `pendingCliReplies` and
  started no timer; `ensureGuestLogin` with an already-cached session returns `true` instead of
  throwing; `getNeighbours` never calls `ensureSavedLogin`.
- `connect()` calls `refreshReceiveOnly()` before arming schedulers, and does so again on a
  second `connect()` (reconnect survival).
- `setReceiveOnly(true)` propagates to `nativeBackend.setReceiveOnly` (spy).

### 3.3 `src/server/meshcoreManager.receiveOnlySchedulers.test.ts` — silent skips

For each of DM-ACK retry, channel retry, auto-pathfinding, auto-announce, auto-announce advert,
timer triggers, auto-responder, auto-acknowledge (use fake timers):

- With receive-only ON: the tick completes, `sendBridgeCommand` is never called, **no promise
  rejection escapes** (assert via an `unhandledRejection` listener or by awaiting the tick and
  asserting it resolves), and the interval/cron is still armed afterwards.
- Run ≥ 5 ticks and assert `logger.info` was called **0 times** across them (no per-tick spam);
  `logger.debug` may be called.
- With receive-only OFF: the same tick does reach the send primitive (proves the skip is
  conditional, not a permanent disable).

Also extend `src/server/services/meshcoreRemoteTelemetryScheduler.test.ts`: with a receive-only
manager, `tickOneManager` returns before calling `requestRemoteTelemetry`. Add matching
coverage for `MeshCoreRoomSyncScheduler.tickOneManager` (`meshcoreRoomSyncScheduler.ts:109`,
which calls `manager.loginToRoom` at `:145`) — a new
`src/server/services/meshcoreRoomSyncScheduler.test.ts` if none exists.

### 3.4 `src/server/meshcoreNativeBackend.receiveOnly.test.ts` — chokepoint B

Model on `src/server/meshcoreNativeBackend.discovery.test.ts:271-303`.

- `setRespondToDiscovery(true)` + `setReceiveOnly(true)` + inbound `0x8E` discovery frame →
  `sendToRadioFrame` **not** called.
- Same, with `setReceiveOnly(false)` → `sendToRadioFrame` called once with a frame whose
  `out[0] === 55` (proves the negative case is not vacuous).
- `setReceiveOnly(true)` then `sendCommand('send_message', {})` rejects with a
  `isTxDisabledError`-satisfying error.
- `setReceiveOnly(true)` then `sendCommand('get_contacts', {})` does **not** throw on the gate.

### 3.5 `src/server/routes/meshcoreRoutes.receiveOnly.test.ts` — 409 mapping

Uses `createRouteTestApp()` (mandatory for new route tests) with the MeshCore routers mounted
and `sourceManagerRegistry` mocked to return a fake MeshCore manager (mock-registry pattern is
still correct; only the DB/permission mocking is replaced by the harness).

- Every route in the §2.5.2 table returns `409` with body
  `{ success: false, code: 'TX_DISABLED', error: MESHCORE_RECEIVE_ONLY_MESSAGE }`. **Both GET
  routes must have their own explicit cases.**
- `POST /admin/cli` with `{ command: 'advert' }` → 409; with `{ command: 'ver' }` → not 409.
  (Note: `/cli` is `meshcoreAdminRoutes.ts:230`; `/admin/cli` at `:127` is remote-admin and is
  unconditionally gated.)
- Ordering: an **unauthorized** user hitting a gated route on a receive-only source still gets
  `403`, not `409` (proves `requireMeshcoreTx` sits after `requirePermission`).
- Negative control: with receive-only OFF, the same routes do not return 409.
- Serial-config still works while receive-only: `POST /config/discoverable`,
  `POST /config/sync-time`, `PUT /contacts/:publicKey/out-path`, `GET /contacts`,
  `GET /messages` all succeed.
- Race mapping: a handler whose manager method throws `TxDisabledError` mid-request (mock the
  manager to reject) returns 409, not 500.

### 3.6 `src/server/meshcoreManager.receiveOnly.perSource.test.ts` — isolation (REQUIRED)

- Two `MeshCoreManager` instances, `source-a` and `source-b`.
- `getSettingForSource` mocked to return `'true'` only for `('source-a', 'meshcoreReceiveOnly')`.
- After `refreshReceiveOnly()` on both: A throws `TxDisabledError` from `sendMessage`; B sends
  successfully.
- `refreshMeshcoreReceiveOnly('source-a')` (via the callback) does not change B's cached flag.
- `computeSourceRadioSummary`-shaped assertion: A reports `{ receiveOnly: true, canTransmit: false }`,
  B reports `{ receiveOnly: false, canTransmit: true }`.

### 3.7 `src/server/routes/sourceRoutes.radio.test.ts` — extend

Add a MeshCore-source case asserting `radio.receiveOnly` and `radio.canTransmit` appear on
`GET /api/sources`, both when the flag is on and off. Existing Meshtastic assertions must be
unchanged.

### 3.8 `src/server/constants/settings.allowlist.test.ts` — run, do not edit

Must pass **unmodified**. A required edit there means the key landed in the wrong array (§2.1).

### 3.9 Whole-suite requirement

Full Vitest suite green (0 failures) before PR. Confirm `success: true` via the JSON reporter —
`rtk`'s `PASS (N) FAIL (0)` summary counts assertion failures only. This change touches no
schema and adds no migration, so the PostgreSQL/MySQL containers are not required, but
`npm run lint:ci` must be clean (judge in-repo failures only:
`npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` → empty).

---

## 4. Work packages

All agents share the one worktree, so **file overlap forces sequencing**.

| File | WP1 | WP2 | WP3 | WP4 | WP5 |
|---|---|---|---|---|---|
| `constants/settings.ts`, `constants/meshcoreTx.ts` | ✅ | | | | |
| `meshcoreManager.ts` | ✅ | ✅ | ✅ | | |
| `meshcoreNativeBackend.ts` | | | ✅ | | |
| `routes/settingsRoutes.ts`, `server.ts` | ✅ | | | | |
| `services/meshcore*Scheduler.ts` | | | ✅ | | |
| `routes/meshcoreRouteShared.ts` + 5 meshcore route files | | | | ✅ | |
| `routes/sourceRoutes.ts`, `routes/deviceStatusRoutes.ts`, `types/elevation.ts` | | | | | ✅ |

**Dependency order:** `WP1` → then `WP2` → `WP3` (strictly sequential: both edit
`meshcoreManager.ts`), with `WP4` and `WP5` running **in parallel** alongside WP2/WP3 (no file
overlap with them, and none with each other).

```
WP1 ──┬── WP2 ── WP3
      ├── WP4        (parallel)
      └── WP5        (parallel)
```

---

### WP1 — Foundations: setting, denylist, manager state, invalidation

**Files:** `src/server/constants/settings.ts`, `src/server/constants/meshcoreTx.ts` (new),
`src/server/meshcoreManager.ts` (state block + `connect()` refresh + `startNativeBackend()`
push + `sendBridgeCommand` gate **only**), `src/server/routes/settingsRoutes.ts`,
`src/server/server.ts`.
**Tests:** §3.1 (`meshcoreTx.test.ts`), and the state/refresh/`sendBridgeCommand` subset of §3.2.

**Acceptance:**
- `meshcoreReceiveOnly` is in `VALID_SETTINGS_KEYS` and `PER_SOURCE_SETTINGS_KEYS`;
  `settings.allowlist.test.ts` passes **unmodified**.
- `isReceiveOnly()` / `canTransmit()` / `setReceiveOnly()` / `refreshReceiveOnly()` exist with
  the §2.3.1 signatures; `canTransmit()` is synchronous and performs no DB access.
- `sendBridgeCommand` throws `TxDisabledError` for every RF command and passes every
  serial-only command while receive-only.
- `isRfBridgeCommand` is fail-closed; `meshcoreTx.test.ts` fails if a `case` is added to the
  native backend without classification (verify by temporarily adding a fake case).
- `POST /api/settings?sourceId=X` with `meshcoreReceiveOnly` invokes
  `refreshMeshcoreReceiveOnly(X)`; a second `connect()` re-reads the flag.
- `tsc` clean, no new `any`.

### WP2 — Manager primitive guards + local CLI verb gate

**Files:** `src/server/meshcoreManager.ts` only. **Depends on:** WP1.
**Tests:** remainder of §3.2.

**Acceptance:**
- All 24 methods in the §2.3.4 table call `this.requireTransmit()`, and each has a test
  asserting `isTxDisabledError`.
- **Guard placement (anti-regression, REQUIRED).** For every guarded method, the
  `requireTransmit()` call sits **after** the existing validation / early-return run and
  **before** the first statement that mutates instance state, acquires a lock, starts a timer,
  or performs I/O. Reviewer checks the six methods named in §2.3.4 explicitly —
  `sendMessageWithResult` (:3083), `performScopedSend` (:3253), `getNeighbours` (:4667),
  `ensureGuestLogin` (:4893), `sendCliCommand` (:5185), `runCliCommandLocked` (:5228) — against
  the insertion points given there. The orphaned-state assertions in §3.2 must be present and
  passing; a guard that throws after a lock/timer/pending-map write fails this package even if
  every other test is green. `recordMeshTx()` needs no attention (verified post-send at all
  four sites).
- **`requestNeighbors` (:5051) is NOT gated** (§2.3.4b). Its remote branch throws via
  `ensureSavedLogin` / `sendCliCommand`; its local branch still works. Both halves have tests.
- `sendLocalCliCommand('advert')` throws on both Companion and Repeater device types;
  `ver` / `stats` / `clock` / `help` / `get name` / `set radio` still work.
- `sendRepeaterCommand` is **not** gated wholesale — `set name` / `set radio` / `set tx` /
  `get name` / `get radio` still function while receive-only (assert at least two).
- No route file, backend file, or scheduler file touched.

### WP3 — Scheduler silent skips + native backend (chokepoint B)

**Files:** `src/server/meshcoreManager.ts` (timer/auto-* callbacks only),
`src/server/meshcoreNativeBackend.ts`, `src/server/services/meshcoreRemoteTelemetryScheduler.ts`,
`src/server/services/meshcoreRoomSyncScheduler.ts`.
**Depends on:** WP2 (same file). **Tests:** §3.3, §3.4.

**Acceptance:**
- Every path in the §2.3.6 table skips first-statement-in-callback, logs at `debug`, and leaves
  its timer/cron armed.
- Across ≥ 5 ticks with receive-only ON, `logger.info` fires zero times; the only `info` is the
  one-shot state-change line in `setReceiveOnly`.
- No unhandled promise rejection from any timer path (explicitly asserted).
- `handleDiscoverRequest` emits no `sendToRadioFrame` while receive-only; it does when the flag
  is off.
- `MeshCoreNativeBackend.setReceiveOnly` exists and `sendCommand` gates RF commands.
- Both scheduler services return before their TX call.

### WP4 — Route layer: shared helpers + 409 mapping

**Files:** `src/server/routes/meshcoreRouteShared.ts`, `meshcoreMessagingRoutes.ts`,
`meshcoreContactsRoutes.ts`, `meshcoreAdminRoutes.ts`, `meshcoreDeviceRoutes.ts`,
`meshcoreAutomationRoutes.ts`. **Depends on:** WP1. **Parallel with:** WP2, WP3, WP5.
**Tests:** §3.5.

**Acceptance:**
- `requireMeshcoreTx`, `rejectIfReceiveOnly`, `failIfTxDisabled` exported from
  `meshcoreRouteShared.ts`, all emitting via `fail(res, 409, TX_DISABLED_CODE, …)`.
- All 20 unconditional routes in §2.5.2 (including **both GET routes**) return 409.
- The two conditional routes behave per §2.5.2: `POST /cli` returns 409 only for the `advert`
  verb; `POST /neighbors/request` returns 409 only when a `publicKey` is supplied.
- `POST /neighbors/request` with a `publicKey` → 409; **without** a `publicKey` → not 409
  (local serial read still works while receive-only). Both cases required.
- A 403 still beats a 409 for an unauthorized caller.
- Every touched handler's catch block maps `TxDisabledError` → 409 rather than 500.
- Config/read/connect routes listed as "explicitly NOT gated" still return their normal
  responses while receive-only.
- Tests use `createRouteTestApp()`; no new `vi.mock('../../services/database.js', …)`.

### WP5 — Frontend read contract + per-source isolation

**Files:** `src/server/routes/sourceRoutes.ts`, `src/server/routes/deviceStatusRoutes.ts`,
`src/types/elevation.ts`. **Depends on:** WP1. **Parallel with:** WP2, WP3, WP4.
**Tests:** §3.6, §3.7.

**Acceptance:**
- `GET /api/sources` returns `radio.receiveOnly` and `radio.canTransmit` for MeshCore sources;
  the Meshtastic branch and every existing field are byte-identical.
- `src/types/elevation.ts` `SourceRadioSummary` mirrors the new field.
- `GET /api/device/tx-status?sourceId=<meshcore>` reports the receive-only state in the existing
  `{ txEnabled, udpRelayEnabled, canTransmit }` shape — **or** the PR documents why
  `resolveSourceManager` could not resolve a MeshCore manager and this half was dropped.
- `meshcoreManager.receiveOnly.perSource.test.ts` proves source A's flag does not affect
  source B, in both the manager guards and the radio summary.

---

## 5. Phase 1 exit criteria

1. With `meshcoreReceiveOnly=true` on a MeshCore source, no code path reaches
   `sendToRadioFrame` or an RF bridge command — verified by the denylist test, the backend
   discovery test, and the manager guard tests.
2. Every route in §2.5.2 returns `409 TX_DISABLED`; serial config, contact CRUD, reads, and
   connect/disconnect all still work.
3. Schedulers keep ticking and skip silently; no per-tick log spam; no unhandled rejections;
   no user automation setting is mutated.
4. The flag survives `connect()` reconnects and takes effect on a settings write without a
   restart.
5. `GET /api/sources` exposes the state per source for Phase 2.
6. Full Vitest suite green; `npm run lint:ci` clean of in-repo failures; no new `any`; no new
   emoji/Unicode icon stand-ins in any user-facing string.

## 6. Known non-goals for Phase 1

- No UI. No toggle, no banner, no disabled controls (Phase 2).
- No Virtual Node command rejection (Phase 3) — though `MeshCoreNativeBackend.sendCommand`'s
  gate (§2.4) already blocks any VN command that routes through it.
- No user-facing docs (Phase 3).
- MeshMonitor cannot stop firmware-autonomous transmissions (link-layer ACKs, on-device advert
  schedules set outside MeshMonitor). Documented in Phase 3; do not attempt a workaround here.
