# MeshMapper Observer, Phase 1 Spec: multi-broker observer backend

**Epic:** [#5014](https://github.com/Yeraze/meshmonitor/issues/5014)
**Phase plan:** `docs/internal/dev-notes/MESHMAPPER_OBSERVER_EPIC.md` (Phase 1)
**Prior art:** `MESHCORE_OBSERVER_PHASE1_SPEC.md` (key store, routes, validation),
`MESHCORE_OBSERVER_PHASE2_SPEC.md` (publisher, wire contract, status)

**Scope:** backend only. One MeshCore source publishes the same OTA packet
stream to N Analyzer brokers concurrently, with per-broker connection state,
counters, credentials and tokens. Config is a JSON blob in `sources.config`,
so there is **no DB migration in this phase**. The Dashboard broker-list
editor, the presets, and the status panels are Phase 2.

**Non-goals (deferred, per the epic's interview decisions):** packet
filtering, node allow/block lists, bbox limits, rate limiting. v1 forwards
everything, matching `agessaman/meshcore-packet-capture`. The relay is
passive, so there is zero airtime cost and the Mesh Impact Checklist has no
new limits to set.

---

## 1. Reuse inventory (mandatory, read before writing code)

Everything below already exists and MUST be used or extended. Anything not on
this list needs a justification against the closest entry.

### 1.1 Services and helpers that must be reused as-is

| Thing | File | How Phase 1 uses it |
|---|---|---|
| `MqttBrokerClient` + `MqttBrokerClientOptions` | `src/server/transports/mqttBrokerClient.ts` | One instance per broker. Unchanged. The `will` / `keepalive` / `clientIdPrefix` wiring the publisher already builds is moved verbatim into the per-broker connection. |
| `normalizeBrokerUrl` | `src/server/transports/mqttBrokerClient.ts` | Normalizes each `brokers[].url` exactly as it normalizes today's single `brokerUrl`. **Do not modify it** (shared with the MQTT bridge). |
| `observerTopics(iataCode, publicKey)` | `src/server/services/meshcoreObserverPacket.ts` | Unchanged. Called once per distinct topic public key, not once per broker. |
| `buildObserverPacketPayload` / `buildObserverStatusPayload` / `ObserverPacketIdentity` / `ObserverStatsInput` | `src/server/services/meshcoreObserverPacket.ts` | Unchanged. The wire contract is identical for every broker: that is exactly why one source can dual-publish. |
| `mintObserverToken(privateKeyHex, audience, opts)` | `src/server/services/meshcoreObserverToken.ts` | Unchanged. Already takes an explicit audience, so per-broker audiences need no new signing code. |
| `MeshCoreObserverKeyStore` | `src/server/services/meshcoreObserverKeyStore.ts` | Unchanged. One signing key per source, shared by every token-mode broker. |
| `ok()` / `fail()` | `src/server/utils/apiResponse.ts` | The new `GET /observer/status` route uses these, like every other handler in `sourceObserverRoutes.ts`. |
| `requirePermission(resource, action, { sourceIdFrom })` | `src/server/auth/authMiddleware.ts` | Same call shape as the sibling observer routes. |
| `resolveMeshCoreSource(req, res)` | `src/server/routes/sourceObserverRoutes.ts` (module-local) | Reused verbatim by the new status route. |
| `refreshObserverPublisher(source)` | `src/server/routes/sourceObserverRoutes.ts` (module-local) | Reused by the new per-broker credential writes, same hot-swap semantics. |
| `auditMeshcoreEvent` | `src/server/routes/meshcoreRouteShared.ts` | New credential events audited the same way (event fired, values never recorded). |
| `sourceManagerRegistry.reconfigureObserver(id, cfg)` | `src/server/sourceManagerRegistry.ts` | Unchanged duck-typed hot-swap seam. `brokers[]` rides through it as part of the raw observer block. |
| `deepEqualIgnoring(a, b, ['observer'])` hot-swap branch | `src/server/routes/sourceRoutes.ts` (~line 1090) | **Unchanged.** It stringifies the whole `observer` block, so a `brokers[]` edit already routes to the hot-swap branch instead of a device restart. |
| `MqttBridgePublisherPool` | `src/server/mqttBridgePublisherPool.ts` | **Structural precedent, not a dependency.** Copy its `PoolEntry` shape (client + publishes + lastPublishAt + lastError) and its lazy-entry / no-idle-eviction policy. Do not import it: it keys on Meshtastic gateway ids, shares one URL across entries, and has no LWT, all of which are wrong here. |

### 1.2 Test harnesses that must be reused

| Harness | Where | Used by |
|---|---|---|
| `createRouteTestApp()` / `RouteTestHarness` | `src/server/test-helpers/routeTestApp.ts` | Every route test in WP4. Mandatory per CLAUDE.md. See `sourceObserverRoutes.perSource.test.ts` for the "seed my own meshcore source, then grant against its id" recipe (the harness's built-in `sourceA`/`sourceB` are `meshtastic_tcp`). |
| `vi.mock('mqtt')` + `makeFakeClient()` fake mqtt.js client | `src/server/services/meshcoreObserverPublisher.test.ts` (lines 1-70) | Every publisher test. Drives the **real** `MqttBrokerClient` underneath, so per-broker CONNECT options (LWT topic, username, password) are asserted for real. `mockConnect.mock.calls` gives one entry per broker, which is how multi-broker assertions read connections apart. |
| `createClient` / `mintToken` / `loadCredentials` injection seams | `MeshCoreObserverPublisherOptions` | Kept, with widened signatures (see 3.3). Do not add a fourth seam. |
| `setMeshCoreObserverCredentialStoreForTesting` / `setMeshCoreObserverKeyStoreForTesting` | the two stores | Credential-store tests keep using these. |
| Deterministic clamped orlp private key recipe | `sourceObserverRoutes.perSource.test.ts` lines 19-26 | Reuse for any test needing a real signing key. |
| `vi.useFakeTimers()` around `RENEWAL_CHECK_MS` / `STATUS_REFRESH_MS` | `meshcoreObserverPublisher.test.ts` | Reuse for the multi-broker renewal and status-refresh tests. |

### 1.3 New things, and why the closest existing mechanism does not fit

| New thing | Closest existing mechanism | Why it is not enough |
|---|---|---|
| `src/server/services/meshcoreObserverStatus.ts` (types only) | `MeshCoreObserverStatus` currently lives in `meshcoreObserverPublisher.ts` | The new `GET /observer/status` route needs the type without importing the publisher (which value-imports the credential store, the token minter and `package.json`). A types-only module also lets WP3 and WP4 run in parallel without touching the same file. The publisher re-exports both types, so every existing import path keeps working. |
| `ObserverBrokerConnection` (module-private class inside `meshcoreObserverPublisher.ts`) | `MqttBridgePublisherPool`'s `PoolEntry` | Pool entries there share one URL, one credential and no LWT. Observer brokers differ in URL, auth mode, audience, credential and LWT topic. Same shape, different content: copy the shape, keep it local to the publisher rather than generalizing the pool (a shared abstraction over two pools with no common config would be a worse artifact than two small ones). |
| Encrypted credential **document** (v2) inside the existing envelope | `meshcore_observer_credentials` one row per source | Per-broker credentials need per-broker keying. See §4 for the full trade-off against the rejected new-table migration. |
| `observerBrokerKey(url)` | none | Two lines, but it is the identity function for credentials, status and dedupe. It must live in exactly one place. |

---

## 2. Config schema and normalization

### 2.1 Persisted shape (`sources.config.observer`)

`src/server/meshcoreConfig.ts`. Every legacy field is **kept and still
honoured**; `brokers` is purely additive.

```ts
/** One Analyzer broker this source publishes to (#5014 Phase 1). */
export interface MeshCoreObserverBrokerConfig {
  /** ws/wss/mqtt/mqtts URL, or a bare host:port that normalizeBrokerUrl accepts. */
  url: string;
  /** Defaults to the block-level authMode, which itself defaults to 'token'. */
  authMode?: 'token' | 'password';
  /**
   * Required in token mode. NOT inherited from the block-level tokenAudience:
   * two brokers with different audiences are the normal case, and silently
   * inheriting one would mint tokens the other broker rejects. The only
   * exception is the legacy synthesized entry (see 2.3).
   */
  tokenAudience?: string;
  /** Free-text display label, e.g. "MeshMapper". UI only, never on the wire. */
  label?: string;
}

export interface MeshCoreObserverConfig {
  enabled?: boolean;
  /** Block-level default auth mode. LEGACY + default for brokers[] entries. */
  authMode?: 'token' | 'password';
  /** LEGACY single broker. See the precedence rule in 2.3. */
  brokerUrl?: string;
  /** Shared across every broker: it is the observer's REGION, not a broker property. */
  iataCode?: string;
  /** LEGACY single audience. Applies only to the legacy broker entry. */
  tokenAudience?: string;
  /** Multi-broker list (#5014). When present and non-empty it is authoritative. */
  brokers?: MeshCoreObserverBrokerConfig[];
}
```

**`iataCode` stays block-level on purpose.** It is the region segment of the
topic (`meshcore/{IATA}/{PUBKEY}/packets`) and identifies *where the observer
is*, not which broker it talks to. MeshMapper and LetsMesh both want the same
region for the same physical node. Keeping it shared also keeps the blob
small (see 2.5).

### 2.2 Normalized runtime shape

Returned by `observerConfigFromSource`, consumed by the publisher.

```ts
export interface NormalizedObserverBroker {
  /** Stable identity: normalizeBrokerUrl(url).toLowerCase(). Non-secret. */
  key: string;
  /** normalizeBrokerUrl(url). */
  url: string;
  authMode: 'token' | 'password';
  /** Present iff authMode === 'token' (normalization drops token brokers without one). */
  tokenAudience?: string;
  label?: string;
  /**
   * True iff this entry corresponds to the block-level legacy `brokerUrl`.
   * The publisher uses it, and only it, to fall back to the pre-#5014
   * single-credential row. See 2.3 and §4.3.
   */
  legacy: boolean;
}

/**
 * Superset of the pre-#5014 runtime shape: the flat brokerUrl / authMode /
 * tokenAudience fields are RETAINED as mirrors of brokers[0] so every
 * existing reader (and every existing test) keeps compiling and keeps
 * observing the same values for a single-broker source.
 */
export interface NormalizedObserverConfig {
  enabled: true;
  iataCode: string;
  brokers: NormalizedObserverBroker[];
  authMode: 'token' | 'password';
  brokerUrl: string;
  tokenAudience?: string;
}
```

`MeshCoreConfig['observer']` (in `meshcoreManager.ts`) is retyped from
`MeshCoreObserverConfig` to `NormalizedObserverConfig | undefined`. This is a
narrowing, not a widening: the manager only ever assigns it from
`observerConfigFromSource`.

### 2.3 The normalization function

```ts
/** Stable, case-insensitive broker identity. The one place this is derived. */
export function observerBrokerKey(url: string): string;   // throws only if normalizeBrokerUrl throws

/**
 * Pure: turns the persisted (legacy or multi) observer block into the ordered,
 * deduped, validated broker list. Exported for direct unit testing.
 * Never throws. Returns [] when nothing usable is configured.
 */
export function normalizeObserverBrokers(
  o: MeshCoreObserverConfig | undefined | null,
): NormalizedObserverBroker[];

/** Unchanged signature. Now returns the richer NormalizedObserverConfig. */
export function observerConfigFromSource(
  cfg: MeshCoreSourceConfig,
): MeshCoreConfig['observer'];
```

`normalizeObserverBrokers` semantics, in order:

1. **Source list selection.** If `o.brokers` is a non-empty array, that array
   is authoritative and `o.brokerUrl` is **not** added as an extra entry.
   Otherwise, synthesize a single entry from `o.brokerUrl` (when present).

   > This rule is safety-critical. The Phase 2 UI will migrate the legacy
   > broker into `brokers[0]` and may well leave the stale top-level
   > `brokerUrl` in the blob. Appending both would double-publish every packet
   > to the same broker. The dedupe in step 5 would usually catch it, but only
   > if the two spellings normalize identically; the precedence rule removes
   > the whole class of bug.

2. **Per-entry auth mode:** `entry.authMode ?? o.authMode ?? 'token'`.

3. **Per-entry audience:** `entry.tokenAudience?.trim()`. For the *synthesized
   legacy* entry only, fall back to `o.tokenAudience?.trim()`.

4. **Per-entry URL:** `normalizeBrokerUrl(entry.url)`. On throw, `logger.warn`
   naming the index and **skip that entry only**. One malformed broker must
   not disable the others (this is a deliberate change from the pre-#5014
   all-or-nothing rule, which had exactly one broker to lose).

5. **Dedupe by `key`, first wins**, with a `logger.debug` on the discard.

6. **Completeness:** drop a `token`-mode entry with no `tokenAudience`
   (`logger.warn`). A `password`-mode entry needs no audience. This mirrors
   `observerConfigFromSource`'s existing per-mode rule, applied per broker.

7. **Legacy flag:** `legacy = true` when the entry was synthesized from
   `o.brokerUrl`, **or** when `o.brokerUrl` is present and
   `observerBrokerKey(o.brokerUrl) === entry.key`. The second clause is what
   keeps the stored pre-#5014 credential reachable after the Phase 2 UI moves
   that broker into `brokers[]`. At most one entry can carry it (dedupe
   guarantees key uniqueness).

`observerConfigFromSource` then:

- returns `undefined` when `!o?.enabled`, when `iataCode` is missing, or when
  `normalizeObserverBrokers` returns `[]` (preserving today's
  "incomplete block disables the observer" contract);
- otherwise returns `{ enabled: true, iataCode: o.iataCode.trim().toUpperCase(),
  brokers, authMode: brokers[0].authMode, brokerUrl: brokers[0].url,
  tokenAudience: brokers[0].tokenAudience }`.

`observerAuthMode(o)` is unchanged and still exported (the publisher inlines
its logic to dodge an import cycle; that stays true).

### 2.4 Server-side validation

`validateObserverConfig(type, config)` in `src/server/routes/sourceRoutes.ts`
(exported, already unit-tested by `sourceRoutes.observerValidation.test.ts`).
Additive changes only; every existing rule and error code is preserved.

Refactor first: extract the existing broker-URL check (explicit-scheme
rejection before normalization, then `new URL(normalizeBrokerUrl(...))`,
then protocol + hostname assertions) into a module-local helper:

```ts
function validateBrokerUrlValue(
  value: unknown,
  field: string,   // 'observer.brokerUrl' | 'observer.brokers[2].url'
): { status: number; error: string; code: string } | null;
```

Then apply it to both the legacy field and every `brokers[]` entry. **The
explicit-scheme pre-check must not be lost in the extraction** (it is the
guard against `http://host` laundering into `mqtt://http://host`).

New rules, all inside the `enabled === true` branch except where noted:

| Rule | Code | Status |
|---|---|---|
| `observer.brokers`, when present, must be an array (checked regardless of `enabled`) | `INVALID_PARAMETER_TYPE` | 400 |
| `observer.brokers.length <= MAX_OBSERVER_BROKERS` (**8**) | `TOO_MANY_BROKERS` | 400 |
| Each entry must be a non-null, non-array object | `INVALID_PARAMETER_TYPE` | 400 |
| Each entry runs `observerConfigContainsKeyMaterial` (checked regardless of `enabled`, same as the block) | `OBSERVER_KEY_IN_CONFIG` | 400 |
| Each `entry.url` runs `validateBrokerUrlValue` | `INVALID_PARAMETER` / `INVALID_BROKER_URL` | 400 |
| `entry.authMode`, when present, is `'token'` or `'password'` | `INVALID_OBSERVER_AUTH_MODE` | 400 |
| Token-mode entry needs a `tokenAudience`: non-empty string, no whitespace, <= 255 | `INVALID_PARAMETER` | 400 |
| `entry.label`, when present, is a string <= 64 chars | `INVALID_PARAMETER` | 400 |
| Normalized URLs must be unique across the array | `DUPLICATE_BROKER_URL` | 400 |
| **Relaxed:** when `enabled === true`, require `brokerUrl` **or** a non-empty `brokers[]`, not `brokerUrl` alone | `MISSING_BROKER` | 400 |

The `MISSING_BROKER` relaxation is what lets the Phase 2 UI stop writing the
legacy field. Existing configs (legacy field, no `brokers`) still pass through
the unchanged `brokerUrl` branch, so no currently-valid config becomes
invalid.

### 2.5 Observer block size guard (MySQL `sources.config` is `varchar(4096)`)

**Decision: cap the serialized `observer` block only. There is deliberately NO
whole-config size guard.**

A universal `MAX_SOURCE_CONFIG_BYTES = 4096` check across every source type was
considered and **rejected as a back-compat break**. SQLite `TEXT` and
PostgreSQL `text` have no 4096 limit, so an existing deployment can legitimately
be holding a larger config today. The plausible case is a big `mqtt_bridge`
block with many subscriptions, filters and topic rewrites. A universal 400
`CONFIG_TOO_LARGE` would make that source **uneditable after upgrade**: the
operator could not even open the form and shrink it, because the save path
would reject the blob it just loaded. Phase 1 must not be able to brick an
existing source it has nothing to do with.

Capping only the observer block is additive by construction: the constraint
applies to a field this phase is introducing, so it cannot invalidate a config
that is valid today. Add to `sourceRoutes.ts`, inside `validateObserverConfig`
(not as a separate validator, and not on any other source type):

```ts
/**
 * Serialized-byte ceiling for the `observer` block alone.
 *
 * `sources.config` is `varchar(4096)` on MySQL (TEXT on SQLite/PostgreSQL), so
 * the blob as a whole has a hard limit on ONE backend. We deliberately do not
 * police the whole blob (that would reject pre-existing oversized configs on
 * the backends where they are legal), only the part #5014 adds. 1536 bytes is
 * ~37% of the MySQL column, which keeps a fully-populated 8-broker observer
 * comfortably clear of transport + virtualNode config in the same blob.
 */
export const MAX_OBSERVER_CONFIG_BYTES = 1536;
```

Checked once, after the per-broker rules pass and regardless of `enabled` (a
disabled-but-huge block would still be persisted):

```
if (Buffer.byteLength(JSON.stringify(observerObj), 'utf8') > MAX_OBSERVER_CONFIG_BYTES)
    -> { status: 400, code: 'OBSERVER_CONFIG_TOO_LARGE' }
```

Budget check: a broker entry costs ~150 bytes serialized (url ~40, tokenAudience
~30, label ~20, authMode ~20, plus ~40 of JSON punctuation and key names). Eight
of them is ~1200 bytes; `enabled` + `iataCode` + the retained legacy mirrors add
~150. So `MAX_OBSERVER_BROKERS = 8` fits inside 1536 with headroom, and the two
constants are chosen together: neither is arbitrary and neither should be raised
without re-checking the other.

**MySQL diagnostic (non-rejecting).** The pre-existing whole-blob risk on MySQL
is not made worse by this phase, but it is worth surfacing. In the source
create/update handlers (where `databaseService` is already imported), after
validation passes:

```
if (databaseService.drizzleDbType === 'mysql'
    && Buffer.byteLength(JSON.stringify(config), 'utf8') > 4096) {
  logger.warn(`Source ${id} config exceeds the MySQL varchar(4096) column width; the write may fail or truncate`);
}
```

This never rejects and never changes a status code. It exists so an operator
hitting a driver-level truncation has a log line naming the cause instead of an
opaque write failure.

---

## 3. Publisher: one instance, N clients

### 3.1 Decision: one publisher owning N connections (not N publishers)

**Chosen: one `MeshCoreObserverPublisher` owning an internal array of
`ObserverBrokerConnection`.** Reasons, strongest first:

1. **`stats()` costs a device round-trip.** Every publisher arms a
   `STATUS_REFRESH_MS` (5 min) timer that calls `stats()`, which runs
   `get_stats core` + `radio` over the local bridge. N publishers means N
   times the device polling for identical data. One publisher reads stats once
   per tick and publishes the resulting status to every broker.
2. **Payload construction is on the packet hot path.** `handleOtaPacket` runs
   at mesh packet rate. Building and `JSON.stringify`-ing the payload once and
   publishing the same `Buffer` to every broker is the whole point; N
   publishers would each rebuild it from the same event.
3. **One lifecycle field in the manager.** `observerPublisher` stays a single
   nullable field, and `startObserver` / `stopObserver` / `getObserverStatus`
   / `reconfigureObserver` keep their exact shapes. N publishers would push
   pool management into `meshcoreManager.ts`, which is the file we least want
   to grow.
4. **One `getStatus()` aggregate.** The manager's `getStatus()` conditional
   spread (`...(observer ? { observer } : {})`) is preserved byte-for-byte for
   single-broker sources.
5. Token minting dedupes across brokers that share an audience (§3.4). N
   publishers cannot see each other's tokens.

### 3.2 `ObserverBrokerConnection` (module-private, in `meshcoreObserverPublisher.ts`)

Owns everything that is per-broker. Never throws out of any method.

```ts
interface BrokerConnectionDeps {
  sourceId: string;
  iataCode: string;
  device: MeshCoreObserverPublisherOptions['device'];
  createClient: (opts: MqttBrokerClientOptions) => MqttBrokerClient;
  /** Called when this connection hard-stops on repeated auth rejection. */
  onAuthHardStop: (key: string) => void;
}

type ResolvedCredential =
  | { kind: 'ok'; username: string; password: string; publicKey: string; tokenExpiresAt: number | null }
  | { kind: 'error'; message: string; keyStored: boolean };

class ObserverBrokerConnection {
  constructor(broker: NormalizedObserverBroker, deps: BrokerConnectionDeps);

  readonly key: string;
  readonly broker: NormalizedObserverBroker;

  /** Topic public key for this connection, or null before a successful start. */
  get originId(): string | null;

  /** Connect with a resolved credential. Records failures in lastError; never throws. */
  async start(cred: ResolvedCredential): Promise<void>;

  /** Publish offline status (best-effort) then disconnect({ flush: true }). Idempotent. */
  async stop(): Promise<void>;

  /**
   * Sync. Drops (dropped++) when the socket is down. Takes a PRE-SERIALIZED
   * buffer so the caller can share one across brokers with the same originId.
   */
  publishPacket(payload: Buffer): void;

  /** Publish the retained online status with the caller's already-read stats. */
  async publishOnlineStatus(stats: ObserverStatsInput | null): Promise<void>;

  /** Tear down and reconnect with a fresh token (D-9: mqtt.js bakes creds into CONNECT). */
  async rebuildWithToken(token: ObserverToken): Promise<void>;

  getStatus(): MeshCoreObserverBrokerStatus;
  isConnected(): boolean;
}
```

Per-connection state, all moved off the publisher: `client`, `topics`,
`tokenPublicKey`, `keyStored`, `publishes`, `dropped`, `lastPublishAt`,
`lastError`, `tokenExpiresAt`, `authFailures`, `authStopping`.

Behaviour that moves in **unchanged** (it is per-socket by nature):

- `buildClientOptions`: LWT built from this broker's own status topic,
  `clientIdPrefix: 'meshmonitor-observer'`, `keepalive: 60`.
- `wireClientListeners`: the `error` listener still skips CONNACK codes 4/5 so
  the `permission-denied` message wins; `permission-denied` still increments
  `authFailures` and hard-stops at `MAX_AUTH_FAILURES`.
- `redactToken()` applied to every `lastError` assignment. **The regex and the
  helper stay module-level and shared**, not duplicated per connection.
- The `publishOnlineStatus` re-read-after-await discipline (capture `client`
  into a local after the await, then null-check that local).

**Behaviour change, deliberate and worth calling out in the PR:**
`MAX_AUTH_FAILURES` now hard-stops **only the offending connection**, not the
whole observer. A LetsMesh credential typo must not silence MeshMapper. The
publisher's timers stay armed while at least one connection is alive; when the
last one hard-stops, `onAuthHardStop` lets the publisher clear its timers and
set `running = false`.

### 3.3 `MeshCoreObserverPublisher` public surface

Unchanged method names and contracts. Only the option seams widen:

```ts
export interface MeshCoreObserverPublisherOptions {
  sourceId: string;
  config: NonNullable<MeshCoreConfig['observer']>;   // now NormalizedObserverConfig
  device: () => { origin: string; model?: string; firmwareVersion?: string; radio?: string; publicKey?: string };
  stats?: () => Promise<ObserverStatsInput | null>;

  /** WIDENED: audience is now explicit, because brokers differ. */
  mintToken?: (sourceId: string, audience: string) => Promise<ObserverTokenResult>;

  /** WIDENED: per-broker key + the legacy-fallback flag. */
  loadCredentials?: (
    sourceId: string,
    brokerKey: string,
    legacy: boolean,
  ) => Promise<ObserverCredentialLoadResult>;

  createClient?: (opts: MqttBrokerClientOptions) => MqttBrokerClient;
}
```

Defaults:

- `mintToken` -> `(id, aud) => mintObserverTokenForSourceDetailed(id, aud)`
- `loadCredentials` -> `(id, key, legacy) => resolveBrokerCredential(id, key, legacy)`
  (§4.3, a small module-local function over the store)

`start()` keeps its **never-throw** contract:

1. Reset `authStopping` / `authFailures` on every connection.
2. Build one `ObserverBrokerConnection` per `config.brokers` entry.
3. **Resolve credentials.**
   - Token mode: collect the distinct `tokenAudience` values, mint one token
     per audience (`Promise.allSettled` over the distinct set), cache in
     `tokensByAudience: Map<string, ObserverToken>`. A failed mint marks every
     connection on that audience with the mapped `LAST_ERROR` message and
     `keyStored = false`, exactly as today's `mintFailureMessage` does.
   - Password mode: `loadCredentials(sourceId, key, legacy)` per connection,
     plus the existing `device().publicKey` requirement (`LAST_ERROR.noPublicKey`).
4. `await Promise.allSettled(connections.map(c => c.start(cred)))`. A rejected
   settle is logged at `debug` and left as that connection's `lastError`; it
   never propagates.
5. Arm **one** renewal timer (only when at least one token-mode connection
   exists) and **one** status-refresh timer.
6. `this.running = true` when at least one connection was constructed.

`stop()`: `await Promise.allSettled(connections.map(c => c.stop()))`, clear
both timers, `running = false`, empty the connection list. Still idempotent,
still best-effort per connection.

`handleOtaPacket(event)`: sync, never throws.

```
group the connections by originId (skip connections with a null originId)
for each group:
    identity = { origin: device().origin, originId }
    payload  = buildObserverPacketPayload(event, identity)
    if (!payload) continue                       // blank/missing raw_hex, as today
    buf = Buffer.from(JSON.stringify(payload))   // built ONCE per group
    for each connection in group: connection.publishPacket(buf)
```

A connection with a null `originId` (never successfully started) counts a
`dropped`, matching today's behaviour when `tokenPublicKey` is null. In
practice there is exactly one group: token mode derives `originId` from the
one signing key, password mode from the one node public key.

`refreshStatus()` tick: keep the `refreshingStatus` latch, read `stats()`
**once**, then `await Promise.allSettled(connected.map(c =>
c.publishOnlineStatus(stats)))`. Skip entirely when no connection is
connected (preserves the "never let a publish reach a disconnected client"
invariant).

`checkRenewal()` tick: keep the `renewing` latch. For each entry in
`tokensByAudience` whose `expiresAt` is inside
`RENEWAL_CHECK_MS / 1000 + RENEWAL_THRESHOLD_S`, re-mint for that audience;
on success replace the cached token and `rebuildWithToken` every connection on
that audience; on failure set those connections' `lastError` and leave their
sockets untouched (a transient mint failure must never tear down a working
connection). **Never hardcode the derived 3900s window.**

### 3.4 Token minting per broker

`src/server/services/meshcoreObserverToken.ts`:

```ts
export async function mintObserverTokenForSourceDetailed(
  sourceId: string,
  audienceOverride?: string,
): Promise<ObserverTokenResult>;
```

- With no override: **behaviour is byte-identical to today** (reads
  `observerConfigFromSource(cfg)?.tokenAudience`, which is now the
  `brokers[0]` mirror, i.e. the same value for every pre-#5014 config).
- With an override: still requires the source to exist and be `meshcore`, and
  still requires an enabled observer block, but uses the override as the
  audience and skips the `!observer.tokenAudience -> not_configured` gate.
- `mintObserverTokenForSource(sourceId)` (the flat `| null` wrapper) is
  unchanged and untouched.

Minting is deduped **by audience**, not by broker: two brokers sharing an
audience share one WASM signature and one token. Renewal follows the same
grouping.

### 3.5 `meshcoreManager.ts` changes

Small and mechanical:

- `MeshCoreConfig['observer']` retyped to `NormalizedObserverConfig | undefined`.
- `startObserver()` / `stopObserver()` / `getObserverStatus()` /
  `reconfigureObserver()`: **no logic changes.** The publisher constructor
  call, the `device` closure, the `stats` closure, the `ota_packet`
  subscribe/unsubscribe and the try/catch are all unchanged.
- `MeshCoreSourceStatus.observer` picks up the new aggregate + `brokers` shape
  through the type import. The conditional spread in `getStatus()` is unchanged.
- The `!this.nativeBackend` companion-only guard is unchanged.

---

## 4. Credentials: per-broker, no migration

### 4.1 Decision, and the rejected alternative

**Chosen: keep `meshcore_observer_credentials` at one row per source, and make
the AES-256-GCM *plaintext* a versioned JSON document holding every broker's
credential.** No schema change, no migration, no repository change.

**Rejected: a new `meshcore_observer_broker_credentials` table** with PK
`(sourceId, brokerKey)`, created by a three-backend migration. It is a
perfectly clean design and a reviewer may reasonably prefer it. It was not
chosen because:

- One AES envelope per source means **one `kid`, one rotation story**. N rows
  means N envelopes and a set of partial-rotation states (`key_rotated` for
  broker A but not B) that the UI and the publisher would both have to model.
- Zero migration risk across SQLite / PostgreSQL / MySQL, and the epic's Phase
  1 exit criteria explicitly assume no migration.
- The write path is operator-driven through a single route, so the
  read-modify-write is not a practical concurrency hazard. (It is a real one
  in principle; see 4.4.)

Modifying the existing table's primary key was rejected outright: SQLite
cannot alter a PK without a full table rebuild, which is exactly the class of
destructive migration that caused #4233.

### 4.2 The credential document

The **plaintext inside the existing envelope** becomes:

```ts
interface StoredCredentialDoc {
  v: 2;
  /** brokerKey -> credential. brokerKey = observerBrokerKey(url). */
  brokers: Record<string, { username: string; password: string }>;
  /**
   * The pre-#5014 single credential, carried forward verbatim when a v1
   * document is upgraded in place. Read by load() and by the legacy fallback.
   */
  legacy?: { username: string; password: string };
}
```

Decode rule (`decodeDoc(plaintext, clearUsername)`):

```
try p = JSON.parse(plaintext)
if (p && typeof p === 'object' && !Array.isArray(p) && p.v === 2 && p.brokers && typeof p.brokers === 'object')
    -> v2 document
else
    -> v1: { v: 2, brokers: {}, legacy: { username: clearUsername, password: plaintext } }
```

A v1 password that happens to be exactly a `{"v":2,"brokers":{...}}` JSON
object would be misread. This is accepted and must be commented: the
probability is negligible and the alternative (a length-prefixed container)
would break every existing row.

The clear `username` column stays as-is and remains **display-only**: it holds
the legacy username when a legacy entry exists, otherwise the username of the
lexicographically-first broker entry. It is never used to authenticate a
per-broker connection.

### 4.3 `MeshCoreObserverCredentialStore` API

Existing methods `store` / `load` / `clear` / `status` / `capability` /
`currentFingerprint` keep their **exact signatures and semantics**:

- `store(sourceId, username, password)` writes a v2 doc whose `legacy` is the
  supplied pair, **preserving any existing `brokers` map**.
- `load(sourceId)` returns the `legacy` entry: `{kind:'ok'}` when present,
  `{kind:'none'}` when the doc has no legacy entry, `{kind:'key_rotated'}`
  unchanged. For any pre-#5014 row this is bit-for-bit today's behaviour.
- `clear(sourceId)` still deletes the whole row.
- `status(sourceId)` unchanged, **plus** one additive optional field (§5.3).

New methods:

```ts
/** Max distinct broker credentials per source. Matches MAX_OBSERVER_BROKERS. */
export const OBSERVER_MAX_BROKER_CREDENTIALS = 8;

/** Read-modify-write one broker's entry. Throws when capability.canStore is false
 *  (same as store()) or when adding would exceed the cap. */
async storeForBroker(sourceId: string, brokerKey: string, username: string, password: string): Promise<void>;

/** This broker's credential only. Never falls back to `legacy`. */
async loadForBroker(sourceId: string, brokerKey: string): Promise<ObserverCredentialLoadResult>;

/** Remove one broker's entry. No-op when absent. Deletes the row when the doc
 *  ends up completely empty (no brokers, no legacy). */
async clearForBroker(sourceId: string, brokerKey: string): Promise<void>;

/** Non-secret enumeration for the UI. NEVER returns passwords. Returns [] on
 *  key_rotated / no row (the caller learns rotation from status()). */
async listBrokers(sourceId: string): Promise<Array<{ brokerKey: string; username: string }>>;
```

The publisher's default resolver, module-local in
`meshcoreObserverPublisher.ts`:

```ts
async function resolveBrokerCredential(
  sourceId: string,
  brokerKey: string,
  legacy: boolean,
): Promise<ObserverCredentialLoadResult> {
  const store = getMeshCoreObserverCredentialStore();
  const perBroker = await store.loadForBroker(sourceId, brokerKey);
  if (perBroker.kind !== 'none' || !legacy) return perBroker;
  // Legacy broker only: fall back to the pre-#5014 single credential.
  return store.load(sourceId);
}
```

Precedence is deliberate: a per-broker credential wins over the legacy one, so
re-entering credentials through the new route always takes effect. A
non-legacy broker **never** sees the legacy credential, which is the
per-broker isolation guarantee.

### 4.4 Concurrency note (must appear as a code comment)

`storeForBroker` and `clearForBroker` are read-modify-write over one row. Two
concurrent writes to *different* brokers can lose one update. Accepted for
v1: both paths are operator-driven admin routes on a single source, and the
loss is recoverable by re-entering the credential. If Phase 2's UI ever
batch-saves N brokers, it must serialize the PUTs.

---

## 5. Status and route contract

### 5.1 Types (`src/server/services/meshcoreObserverStatus.ts`, new, types only)

```ts
export interface MeshCoreObserverBrokerStatus {
  /** Stable identity. Same value as NormalizedObserverBroker.key. */
  key: string;
  /** Normalized broker URL. Non-secret, but see 5.4. */
  url: string;
  label: string | null;
  authMode: 'token' | 'password';
  tokenAudience: string | null;
  /** This broker has every field its auth mode requires. */
  configured: boolean;
  /** Its credential exists and decrypts under the current SESSION_SECRET. */
  keyStored: boolean;
  connected: boolean;
  publishes: number;
  /** Packets dropped because THIS broker's socket was down. */
  dropped: number;
  lastPublishAt: number | null;
  /** Token-redacted. */
  lastError: string | null;
  /** Unix SECONDS. Null in password mode. */
  tokenExpiresAt: number | null;
}

export interface MeshCoreObserverStatus {
  // ---- aggregate; every field below existed pre-#5014 and keeps its meaning
  //      for a single-broker source ----
  /** ANY broker configured. */
  configured: boolean;
  /** brokers[0].authMode. Legacy field, kept for existing consumers. */
  authMode: 'token' | 'password';
  /** ANY broker's credential present and decryptable. */
  keyStored: boolean;
  /** ANY broker connected. */
  connected: boolean;
  /** SUM over brokers. */
  publishes: number;
  /** SUM over brokers. */
  dropped: number;
  /** MAX over brokers (most recent). */
  lastPublishAt: number | null;
  /** Most recently set non-null broker lastError. Token-redacted. */
  lastError: string | null;
  /** MIN over non-null broker values (earliest expiry). */
  tokenExpiresAt: number | null;

  // ---- new ----
  brokers: MeshCoreObserverBrokerStatus[];
}
```

`meshcoreObserverPublisher.ts` re-exports both types
(`export type { MeshCoreObserverStatus, MeshCoreObserverBrokerStatus } from
'./meshcoreObserverStatus.js';`) so every existing import site is unchanged.

Aggregate rules are chosen so a **single-broker source produces exactly the
values it produces today**. That is the back-compat test in §6.

### 5.2 New route: `GET /api/sources/:id/observer/status`

In `src/server/routes/sourceObserverRoutes.ts` (already mounted at
`/:id/observer` from `sourceRoutes.ts` line 1807, `mergeParams: true`).

```ts
router.get(
  '/status',
  requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }),
  async (req, res) => { ... },
);
```

Permission rationale: `configuration:read` with source scoping, identical to
`GET /observer/key` and `GET /observer/credentials`. The payload is observer
configuration plus counters, which is the same trust class as those two, and
using the same gate means the Phase 2 UI needs no extra grant.

Handler:

1. `const source = await resolveMeshCoreSource(req, res); if (!source) return;`
   (404 `SOURCE_NOT_FOUND` / 400 `INVALID_PARAMETER` come for free).
2. `const mgr = sourceManagerRegistry.getManager(source.id);`
3. If `mgr && isMeshCoreManager(mgr)` and `mgr.getObserverStatus()` returns a
   value: `ok(res, { running: true, ...status })`.
4. Otherwise synthesize a not-running snapshot from the saved config, so the UI
   gets a meaningful answer for a disabled / disconnected / never-started
   source instead of a 404:
   ```ts
   const observer = observerConfigFromSource(source.config as MeshCoreSourceConfig);
   // observer === undefined -> configured:false, brokers: []
   ```
   with every counter at 0, `connected: false`, `keyStored: false`,
   `lastError: null`, `tokenExpiresAt: null`, and one `brokers[]` entry per
   normalized broker carrying `key` / `url` / `label` / `authMode` /
   `tokenAudience` / `configured: true`.
5. `try/catch` -> `fail(res, 500, 'INTERNAL_ERROR', 'Failed to get Analyzer Observer status')`,
   matching the sibling handlers.

Response body (envelope, `{ success: true, data: ... }`):

```json
{
  "success": true,
  "data": {
    "running": true,
    "configured": true,
    "authMode": "token",
    "keyStored": true,
    "connected": true,
    "publishes": 412,
    "dropped": 3,
    "lastPublishAt": 1756800000000,
    "lastError": null,
    "tokenExpiresAt": 1756880000,
    "brokers": [
      {
        "key": "wss://mqtt.meshmapper.net:443",
        "url": "wss://mqtt.meshmapper.net:443",
        "label": "MeshMapper",
        "authMode": "token",
        "tokenAudience": "mqtt.meshmapper.net",
        "configured": true,
        "keyStored": true,
        "connected": true,
        "publishes": 210,
        "dropped": 0,
        "lastPublishAt": 1756800000000,
        "lastError": null,
        "tokenExpiresAt": 1756880000
      },
      {
        "key": "wss://mqtt-us-v1.letsmesh.net:443",
        "url": "wss://mqtt-us-v1.letsmesh.net:443",
        "label": "LetsMesh US",
        "authMode": "token",
        "tokenAudience": "mqtt-us-v1.letsmesh.net",
        "configured": true,
        "keyStored": true,
        "connected": false,
        "publishes": 202,
        "dropped": 3,
        "lastPublishAt": 1756799000000,
        "lastError": "Broker rejected the observer auth token (check tokenAudience and the stored key).",
        "tokenExpiresAt": 1756880000
      }
    ]
  }
}
```

**Secrets hygiene, same contract as the sibling routes:** no handler returns a
private key, a minted token, or a password. `lastError` is `redactToken`-ed at
the point it is set, inside the publisher, and never re-derived here.

### 5.3 Additive changes to the existing credential routes

Back-compat rule: **a request that omits the new fields behaves exactly as it
does today.**

| Route | Change |
|---|---|
| `GET /observer/credentials` | Response gains `brokers: Array<{ brokerKey, username }>` from `listBrokers()`. Every existing field is unchanged. |
| `PUT /observer/credentials` | Body gains optional `brokerKey: string`. Absent -> `store()` (unchanged legacy path). Present -> validate, then `storeForBroker()`. |
| `DELETE /observer/credentials` | Gains optional `?brokerKey=` query param. Absent -> `clear()` (unchanged, wipes everything). Present -> `clearForBroker()`. |

`brokerKey` validation on PUT/DELETE, in that order:

1. must be a non-empty string <= 255 chars -> 400 `INVALID_PARAMETER_TYPE` / `INVALID_PARAMETER`;
2. must match a `key` in `observerConfigFromSource(source.config)?.brokers`
   -> 400 `UNKNOWN_BROKER` otherwise. This is what bounds the document: an
   operator cannot accumulate credentials for brokers that are not configured.

Both write paths keep the existing `capability.canStore` gate on PUT, keep the
deliberate absence of that gate on DELETE, call `auditMeshcoreEvent` with the
existing event names plus `brokerKey` in the detail object (the key is a URL,
not a secret), and call `refreshObserverPublisher(source)` so the running
publisher picks the credential up without a source bounce.

### 5.4 `GET /api/sources/:id/status` (no change needed, one thing to verify)

The `!canReadNodes` branch in `sourceRoutes.ts` (~line 1269) already deletes
the **entire** `observer` object for anonymous / non-`nodes:read` callers, so
the new `brokers[].url` and `brokers[].lastError` are covered with no code
change. **The implementer must verify this and add an assertion to
`sourceRoutes.observerStatus.test.ts`**, because `brokers[].url` exposes the
broker hostname outright, which is the very leak that strip exists to prevent.
If the strip were ever narrowed to `lastError` alone, this becomes a bug.

`stripObserverKeyMaterial` (~line 404) **does** need extending: it currently
strips key-material fields from the `observer` block only, not from
`observer.brokers[i]`. Map over the array and apply the same destructuring
strip to each entry, preserving the "applies to admins too" rule.

---

## 6. Test plan

Standard Vitest suite. Route tests use `createRouteTestApp()`. Publisher tests
use the existing `vi.mock('mqtt')` + `createClient`/`mintToken`/`loadCredentials`
seams. No new harness.

### 6.1 `src/server/meshcoreConfig.observerBrokers.test.ts` (new, WP1)

Pure unit tests on `normalizeObserverBrokers` / `observerBrokerKey` /
`observerConfigFromSource`.

1. **Legacy config normalizes to one broker.** `{enabled, brokerUrl, iataCode,
   tokenAudience}` -> `brokers.length === 1`, `legacy === true`,
   `key === observerBrokerKey(brokerUrl)`, and the flat mirrors
   (`brokerUrl`/`authMode`/`tokenAudience`) equal today's values.
2. **Legacy password-mode config** normalizes with `authMode: 'password'` and
   no audience, and is still `enabled`.
3. **`brokers[]` wins over `brokerUrl`.** Both present, different URLs -> the
   result has exactly the `brokers[]` entries; the legacy URL does not appear.
4. **Legacy flag survives the UI migration.** `brokerUrl: X` plus
   `brokers: [{url: X, ...}, {url: Y, ...}]` -> one entry, `X` marked
   `legacy: true`, `Y` marked `legacy: false`.
5. **Dedupe:** two entries whose URLs normalize identically (e.g.
   `broker.test:1883` and `mqtt://broker.test:1883`) collapse to one.
6. **Per-entry auth mode + audience:** entry-level values win; block-level
   `authMode` is the default; block-level `tokenAudience` does **not** leak
   into a non-legacy `brokers[]` entry.
7. **One bad broker does not kill the rest:** an entry with an unnormalizable
   URL, and a token-mode entry with no audience, are each dropped while the
   others survive.
8. **Disabling rules:** `enabled: false`, missing `iataCode`, and
   `brokers: []` with no `brokerUrl` each return `undefined`.
9. **Order is preserved** (broker order in the config is broker order in the
   normalized list), because Phase 2's UI list depends on it.

### 6.2 `src/server/routes/sourceRoutes.observerValidation.test.ts` (extend, WP1)

10. Accepts a valid two-broker config.
11. Rejects: non-array `brokers`; 9 brokers (`TOO_MANY_BROKERS`); a non-object
    entry; an `http://` entry URL (`INVALID_BROKER_URL`, proving the
    scheme pre-check survived the `validateBrokerUrlValue` extraction); a
    token-mode entry with no audience; a `label` over 64 chars; two entries
    with the same normalized URL (`DUPLICATE_BROKER_URL`); an entry carrying
    `password` (`OBSERVER_KEY_IN_CONFIG`, and it must fire even when
    `enabled: false`).
12. `enabled: true` with `brokers[]` and **no** `brokerUrl` is accepted
    (the `MISSING_BROKER` relaxation); `enabled: true` with neither is
    rejected with `MISSING_BROKER`.
13. Every pre-existing assertion in this file still passes untouched.
14. **Observer block size cap:** an `observer` block serializing to more than
    `MAX_OBSERVER_CONFIG_BYTES` is rejected with `OBSERVER_CONFIG_TOO_LARGE`
    (assert it fires for a disabled block too); a block at exactly the limit is
    accepted; and a **non-observer** config well over 4096 bytes (e.g. a fat
    `mqtt_bridge` block) is **accepted**, pinning the decision not to add a
    whole-config guard. A valid 8-broker observer block fits under the cap.

### 6.3 `src/server/routes/sourceRoutes.observerStrip.test.ts` (extend, WP1)

15. A stored row with `observer.brokers[1].password` has it stripped for
    admins and non-admins alike, alongside the existing block-level strip.

### 6.4 `src/server/services/meshcoreObserverCredentialStore.test.ts` (extend, WP2)

16. **v1 read path unchanged:** a row written by the old `store()` still loads
    through `load()` as `{kind:'ok'}`, and `status()` reports the same shape
    it does today.
17. **v1 -> v2 upgrade is lossless:** `store()` a legacy credential, then
    `storeForBroker('wss://b/')`; `load()` still returns the legacy pair and
    `loadForBroker('wss://b/')` returns the new one.
18. **Per-broker isolation:** credentials for broker A and broker B round-trip
    independently; `loadForBroker(A)` never returns B's password, and
    `loadForBroker('wss://never-configured/')` returns `{kind:'none'}`.
19. **No legacy leak:** with only a legacy credential stored,
    `loadForBroker(anyKey)` returns `{kind:'none'}` (the fallback lives in the
    publisher, not the store).
20. `clearForBroker` removes one entry and leaves the others; clearing the
    last entry when no legacy exists deletes the row.
21. `listBrokers` returns `{brokerKey, username}` pairs and **never** a
    password field (assert on `Object.keys`).
22. `key_rotated`: a doc encrypted under a different SESSION_SECRET returns
    `key_rotated` from both `load()` and `loadForBroker()`, and `listBrokers`
    returns `[]`.
23. `storeForBroker` throws when `capability.canStore` is false, and rejects
    the 9th distinct broker.
24. A v1 password that is *not* valid JSON, and one that is valid JSON but not
    the v2 shape (e.g. `"[1,2,3]"`), both decode as v1.

### 6.5 `src/server/services/meshcoreObserverPublisher.multiBroker.test.ts` (new, WP3)

The headline suite. Uses `vi.mock('mqtt')`; `mockConnect.mock.results` yields
one fake client per broker, in config order.

25. **Concurrent publish to 2 brokers:** two token-mode brokers with different
    audiences. `start()` opens two sockets; `mintToken` is called twice, once
    per audience. One `handleOtaPacket` -> **both** fake clients received a
    publish, on their own `meshcore/{IATA}/{PUBKEY}/packets` topic, with
    **byte-identical** payloads.
26. **Payload built once:** spy on `buildObserverPacketPayload`; one
    `handleOtaPacket` across 3 same-`originId` brokers calls it exactly once.
27. **Per-broker audience:** `mintToken` receives each broker's own audience;
    the CONNECT password for each socket is that broker's token.
28. **Shared audience dedupes:** two brokers with the same audience ->
    `mintToken` called once, both sockets get the same token.
29. **Drop-when-disconnected is per broker:** disconnect broker B's fake
    client, publish -> A's `publishes` increments, B's `dropped` increments,
    A's `dropped` stays 0. Aggregate `publishes` is the sum.
30. **Per-broker lastError isolation:** emit an `error` on B's client ->
    `getStatus().brokers[1].lastError` set, `brokers[0].lastError` null,
    aggregate `lastError` non-null.
31. **Token redaction per broker:** an error message embedding a
    JWT-shaped token comes back `[REDACTED]` in that broker's `lastError`.
32. **Auth hard-stop is per broker:** `MAX_AUTH_FAILURES` `permission-denied`
    events on B disconnect B only; A stays connected and keeps publishing;
    `isRunning()` stays true.
33. **Renewal rebuilds only the affected audience:** fake timers, token for
    audience-A near expiry and audience-B fresh; one `RENEWAL_CHECK_MS` tick
    re-mints A only and rebuilds only A's socket (assert
    `mockConnect.mock.calls.length` grew by exactly 1). Window derived from
    `RENEWAL_CHECK_MS`/`RENEWAL_THRESHOLD_S`, never hardcoded.
34. **A failed renewal mint does not tear down the working socket.**
35. **Status refresh reads stats once:** `STATUS_REFRESH_MS` tick with 3
    brokers -> the `stats` seam is called exactly once, and 3 retained
    `online` publishes go out.
36. **Password-mode per-broker credentials:** two password brokers;
    `loadCredentials` is called with each broker's `key` and its `legacy`
    flag; each socket's CONNECT carries its own username/password.
37. **Mixed modes on one source:** one token broker + one password broker
    start together; the password broker's `tokenExpiresAt` is null.
38. **`start()` never throws** when every mint fails, when every credential is
    missing, and when `createClient` throws for one broker (the others still
    come up).
39. **`stop()`** publishes an offline status and disconnects on **every**
    broker, and is idempotent.

### 6.6 `meshcoreObserverPublisher.test.ts` / `.staticAuth.test.ts` / `.perSource.test.ts` (extend, WP3)

40. **Single-broker back-compat:** every existing test passes with a legacy
    config, and one new assertion confirms `getStatus()` reports
    `brokers.length === 1` whose per-broker fields equal the aggregate fields.
    This is the guarantee that Phase 2's UI and the existing
    `GET /:id/status` consumer see no behavioural change.
41. Type-only updates: `makeMintTokenAlwaysOk` / `makeMintToken` /
    `loadCredentials` mock signatures widen to the new arities.

### 6.7 `meshcoreObserverToken.test.ts` (extend, WP3)

42. `mintObserverTokenForSourceDetailed(id)` with no override behaves exactly
    as before (all existing cases).
43. With an `audienceOverride`, the minted token's `aud` claim is the override,
    not the config value, and a source whose config has no `tokenAudience` at
    all still mints successfully.

### 6.8 `src/server/routes/sourceObserverRoutes.status.test.ts` (new, WP4)

`createRouteTestApp` harness, `sourceManagerRegistry` mocked with a fake
MeshCore manager (same pattern as `sourceRoutes.observerStatus.test.ts`).

44. 200 with the full aggregate + `brokers[]` for a `configuration:read`
    grant on that source, wrapped in `{ success: true, data }`.
45. 403 without the grant; 403 for a grant on a **different** source (per-source
    isolation, mirroring `sourceObserverRoutes.perSource.test.ts`).
46. 404 `SOURCE_NOT_FOUND` for an unknown id; 400 `INVALID_PARAMETER` for a
    non-meshcore source.
47. No registered manager -> 200 with `running: false`, zeroed counters and
    `brokers[]` synthesized from the saved config.
48. Observer disabled in config -> 200 with `running: false`,
    `configured: false`, `brokers: []`.
49. The response contains no `password`, no `privateKey` and no token-shaped
    string (assert on the serialized body).

### 6.9 `sourceObserverRoutes.credentials.test.ts` (extend, WP4)

50. PUT with no `brokerKey` behaves exactly as today (legacy store path) and
    still calls `reconfigureObserver`.
51. PUT with a `brokerKey` matching a configured broker stores per-broker; a
    subsequent `GET /credentials` lists it under `brokers[]` with its username
    and no password.
52. PUT with an unconfigured `brokerKey` -> 400 `UNKNOWN_BROKER`.
53. DELETE `?brokerKey=` removes one entry, leaving the others and the legacy
    entry; DELETE with no param still wipes everything.
54. Both new paths audit and both call `refreshObserverPublisher`.

### 6.10 Suite-wide

55. `npm test` fully green, 0 failures (CLAUDE.md gate). No PostgreSQL /
    MySQL containers are required: this phase adds no schema or migration.
56. `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` is
    empty. No new `any`, no raw `fetch`, no baseline growth.

---

## 7. Work packages

Four packages. **WP1 and WP2 run in parallel. WP3 and WP4 run in parallel once
both are merged.** No two packages touch the same file.

### WP1: config schema, normalization and validation

**Depends on:** nothing. **Parallel with:** WP2.

Files:
- `src/server/meshcoreConfig.ts` (modify)
- `src/server/services/meshcoreObserverStatus.ts` (**new**, types only)
- `src/server/routes/sourceRoutes.ts` (modify: `validateObserverConfig`
  including the `MAX_OBSERVER_CONFIG_BYTES` check, `validateBrokerUrlValue`
  extraction, `stripObserverKeyMaterial`, and the non-rejecting MySQL blob-size
  `logger.warn` in the create/update handlers)
- `src/server/meshcoreConfig.observerBrokers.test.ts` (**new**)
- `src/server/routes/sourceRoutes.observerValidation.test.ts` (extend)
- `src/server/routes/sourceRoutes.observerStrip.test.ts` (extend)

Acceptance:
- `MeshCoreObserverBrokerConfig`, `NormalizedObserverBroker`,
  `NormalizedObserverConfig`, `observerBrokerKey`, `normalizeObserverBrokers`
  exported exactly as specified in §2.
- `observerConfigFromSource` keeps its signature and its "incomplete ->
  undefined" contract, and its flat mirrors match §2.2.
- `MeshCoreObserverStatus` / `MeshCoreObserverBrokerStatus` defined in the new
  types module exactly as in §5.1 (nothing consumes them yet; WP3 wires them
  in and re-exports from the publisher).
- `MAX_OBSERVER_CONFIG_BYTES` caps the `observer` block only. **No
  whole-config guard is added**, and no non-observer source type gains a new
  rejection path: an existing >4KB `mqtt_bridge` config must still save
  unchanged on SQLite and PostgreSQL. The MySQL oversize check is a
  `logger.warn` and never a 400.
- Tests 1-15 pass. Every pre-existing observer-validation and strip assertion
  still passes.
- `MeshCoreConfig['observer']` is **not** retyped here (that is WP3), so this
  package compiles standalone.

### WP2: per-broker credential store

**Depends on:** nothing. **Parallel with:** WP1.

Files:
- `src/server/services/meshcoreObserverCredentialStore.ts` (modify)
- `src/server/services/meshcoreObserverCredentialStore.test.ts` (extend)

Acceptance:
- `StoredCredentialDoc` v2, `decodeDoc` and the four new methods land exactly
  as in §4.2/§4.3, with the v1-misparse caveat and the read-modify-write
  concurrency caveat present as code comments.
- `store` / `load` / `clear` / `status` / `capability` keep their signatures;
  `status()` gains only the optional `brokers` field.
- **No schema, repository or migration change.** `MeshCoreObserverCredentialsRepository`
  and `src/db/schema/meshcoreObserverCredentials.ts` are untouched.
- Tests 16-24 pass; every pre-existing credential-store assertion still passes.

### WP3: publisher connection pool, token minting, manager wiring

**Depends on:** WP1 (config + status types), WP2 (store API).
**Parallel with:** WP4.

Files:
- `src/server/services/meshcoreObserverPublisher.ts` (modify, the bulk of the work)
- `src/server/services/meshcoreObserverToken.ts` (modify: `audienceOverride`)
- `src/server/meshcoreManager.ts` (modify: retype `MeshCoreConfig['observer']`
  and the `MeshCoreSourceStatus` import; **no logic changes**)
- `src/server/services/meshcoreObserverPublisher.multiBroker.test.ts` (**new**)
- `src/server/services/meshcoreObserverPublisher.test.ts` (extend)
- `src/server/services/meshcoreObserverPublisher.staticAuth.test.ts` (extend)
- `src/server/services/meshcoreObserverPublisher.perSource.test.ts` (extend)
- `src/server/services/meshcoreObserverToken.test.ts` (extend)

Acceptance:
- `start()` / `stop()` / `handleOtaPacket()` / `getStatus()` / `isRunning()`
  keep their names and contracts; `start()` still never throws.
- `ObserverBrokerConnection` owns all per-broker state; `redactToken`,
  `LAST_ERROR`, `RENEWAL_CHECK_MS`, `RENEWAL_THRESHOLD_S`,
  `MAX_AUTH_FAILURES` and `STATUS_REFRESH_MS` stay module-level exports with
  their current values.
- Exactly one renewal timer and one status-refresh timer per publisher, both
  `unref()`-ed; `stats()` called at most once per refresh tick.
- Payload serialized once per distinct `originId` per packet.
- Auth hard-stop scoped to one connection.
- Tests 25-43 pass. `sourceRoutes.observerStatus.test.ts` still passes
  untouched.

### WP4: status route and per-broker credential routes

**Depends on:** WP1 (normalize + status types), WP2 (store API).
**Parallel with:** WP3.

Files:
- `src/server/routes/sourceObserverRoutes.ts` (modify)
- `src/server/routes/sourceObserverRoutes.status.test.ts` (**new**)
- `src/server/routes/sourceObserverRoutes.credentials.test.ts` (extend)

Acceptance:
- `GET /api/sources/:id/observer/status` exists, uses `ok()`/`fail()`,
  `requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' })`
  and `resolveMeshCoreSource`, and returns §5.2's shape including the
  not-running synthesis.
- The three credential routes accept the new optional `brokerKey` and are
  byte-compatible when it is omitted.
- No handler returns a password, a private key or a token.
- Tests 44-54 pass; every pre-existing route assertion still passes.
- The `!canReadNodes` strip on `GET /:id/status` is verified to drop the whole
  `observer` object (§5.4), with an assertion added if one is missing.

### Ordering summary

```
WP1 ─┐
     ├─> WP3 (publisher + manager)   ─┐
WP2 ─┘                                 ├─> PR / CI
     └─> WP4 (routes)                ─┘
```

WP3 and WP4 share **zero** files. WP1's new types module is the seam that lets
WP4 build the status response without importing the publisher.

---

## 8. Deviations and open questions for the reviewer

1. **Per-broker auth hard-stop** (§3.2) is a behaviour change from Phase 2's
   whole-publisher stop. It is the right call for dual-publish, but it is a
   change, and it belongs in the PR body.
2. **Encrypted credential document vs a new table** (§4.1). The trade-off is
   recorded; flipping to a `meshcore_observer_broker_credentials` table with a
   three-backend migration is a contained change confined to WP2 plus the
   repository and schema files, if a reviewer prefers it.
3. **`brokers[]` beats `brokerUrl`** (§2.3 rule 1). The alternative (union the
   two) risks double-publishing and was rejected. Phase 2's form must write
   the legacy broker into `brokers[0]`, and should clear the stale top-level
   `brokerUrl` once it does, though the `legacy` flag means it does not have
   to for credentials to keep working.
4. **`MAX_OBSERVER_BROKERS = 8`** and **`MAX_OBSERVER_CONFIG_BYTES = 1536`**
   are the two numbers this spec picks, and they are chosen together (see
   2.5's budget arithmetic). 8 is well above the three brokers the epic names
   (MeshMapper, LetsMesh US, LetsMesh EU). Confirm both with the project owner
   before merge. Note the deliberate absence of a whole-config guard: a
   universal 4096-byte cap would make a pre-existing oversized config on
   SQLite/PostgreSQL uneditable after upgrade, so MySQL's column width is
   surfaced as a log warning rather than enforced as a rejection.
5. **Mesh impact:** none. The observer is a passive relay of packets the radio
   already heard; no new transmissions, no new timers on the RF side. The only
   new per-tick cost is N MQTT publishes on the existing 5-minute status
   refresh, over IP.
