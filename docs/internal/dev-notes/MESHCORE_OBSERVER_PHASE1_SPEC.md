# MeshCore Analyzer Observer — Phase 1 Implementation Spec

**Epic:** #4457 — MeshCore Analyzer Observer MQTT Output
**Epic plan:** `docs/internal/dev-notes/MESHCORE_ANALYZER_OBSERVER_EPIC.md`
**Branch:** `feature/meshcore-observer-mqtt-phase1` (worktree `/home/yeraze/Development/meshmonitor-observer-mqtt-p1`)
**Phase scope:** backend foundation only — config block, encrypted signing-key storage, key-management API, auth-token module. **No publisher, no MQTT connection, no UI.**

---

## 1. Reuse inventory (MANDATORY — read before writing any code)

Everything in Phase 1 has a direct in-repo precedent. Nothing here is a new pattern.
If your implementation diverges from one of these, the divergence must be justified in the PR body.

### 1.1 Encrypted per-source private key at rest — `SourcePkiKeyStore`

| What | Where | Why it is the model |
|---|---|---|
| Store class | `src/server/services/sourcePkiKeyStore.ts` L47-143 | Per-source **private key** (not a password), AES-256-GCM + HKDF-SHA256 from `SESSION_SECRET`, `kid` fingerprint for rotation detection, `capability.canStore` gate, lazily-constructed singleton + `set…ForTesting` hook. This is *exactly* our shape. |
| KDF helper | `sourcePkiKeyStore.ts` L145-148 | `hkdfBytes(ikm, info, len)` with a **stable zero salt**. Copy verbatim; do not invent a random salt (it would defeat rotation detection). |
| Singleton accessor | `sourcePkiKeyStore.ts` L181-194 | `getSourcePkiKeyStore()` / `setSourcePkiKeyStoreForTesting()`. |
| Schema | `src/db/schema/sourcePkiKeys.ts` (3 dialect tables, L18-45) | `sourceId` PK, `encryptedPrivateKey TEXT NOT NULL`, clear `publicKey`, `createdAt`/`updatedAt` BIGINT. Header comment states the reason the key is **not** in `sources.config` — that reasoning transfers verbatim. |
| Repository | `src/db/repositories/sourcePkiKeys.ts` L21-105 | `getBySourceId` / `hasKey` / `upsert` (read-then-update-or-insert, not dialect-specific upsert) / `deleteBySourceId`. |
| Migration | `src/server/migrations/088_add_source_pki_keys.ts` | `CREATE TABLE IF NOT EXISTS` on all three backends; PG quotes camelCase columns; MySQL uses `VARCHAR(36)` PK / `VARCHAR(128)` for hex. Idempotent with no helper needed. |
| Registry entry | `src/db/migrations.ts` L105 (import), L1449-1455 (register) | Shape of the `registry.register({ number, name, settingsKey, sqlite, postgres, mysql })` call. |
| ActiveSchema wiring | `src/db/activeSchema.ts` L153-154, L262, L334, L393, L452 | Five touch points to expose a new table on `this.tables`. |
| Facade wiring | `src/services/database.ts` L54 (import), L492 (field), L551-554 (getter), L935 (construction) | Four touch points. |

**Second store precedent (envelope + capability wording):** `src/server/services/meshcoreCredentialStore.ts` L36-38 (KDF info strings), L108-130 (`store`), L141-180 (`load` + three load outcomes), L326-330 (`hkdfBytes`). Documented in `docs/internal/dev-notes/MESHCORE_REMOTE_ADMIN.md` §"Credential store" (L102-168) — read it; it explains why AES-GCM (reversible) not bcrypt, what `kid` is for, and the DB-file-exfil-only threat boundary.

### 1.2 Per-source key-management HTTP routes — the `pki-dm` endpoints

`src/server/routes/sourceRoutes.ts` L1040-1096 is the closest existing surface: a per-source, `configuration`-permissioned pair of routes that reports key-stored status and extracts/clears an encrypted key.

- `GET /:id/pki-dm/status` L1047-1060 — returns `{ enabled, keyStored, canStore, reason }`, **never the key**.
- `POST /:id/pki-dm` L1063-1096 — pulls the key from the live manager when connected, clears the stored key when disabled.
- Permission form: `requirePermission('configuration', 'read'|'write', { sourceIdFrom: 'params.id' })`.
- Source-not-found handled by an explicit `databaseService.sources.getSource(req.params.id)` lookup.

### 1.3 Sub-router mounted under `/api/sources/:id/...`

`src/server/routes/sourceRoutes.ts` L14 (import) + L1420 `router.use('/:id/waypoints', waypointRoutes)`. This is the mechanism we reuse to keep the new routes out of the already-1400-line `sourceRoutes.ts`. Sub-router must be `Router({ mergeParams: true })` so `req.params.id` reaches `requirePermission`'s `sourceIdFrom`.

### 1.4 Config-block validation — `validateVirtualNodeConfig`

`src/server/routes/sourceRoutes.ts` L39-64. Contract to copy exactly:
- `export async function validate…(type, config, excludeSourceId?): Promise<{ status, error } | null>`
- returns `null` for absent block, `null` when `enabled !== true`, `{ status: 400, error }` on a type mismatch.
- Called from `POST /` at L468 and `PUT /:id` at L569, both of which do `return res.status(err.status).json({ error: err.error })`.

### 1.5 Runtime config derivation — `virtualNodeConfigFromSource`

`src/server/meshcoreConfig.ts` L58-67 (helper), L17-48 (`MeshCoreSourceConfig`), L100-130 (`meshcoreConfigFromSource`), and `MeshCoreConfig` at `src/server/meshcoreManager.ts` L324-345. The `virtualNode` sub-block is the structural model for `observer`.

### 1.6 Secrets strip

`src/server/routes/sourceRoutes.ts` L235-254 `stripSourceSecrets()`, applied at L338, L369, L399. Note the early `if (!source || isAdmin) return source;` — see §5.4 for why the observer strip must be hoisted **above** that line.

### 1.7 Manager-side key export

`src/server/meshcoreManager.ts` L4442-4462 `async exportPrivateKey(): Promise<string | null>` — companion-only, requires `this.connected`, returns 128-hex or `null`. Existing HTTP consumer for reference: `src/server/routes/meshcoreConfigRoutes.ts` L282-310 (`GET /config/private-key`), including its `auditMeshcoreEvent(req, 'meshcore_export_private_key', 'configuration', …)` call.
Local node identity: `src/server/meshcoreManager.ts` L5614-5616 `getLocalNode(): MeshCoreNode | null` → `.publicKey`.

### 1.8 Response envelope

`src/server/utils/apiResponse.ts` — `ok(res, data)` / `fail(res, status, code, message, extra?)`. All new handlers use these (they are new handlers, so the "don't convert bare-payload handlers" caveat does not apply). Existing machine codes available for reuse (census of `src/server/routes/`): `INTERNAL_ERROR`, `INVALID_PARAMETER`, `INVALID_PARAMETER_TYPE`, `EXPORT_FAILED`, `CREDENTIAL_PERSISTENCE_DISABLED`, `CREDENTIAL_KEY_ROTATED`, `NO_STORED_CREDENTIAL`, `FORBIDDEN`, `BAD_REQUEST`.

### 1.9 Route test harness

`src/server/test-helpers/routeTestApp.ts` — `createRouteTestApp({ mount })`, `harness.grant(userId, resource, action, sourceId)`, `harness.loginAs(user)`, `harness.sourceA` / `sourceB`, `harness.cleanup()`. **Note:** the harness seeds both sources as `type: 'meshtastic_tcp'` (L153-166). Observer tests must flip the type with `harness.db.sources.updateSource(id, { … })` — but `updateSource` (`src/db/repositories/sources.ts` L96) only accepts `name | config | enabled`. Therefore observer route tests **create their own meshcore sources** via `harness.db.sources.createSource({ id: 'obs-a', type: 'meshcore', … })` and grant against those ids, then delete them in `afterEach`. Canonical harness template: `src/server/routes/sourceRoutes.permissions.test.ts`.

### 1.10 Broker-URL normalization (Phase 2 consumer, Phase 1 validator)

`src/server/transports/mqttBrokerClient.ts` L465-476 `export function normalizeBrokerUrl(input: string): string` — passes through `mqtt|mqtts|ws|wss|tcp|tls://`, else infers `mqtts://` for ports 8883/8884 and `mqtt://` otherwise. Phase 1 uses it inside validation only; it does not open a connection.

### 1.11 Restart-on-config-change (already exists — do not add a new hook)

`src/server/routes/sourceRoutes.ts` L836-851: on `PUT /:id`, when the source is `meshcore`, was and remains enabled, `autoConnect` is on, and `config !== undefined`, the handler does a **full** `removeManager` → `ensureMeshCoreManagerStarted` cycle. See §4 for the decision.

### 1.12 New third-party dependency

`@michaelhart/meshcore-decoder@0.3.0` — MIT (`LICENSE.md` in the tarball), 4 runtime deps (`@noble/ed25519`, `chalk`, `commander`, `crypto-js`). This is the only genuinely new mechanism in Phase 1. It is justified because the broker verifies tokens with **this same library** (per the broker README) and because the signing algorithm is orlp/ed25519 — a non-standard Ed25519 private-key format that `node:crypto` and `@noble/ed25519` cannot consume directly (see §6.2). Hand-rolling it is explicitly rejected by epic interview decision #3.

---

## 2. Verified facts about `@michaelhart/meshcore-decoder@0.3.0`

These were confirmed empirically by installing the package and executing it (not read from docs). They are load-bearing; do not "simplify" past them.

### 2.1 API surface

```ts
// package.json: main "dist/index.js", types "dist/index.d.ts", NO "type": "module" → CommonJS.
// Node ESM named-import interop VERIFIED working:
import { createAuthToken, verifyAuthToken, Utils } from '@michaelhart/meshcore-decoder';

createAuthToken(payload: AuthTokenPayload, privateKeyHex: string, publicKeyHex: string): Promise<string>
verifyAuthToken(token: string, expectedPublicKeyHex?: string): Promise<AuthTokenPayload | null>
parseAuthToken(token: string): AuthToken | null
decodeAuthTokenPayload(token: string): AuthTokenPayload | null

Utils.derivePublicKey(privateKeyHex: string): Promise<string>      // 64-byte priv hex → 32-byte pub hex
Utils.validateKeyPair(privateKeyHex, expectedPublicKeyHex): Promise<boolean>
Utils.sign(messageHex, privateKeyHex, publicKeyHex): Promise<string>
Utils.verify(signatureHex, messageHex, publicKeyHex): Promise<boolean>

interface AuthTokenPayload { publicKey: string; iat: number; exp?: number; aud?: string; [k: string]: any }
```

### 2.2 THE PUBLIC KEY IS **NOT** THE SECOND 32 BYTES OF THE PRIVATE KEY

The epic brief carried an assumption that in "MeshCore/orlp format the second 32 bytes ARE the public key." **This is false and was disproved empirically.**

orlp/ed25519's `ed25519_create_keypair` sets `private_key = clamp(SHA-512(seed))`, i.e. `[scalar‖nonce-prefix]`. The public key is `scalarmult_base(scalar)` — it is *derived*, not embedded. (Contrast libsodium's `crypto_sign` secret key, which really is `seed‖pubkey`. MeshCore does not use that layout.)

Observed run against a correctly-clamped key:

```
derived pub (Utils.derivePublicKey): 672053E6E3005B705C635CEE8AA2DDDFDB52CB46EFD5DAEBCA43C9E4242FFD60
priv bytes[32..64]:                  6727E98E590D664A80100C80B3D30A8EBA3C3705F0BF5C56C93347201AF8B34A
second-32-is-pubkey?                 false
Utils.validateKeyPair(priv, derived) true
```

**Implementation rule:** always obtain the public key via `Utils.derivePublicKey(privateKeyHex)`. Slicing bytes 32..64 produces a public key the broker will reject (username `v1_{PUBKEY}` would not match the signature).

### 2.3 `derivePublicKey` doubles as the semantic key validator

A random 128-hex string throws:

```
Error: orlp key derivation failed: invalid private key
```

because the WASM checks the clamping invariants (`b[0] & 7 == 0`, `b[31] & 0xC0 == 0x40`). This is strictly stronger than a `/^[0-9a-fA-F]{128}$/` regex and is the check the paste route uses (see §6.3). A regex-only validator would happily persist garbage that fails at broker-connect time in Phase 2.

### 2.4 Token shape (round-trip verified)

```
header  (base64url): {"alg":"Ed25519","typ":"JWT"}
payload (base64url): {"publicKey":"<32B HEX UPPER>","aud":"test.aud","iat":1785503938,"exp":1785507538}
signature:           128 UPPERCASE hex chars (Ed25519 over the ASCII bytes of "header.payload")
verifyAuthToken(token, pubHex) → the payload object
```

- `createAuthToken` **mutates the payload object you pass in** (uppercases `publicKey`, defaults `iat`). Always construct a fresh object literal per call.
- JSON key order in the payload follows insertion order of the object you pass. Order is irrelevant to verification (the encoded string is what is signed), but keep it stable for readable test fixtures.
- `verifyAuthToken` returns `null` (not a throw) for: wrong segment count, `alg`/`typ` mismatch, missing `publicKey`/`iat`, `expectedPublicKeyHex` mismatch, `exp` in the past, bad signature.

### 2.5 WASM + packaging notes

- The WASM binary ships in the package at `node_modules/@michaelhart/meshcore-decoder/lib/orlp-ed25519.wasm` (57 KB) and is loaded by a relative `require('../../lib/orlp-ed25519.js')` from `dist/crypto/orlp-ed25519-wasm.js`. `Dockerfile` L86 copies `node_modules` wholesale from the builder, so no extra copy step or asset config is needed.
- `getWasmInstance()` instantiates a **fresh** WASM module on *every* `sign`/`verify`/`derivePublicKey` call (deliberate, per the library's own comment). Cost is a few ms. Acceptable for token minting (once per TTL). **Never call it per packet** — Phase 2 must cache the minted token, not re-mint.
- **Do not import this package from `src/components/**` or `src/pages/**`.** It is server-only; importing it in the frontend would pull emscripten glue + WASM into the Vite bundle. Phase 3's UI talks to the API, never to the library.
- `tsconfig.server.json` has `esModuleInterop: true` + `allowSyntheticDefaultImports: true` + `moduleResolution: "bundler"`, so the CJS package types resolve cleanly.

---

## 3. Data model & storage decision

### 3.1 Decision: a new dedicated table, `meshcore_observer_keys`

**Chosen:** a new table mirroring `source_pki_keys` — one row per source, ciphertext + clear derived public key.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Column(s) on `sources` | `SourcesRepository` uses Drizzle `select()` with no column list, so every schema column lands on every `Source` object across the codebase — including the objects `GET /api/sources` (L338/L369) and `GET /api/sources/:id` (L399) serialize to HTTP. Admins receive the *unstripped* record by design (L235-254), so an Ed25519 ciphertext column would ride along in an ordinary config response and get round-tripped back through the source-edit form. `src/db/schema/sourcePkiKeys.ts` L8-11 says this in as many words: the table exists specifically to keep key material *out of* the `sources.config` blob and general config responses. Same reasoning, verbatim. |
| A field inside the `sources.config` JSON blob | Strictly worse than a column: the blob is user-supplied on `PUT /:id`, merged by `preserveSourceCredentials` (L199), echoed back by the form, and validated as untrusted input. Key material must never be client-writable through a general config path. |
| A column on `meshcore_nodes`, keyed `(sourceId, publicKey)` | `meshcore_nodes` is the **contact book** — one row per *remote* node the companion knows about, keyed by the remote's public key. The observer signing key belongs to the source's *own* companion, which frequently has no `meshcore_nodes` row. Worse, the natural key would be the companion's own public key, which we do not know until we *derive it from the very key we are trying to store* — a chicken-and-egg on the primary key. |
| Reuse `source_pki_keys` | Different algorithm (orlp Ed25519 signing vs X25519 DH), different lifecycle, and — decisively — `SourcePkiKeysRepository.deleteAll()` (L98-104) is invoked when the global PKI-DM master switch is turned off. That would silently wipe every observer signing key as a side effect of an unrelated setting. |

### 3.2 Schema — `src/db/schema/meshcoreObserverKeys.ts` (NEW)

Follow `src/db/schema/sourcePkiKeys.ts` exactly for dialect imports and export naming.

| Column | SQLite | PostgreSQL | MySQL | Notes |
|---|---|---|---|---|
| `sourceId` | `text` PK | `text` PK | `varchar(36)` PK | one row per source |
| `encryptedPrivateKey` | `text NOT NULL` | `text NOT NULL` | `text NOT NULL` | AES-256-GCM envelope JSON — **never** raw key |
| `publicKey` | `text` | `text` | `varchar(64)` | 32-byte hex UPPERCASE, derived, **not secret** |
| `keyOrigin` | `text` | `text` | `varchar(16)` | `'device'` \| `'manual'` — surfaced in status |
| `createdAt` | `integer NOT NULL` | `bigint NOT NULL` | `bigint NOT NULL` | ms epoch |
| `updatedAt` | `integer NOT NULL` | `bigint NOT NULL` | `bigint NOT NULL` | ms epoch |

Exports: `meshcoreObserverKeysSqlite`, `…Postgres`, `…Mysql` + `$inferSelect`/`$inferInsert` types, matching `sourcePkiKeys.ts` L47-50.

### 3.3 Migration 133 (current highest in the registry is **132**)

`src/server/migrations/133_add_meshcore_observer_keys.ts` — copy the structure of `088_add_source_pki_keys.ts`.

- SQLite: `export const migration = { up(db), down(db) }` using `CREATE TABLE IF NOT EXISTS` (natively idempotent — no helper needed).
- PostgreSQL: `export async function runMigration133Postgres(client)` — `CREATE TABLE IF NOT EXISTS` with **quoted camelCase** column names.
- MySQL: `export async function runMigration133Mysql(pool)` — use `createTableIfMissingMysql(pool, 'meshcore_observer_keys', ddl)` from `src/server/migrations/helpers.ts` (MySQL's `CREATE TABLE IF NOT EXISTS` works but the helper is the house style for new tables; either is acceptable, be consistent within the file).
- Registry (`src/db/migrations.ts`): import at the end of the import block (after L149), register after the migration-132 block (after L2111):

```ts
registry.register({
  number: 133,
  name: 'add_meshcore_observer_keys',
  settingsKey: 'migration_133_add_meshcore_observer_keys',
  sqlite: (db) => meshcoreObserverKeysMigration.up(db),
  postgres: (client) => runMigration133Postgres(client),
  mysql: (pool) => runMigration133Mysql(pool),
});
```

`src/db/migrations.test.ts` needs **no edit** — its assertions are registry-derived.

### 3.4 Repository — `src/db/repositories/meshcoreObserverKeys.ts` (NEW)

```ts
export interface DbMeshCoreObserverKey {
  sourceId: string;
  encryptedPrivateKey: string;
  publicKey: string | null;
  keyOrigin: string | null;
  createdAt: number;
  updatedAt: number;
}

export class MeshCoreObserverKeysRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType);
  async getBySourceId(sourceId: string): Promise<DbMeshCoreObserverKey | null>;
  async hasKey(sourceId: string): Promise<boolean>;
  async upsert(sourceId: string, encryptedPrivateKey: string, publicKey: string | null, keyOrigin: 'device' | 'manual'): Promise<void>;
  async deleteBySourceId(sourceId: string): Promise<void>;
}
```

Mirror `sourcePkiKeys.ts` L27-95 (read-then-update-or-insert in `upsert`; throw on empty `sourceId`). All queries filter by `sourceId` — this table is per-source by construction.

**No raw SQL.** Drizzle query builders only (ESLint-enforced).

### 3.5 Wiring touch points

- `src/db/schema/index.ts` — add `export * from './meshcoreObserverKeys.js';` (near L63).
- `src/db/activeSchema.ts` — 5 edits mirroring the `sourcePkiKeys` lines at L153-154 (import), L262 (interface field), L334 / L393 / L452 (dialect maps).
- `src/db/repositories/index.ts` — export the class + `DbMeshCoreObserverKey` type (mirror L82-83).
- `src/services/database.ts` — 4 edits mirroring L54 / L492 / L551-554 / L935: import, `public meshcoreObserverKeysRepo`, `get meshcoreObserverKeys()` throwing `'Database not initialized'`, and construction inside `initializeDrizzleRepositoriesAsync`.

> **CLAUDE.md check:** all DatabaseService surface is async with the repositories' own `async` methods; `databaseService.meshcoreObserverKeys.*` is the access path. No `*Async`-suffixed facade method is needed — the `sourcePkiKeys` precedent exposes the repository directly.

---

## 4. Config block & the restart question

### 4.1 `MeshCoreSourceConfig.observer` — `src/server/meshcoreConfig.ts`

```ts
/**
 * MeshCore Analyzer Observer output (#4457). When enabled, Phase 2's publisher
 * relays every OTA packet this companion hears to a MeshCore-Analyzer-compatible
 * MQTT broker. Observation-only: MeshMonitor publishes, never subscribes.
 *
 * NOTE: the Ed25519 signing key is deliberately NOT part of this block. It lives
 * encrypted in `meshcore_observer_keys` (see meshcoreObserverKeyStore) so it never
 * rides along in a config response or the source-edit form round-trip.
 */
export interface MeshCoreObserverConfig {
  enabled?: boolean;
  /** Broker URL. ws/wss/mqtt/mqtts; bare host:port is normalized by normalizeBrokerUrl. */
  brokerUrl?: string;
  /** 3-letter IATA region code, or the literal 'test' for local validation. */
  iataCode?: string;
  /** Must equal the broker's AUTH_EXPECTED_AUDIENCE, or auth is rejected. */
  tokenAudience?: string;
}

export interface MeshCoreSourceConfig {
  // …existing fields…
  observer?: MeshCoreObserverConfig;   // add after `virtualNode`
}
```

Add a derivation helper next to `virtualNodeConfigFromSource` (L58-67):

```ts
export function observerConfigFromSource(cfg: MeshCoreSourceConfig): MeshCoreConfig['observer'] {
  const o = cfg.observer;
  if (!o?.enabled) return undefined;
  if (!o.brokerUrl || !o.iataCode || !o.tokenAudience) return undefined;
  return {
    enabled: true,
    brokerUrl: normalizeBrokerUrl(o.brokerUrl),
    iataCode: o.iataCode.trim().toUpperCase(),
    tokenAudience: o.tokenAudience.trim(),
  };
}
```

and plumb it through both return branches of `meshcoreConfigFromSource` (L108-116 and L118-127) as `observer: observerConfigFromSource(cfg)`.

Add the matching optional field to `MeshCoreConfig` in `src/server/meshcoreManager.ts` (after `virtualNode?` at L344):

```ts
/** Analyzer Observer MQTT output (#4457). Consumed by the Phase 2 publisher. */
observer?: MeshCoreObserverConfig;
```

This is ~8 lines and makes Phase 2 purely additive. It is not dead code — `observerConfigFromSource` is directly unit-tested (§8.1).

### 4.2 Restart decision: **reuse the existing hook; add nothing**

`sourceRoutes.ts` L836-851 already performs a full `removeManager` → `ensureMeshCoreManagerStarted` cycle on **any** config change to an enabled, autoConnect MeshCore source. The `observer` block lives inside that same `config` blob, so a Phase-2 publisher whose lifecycle is bound to the manager picks up observer changes for free, on day one, with zero new wiring.

**Justification for not adding a targeted hook now:**

1. **It is already correct.** Adding a `observerChanged` branch would duplicate behaviour the blanket restart already provides.
2. **There is nothing to hot-swap into.** A `reconfigureObserver()` in Phase 1 would be a no-op method with no callee — dead code that reviewers and the lint ratchet would rightly flag, and that Phase 2 would have to rewrite anyway once the publisher's real interface exists.
3. **The hot-swap precedents were added alongside their consumers**, not ahead of them: `reconfigureVirtualNode` (L759) and `reconfigureMqttLink` (L767-777) both landed with the subsystem they reconfigure.

**Known cost, accepted and documented:** toggling the observer bounces the companion's serial/TCP link (a few seconds of downtime), because the blanket restart cannot tell an observer-only change from a transport change. This is the same cost every other MeshCore config edit already pays today.

**Phase 2 follow-up (record in the epic's "Deviations / notes"):** add a targeted `observerChanged` branch calling `manager.reconfigureObserver(newCfg.observer)`, mirroring the `vnChanged` branch at L758-765, so an observer toggle no longer bounces the radio link.

### 4.3 No new global settings

Everything is per-source and lives in `sources.config` or `meshcore_observer_keys`. **`VALID_SETTINGS_KEYS` in `src/server/constants/settings.ts` needs no edit.** If an implementer finds themselves reaching for a global setting, stop and re-read this section — it means the design drifted.

---

## 5. Validation & secrets hygiene in `sourceRoutes.ts`

### 5.1 `validateObserverConfig` (NEW, exported, placed immediately after `validateVirtualNodeConfig` at L64)

```ts
export function validateObserverConfig(
  type: string,
  config: any,
): { status: number; error: string; code: string } | null
```

Note the added `code` field vs. `validateVirtualNodeConfig`'s `{status, error}` — the two call sites translate it via `fail()` (see §5.3). Order of checks matters:

| # | Check | Result |
|---|---|---|
| 1 | `config?.observer` is `undefined`/`null` | return `null` |
| 2 | `typeof observer !== 'object'` or is an array | 400 `INVALID_PARAMETER_TYPE` — "observer must be an object" |
| 3 | **Key-material rejection (runs regardless of `enabled`):** any of `privateKey`, `privateKeyHex`, `signingKey`, `key`, `secret` present as own properties | 400 `OBSERVER_KEY_IN_CONFIG` — "observer config must not contain key material; use POST /api/sources/:id/observer/key" |
| 4 | `type !== 'meshcore'` | 400 `INVALID_PARAMETER` — "observer config is only supported on meshcore sources" |
| 5 | `observer.enabled !== true` | return `null` (matches the VN pattern at L52) |
| 6 | `config.deviceType === 'repeater'` | 400 `OBSERVER_REQUIRES_COMPANION` — "the Analyzer Observer requires a Companion device; repeaters cannot export a signing key" |
| 7 | `brokerUrl` not a non-empty string | 400 `INVALID_PARAMETER` |
| 8 | `new URL(normalizeBrokerUrl(brokerUrl))` throws, or `protocol` not in `{ws:, wss:, mqtt:, mqtts:}`, or `hostname` empty | 400 `INVALID_BROKER_URL` — "observer.brokerUrl must be a ws/wss/mqtt/mqtts URL" |
| 9 | `iataCode` not a string matching `/^[A-Za-z]{3}$/` and not (case-insensitively) `test` | 400 `INVALID_IATA_CODE` — "observer.iataCode must be a 3-letter IATA code or 'test'" |
| 10 | `tokenAudience` not a non-empty string ≤ 255 chars, or contains whitespace | 400 `INVALID_PARAMETER` — "observer.tokenAudience must be a non-empty string with no whitespace" |
| — | otherwise | return `null` |

Check 3 must precede checks 4 and 5 so that key material is rejected even on a non-meshcore source or a disabled block. Check 8 uses `normalizeBrokerUrl` (import from `../transports/mqttBrokerClient.js`) so a user who types `mqtt-us-v1.letsmesh.net:443` gets the same treatment the Phase 2 client will give it.

`validateObserverConfig` is **synchronous** (unlike the VN validator, which needs a DB port-uniqueness sweep). There is no cross-source uniqueness constraint on observer config.

### 5.2 Call sites

- `POST /` — insert immediately after the `validateVirtualNodeConfig` call at L468, using `type` from the request body.
- `PUT /:id` — insert immediately after the call at L569, using `existing.type`.

Both currently do `return res.status(err.status).json({ error: err.error })`. The **new** observer branch uses the envelope: `return fail(res, err.status, err.code, err.error)`. Do not convert the surrounding VN branch — that would change an existing wire shape (CLAUDE.md envelope caveat).

### 5.3 Imports to add to `sourceRoutes.ts`

Split across two work packages — see §9:

- **WP2 adds:** `fail` from `../utils/apiResponse.js`, `normalizeBrokerUrl` from `../transports/mqttBrokerClient.js`.
- **WP4 adds:** `observerRoutes` from `./sourceObserverRoutes.js`, together with its `router.use` mount, **in the same commit that creates that file**. WP2 must not pre-add it — a dangling import would break the build for every implementer working during the WP3 window.

### 5.4 `stripSourceSecrets` hardening

The observer block itself carries **no secrets** — `brokerUrl`, `iataCode`, and `tokenAudience` are all public-by-nature (a broker address, a region code, and an audience string that the broker publishes in its own config). The private key is never in `config` by construction (§3.1) and is rejected by validation check 3.

Defence in depth is still required, because a pre-existing row could have been written before this validation existed:

```ts
// Runs for admins too — key material must never leave the process, ever.
function stripObserverKeyMaterial(cfg: any): any {
  const obs = cfg?.observer;
  if (!obs || typeof obs !== 'object') return cfg;
  const { privateKey, privateKeyHex, signingKey, key, secret, ...safeObserver } = obs;
  void privateKey; void privateKeyHex; void signingKey; void key; void secret;
  return { ...cfg, observer: safeObserver };
}
```

Wire it **above** the `isAdmin` early-return inside `stripSourceSecrets` (L237):

```ts
function stripSourceSecrets<T extends { config?: unknown } | null | undefined>(source: T, isAdmin: boolean): T {
  if (!source) return source;
  const baseCfg = stripObserverKeyMaterial((source.config as any) ?? {});
  if (isAdmin) return { ...source, config: baseCfg };
  const { password, apiKey, ...rest } = baseCfg;
  // …unchanged from here…
}
```

This is the one structural change to an existing function; keep it minimal and preserve the existing non-admin behaviour byte-for-byte.

### 5.5 Logging discipline

- **Never** log the private key, any prefix of it, or a minted token — not at `debug`, not at `trace`.
- Public key **is** loggable (it is broadcast over the air in every ADVERT). Log it truncated (`publicKey.substring(0, 8)`) to match the house style in `meshcoreCredentialStore.ts` L150.
- Log lines that are legitimate: `logger.info('[ObserverKey:<sourceId>] signing key stored (origin=device, pub=672053E6…)')`, `logger.debug('[ObserverToken:<sourceId>] minted token, exp=<iso>')` — note **no token value**.
- The token-minting module must not `logger.error(err)` an exception whose message could embed the key; catch and re-throw a sanitized `Error` with a fixed message.

---

## 6. New modules

### 6.1 `src/server/services/meshcoreObserverKeyStore.ts` (NEW)

Structural copy of `sourcePkiKeyStore.ts` L20-194, with a **new KDF info-string pair for key separation** (this is the critical difference — do not reuse the PKI or admin-cred info strings):

```ts
const KDF_VERSION = 1;
const KDF_INFO_AEAD        = 'meshcore-observer-key-aead-v1';
const KDF_INFO_FINGERPRINT = 'meshcore-observer-key-fingerprint-v1';
```

```ts
export interface ObserverKeyCapability { canStore: boolean; reason?: string }

export type ObserverKeyLoadResult =
  | { kind: 'none' }
  | { kind: 'ok'; privateKeyHex: string; publicKeyHex: string | null; origin: 'device' | 'manual' }
  | { kind: 'key_rotated'; storedKid: string };

export interface ObserverKeyStatus {
  stored: boolean;
  publicKey: string | null;          // 32-byte hex UPPER, or null
  origin: 'device' | 'manual' | null;
  updatedAt: number | null;
  keyRotated: boolean;               // envelope exists but SESSION_SECRET changed
  canStore: boolean;
  reason: string | null;
}

export class MeshCoreObserverKeyStore {
  constructor(sessionSecret: string, sessionSecretProvided: boolean);
  get capability(): ObserverKeyCapability;
  get currentFingerprint(): string;                                    // tests only
  async store(sourceId: string, privateKeyHex: string, publicKeyHex: string, origin: 'device' | 'manual'): Promise<void>;
  async load(sourceId: string): Promise<ObserverKeyLoadResult>;
  async clear(sourceId: string): Promise<void>;
  async status(sourceId: string): Promise<ObserverKeyStatus>;
}

export function getMeshCoreObserverKeyStore(): MeshCoreObserverKeyStore;
export function setMeshCoreObserverKeyStoreForTesting(store: MeshCoreObserverKeyStore | null): void;
```

Details:
- The plaintext put through AES-GCM is the **128-char hex string as UTF-8** (matching `MeshCoreCredentialStore.store`'s string handling), not the 64 raw bytes. Consistency with the credential store beats a 64-byte saving.
- `capability.canStore` is `false` when `sessionSecretProvided === false`, with the wording pattern of `sourcePkiKeyStore.ts` L56-61 adapted: *"SESSION_SECRET was not configured; an auto-generated value is in use. A stored Analyzer Observer signing key would be unrecoverable on every restart. Set SESSION_SECRET=$(openssl rand -hex 32) to enable the Analyzer Observer."*
- `store()` throws when `!canStore`; the route checks `capability` first and returns `CREDENTIAL_PERSISTENCE_DISABLED`.
- `status()` reads the row once and reports `keyRotated` by comparing `v`/`kid` **without attempting decryption** (cheap — same trick as `listRotated()` at `meshcoreCredentialStore.ts` L198-224). It **never** returns `storedKid` to callers (per `MESHCORE_REMOTE_ADMIN.md` L146-149: exposing kid lets a hostile script fingerprint `SESSION_SECRET` rotations).
- `hkdfBytes` copied verbatim from `sourcePkiKeyStore.ts` L145-148 (stable zero salt).

### 6.2 `src/server/services/meshcoreObserverToken.ts` (NEW)

```ts
import { createAuthToken, Utils } from '@michaelhart/meshcore-decoder';

/** Default token lifetime. Matches the broker README's 24h example. */
export const OBSERVER_TOKEN_TTL_SECONDS = 86_400;

export interface ObserverToken {
  /** JWT-style `header.payload.signature` (signature = 128 UPPER hex). SECRET — never log or return. */
  token: string;
  /** 32-byte hex UPPERCASE. Also the `{PUBLIC_KEY}` in username `v1_{PUBLIC_KEY}` and in topics. */
  publicKey: string;
  /** Unix seconds. */
  issuedAt: number;
  expiresAt: number;
}

/**
 * Derive the 32-byte public key from a 64-byte orlp private key.
 * MUST go through the library's WASM — the second 32 bytes of the private key
 * are the SHA-512 nonce prefix, NOT the public key (see spec §2.2).
 * Throws on a structurally invalid / unclamped key.
 */
export async function deriveObserverPublicKey(privateKeyHex: string): Promise<string>;

/** true iff `privateKeyHex` is 128 hex chars AND a valid orlp scalar. Never throws. */
export async function isValidObserverPrivateKey(privateKeyHex: string): Promise<boolean>;

/** Mint a token from raw material. Pure w.r.t. the DB — used by unit tests. */
export async function mintObserverToken(
  privateKeyHex: string,
  audience: string,
  opts?: { ttlSeconds?: number; nowSeconds?: number },
): Promise<ObserverToken>;

/**
 * Mint for a configured source: loads the stored key, reads `observer.tokenAudience`
 * from the source config, derives the public key, and signs.
 * Returns null when no key is stored, the envelope is rotated, the source is not
 * meshcore, or the observer block is absent/incomplete.
 */
export async function mintObserverTokenForSource(sourceId: string): Promise<ObserverToken | null>;
```

Implementation notes:
- `deriveObserverPublicKey` = `(await Utils.derivePublicKey(hex)).toUpperCase()`.
- `isValidObserverPrivateKey` = `/^[0-9a-fA-F]{128}$/.test(hex)` **and** `derivePublicKey` does not throw. Wrap in try/catch returning `false`; do not let the WASM error message escape (§5.5).
- `mintObserverToken` builds a **fresh** payload object (`createAuthToken` mutates it — §2.4):
  ```ts
  const iat = opts?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + (opts?.ttlSeconds ?? OBSERVER_TOKEN_TTL_SECONDS);
  const publicKey = await deriveObserverPublicKey(privateKeyHex);
  const token = await createAuthToken({ publicKey, aud: audience, iat, exp }, privateKeyHex, publicKey);
  return { token, publicKey, issuedAt: iat, expiresAt: exp };
  ```
- No caching in Phase 1. Phase 2 owns renewal/caching; a Phase-1 cache would be untested state.
- `mintObserverTokenForSource` is **not** exposed via any route in Phase 1. It exists so Phase 2's publisher has a tested seam, and it is covered by its own unit test.

### 6.3 `src/server/routes/sourceObserverRoutes.ts` (NEW)

`Router({ mergeParams: true })`, mounted from `sourceRoutes.ts` with one line next to L1420:

```ts
import observerRoutes from './sourceObserverRoutes.js';   // top of sourceRoutes.ts
// …
router.use('/:id/observer', observerRoutes);              // next to the waypoints mount, L1420
```

Both lines are **WP4's**, and land in the same commit as this file (§9) — never earlier, or `sourceRoutes.ts` would import a module that does not exist yet.

**Placement decision — `sourceRoutes.ts`, not the `meshcoreRoutes` barrel.** Justification:

1. **The barrel's guard would make three of the four routes unusable.** `meshcoreRouteGuard` (`meshcoreRouteShared.ts` L44-61) 404s any request whose source has no *registered* manager. An operator must be able to paste a signing key, check status, and clear a key on a source that has never connected (or whose device is unplugged). Only *import-from-device* legitimately requires a live manager.
2. **The exact-shape precedent lives in `sourceRoutes.ts`.** `/:id/pki-dm/status` + `/:id/pki-dm` (L1040-1096) are the same feature class — per-source encrypted key, status + extract-from-manager + clear — and they already do the "look up the manager opportunistically" dance (L1082-1085) that our import route needs.
3. **The config the routes validate lives in `sources.config`**, whose validation and restart hooks are all in `sourceRoutes.ts`.

Handlers resolve the manager the same way the PKI-DM route does:
```ts
const mgr = sourceManagerRegistry.getManager(sourceId);
if (!mgr || !isMeshCoreManager(mgr)) → SOURCE_NOT_CONNECTED
```
using `isMeshCoreManager` from `../sourceManagerTypes.js` — **never** `instanceof`, per CLAUDE.md.

Every handler begins with the shared preamble:
```ts
const source = await databaseService.sources.getSource(req.params.id);
if (!source) return fail(res, 404, 'SOURCE_NOT_FOUND', 'Source not found');
if (source.type !== 'meshcore') return fail(res, 400, 'INVALID_PARAMETER', 'Analyzer Observer applies to MeshCore sources only');
```

Write routes call `auditMeshcoreEvent(req, '<action>', 'configuration', { sourceId })` (`meshcoreRouteShared.ts` L159-170) — import it; it is already exported.

---

## 7. API surface

Base path: `/api/sources/:id/observer`

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/key` | `configuration:read` (`sourceIdFrom: 'params.id'`) | Key status. **Never returns the private key.** |
| `POST` | `/key/import` | `configuration:write` | Fetch from the connected companion via `exportPrivateKey()`, derive pubkey, store. |
| `PUT` | `/key` | `configuration:write` | Manual paste. Body `{ privateKey: string }`. |
| `DELETE` | `/key` | `configuration:write` | Forget the stored key. |

### 7.1 `GET /api/sources/:id/observer/key`

`200` → `ok(res, ObserverKeyStatus)`:
```json
{ "success": true, "data": {
  "stored": true, "publicKey": "672053E6…FD60", "origin": "device",
  "updatedAt": 1785503938000, "keyRotated": false, "canStore": true, "reason": null } }
```
`stored:false` returns `publicKey:null`, `origin:null`, `updatedAt:null`.
**Invariant (assert in tests): no response body from any of these four routes contains a 128-hex string.**

### 7.2 `POST /api/sources/:id/observer/key/import`

No body. Flow: capability gate → resolve manager → `exportPrivateKey()` → shape check → `deriveObserverPublicKey()` (semantic check) → `store(…, 'device')` → audit `meshcore_observer_key_import` → return the same status object as `GET`.

Apply `meshcoreDeviceLimiter` (`src/server/middleware/rateLimiters.js`) — this hits the physical device, exactly like `GET /config/private-key` (`meshcoreConfigRoutes.ts` L322).

### 7.3 `PUT /api/sources/:id/observer/key`

Body `{ privateKey: string }`. Flow: capability gate → strip whitespace and an optional `0x` prefix → `/^[0-9a-fA-F]{128}$/` → `isValidObserverPrivateKey()` (orlp clamping) → derive pubkey → `store(…, 'manual')` → audit `meshcore_observer_key_set` → status object.

Deliberately distinguishes *shape* errors from *semantic* errors so the Phase 3 UI can say something useful (§2.3).

### 7.4 `DELETE /api/sources/:id/observer/key`

Idempotent — deleting a non-existent key returns `200` with `stored:false`. Audit `meshcore_observer_key_clear`.

### 7.5 Error codes & edge cases

| Code | HTTP | Trigger | Route(s) |
|---|---|---|---|
| `SOURCE_NOT_FOUND` | 404 | no such source id | all |
| `INVALID_PARAMETER` | 400 | source is not `type: 'meshcore'` | all |
| `CREDENTIAL_PERSISTENCE_DISABLED` | 400 | `SESSION_SECRET` auto-generated (`canStore=false`); message = `capability.reason` | import, put |
| `SOURCE_NOT_CONNECTED` | 409 | no manager registered, or manager is not a MeshCore manager | import |
| `EXPORT_FAILED` | 409 | `exportPrivateKey()` returned `null` — disconnected mid-call, repeater firmware, or export refused | import |
| `INVALID_KEY_LENGTH` | 502 (import) / 400 (put) | returned/pasted string is not 128 hex chars | import, put |
| `INVALID_KEY_MATERIAL` | 502 (import) / 400 (put) | 128 hex but `derivePublicKey` throws (fails orlp clamping) | import, put |
| `INVALID_PARAMETER_TYPE` | 400 | `privateKey` missing or not a string | put |
| `INTERNAL_ERROR` | 500 | unexpected throw; log with `logger.error`, return a generic message | all |

Rationale for `502` on import vs `400` on put: a malformed value from the **device** is an upstream fault, not caller error; a malformed value from the **user** is caller error. Both use the same code names so the Phase 3 UI has one mapping table.

Additional edge cases the implementation must handle:

- **Envelope rotated** (`SESSION_SECRET` changed): `GET /key` reports `stored:true, keyRotated:true, publicKey:<clear column value>`. The clear `publicKey` column survives rotation and is still displayable. Re-importing or re-pasting overwrites the row and clears the flag. Never surface `storedKid`.
- **Import when a key already exists:** overwrite silently (the device is authoritative). No `confirm:true` gate — unlike `POST /config/private-key`, this is not destructive to the device.
- **Repeater source:** `exportPrivateKey()` already returns `null` for non-companion (`meshcoreManager.ts` L4443-4446) → `EXPORT_FAILED`. Config validation additionally blocks *enabling* observer on a repeater (§5.1 check 6).
- **Concurrent import + put:** last write wins; the repository `upsert` is read-then-write and both paths derive the pubkey from the key they store, so the row is never internally inconsistent.
- **Deleting a source:** out of scope for Phase 1 — the `meshcore_observer_keys` row is orphaned, exactly as a `source_pki_keys` row is today (`DELETE /:id` at L861 does not clean it up either). Note it as a known gap; do **not** add cascade cleanup in this phase (it would need the same treatment for `source_pki_keys` and belongs in its own change).

---

## 8. Test plan

All tests are standard Vitest files in the existing suite. **No standalone scripts.** Full suite must be green (0 failures) before the PR.

### 8.1 Unit — config & validation

`src/server/meshcoreConfig.observer.test.ts` (NEW)
- `observerConfigFromSource` returns `undefined` when block absent / `enabled:false` / missing any of the three required fields.
- Returns a normalized object: bare `host:8883` → `mqtts://host:8883`; `iataCode: 'mco'` → `'MCO'`; audience trimmed.
- `meshcoreConfigFromSource` carries `observer` on **both** the serial and TCP branches.

`src/server/routes/sourceRoutes.observerValidation.test.ts` (NEW) — direct calls to the exported `validateObserverConfig`, table-driven over §5.1:
- absent block → null; `enabled:false` → null.
- key material rejected even when `enabled:false` **and** even when `type !== 'meshcore'` (ordering assertion).
- non-meshcore type, repeater deviceType, each bad URL scheme (`tcp://`, `http://`, garbage), each bad IATA (`ab`, `abcd`, `1234`), `'test'`/`'TEST'` accepted, empty/whitespace audience.

### 8.2 Unit — key store

`src/server/services/meshcoreObserverKeyStore.test.ts` (NEW) — model on `sourcePkiKeyStore.test.ts`.
- Round-trip: `store` then `load` returns the identical 128-hex string, `publicKey`, and `origin`.
- Rotation: construct store A with secret `'a'`, store a key; construct store B with secret `'b'`; `load` → `{ kind: 'key_rotated' }` and `status().keyRotated === true` with `publicKey` still readable.
- `canStore:false` when `sessionSecretProvided:false`; `store()` throws.
- **Key separation:** a `SourcePkiKeyStore` built from the *same* `SESSION_SECRET` cannot decrypt an observer envelope (proves the new KDF info string works). Assert via `currentFingerprint` inequality plus a failed cross-load.
- `clear()` is idempotent; `status()` on an empty source returns `stored:false`.
- Envelope shape: parse the stored `encryptedPrivateKey` and assert `{v,kid,iv,ct,tag}` with `iv.length === 24`, `tag.length === 32`, and that the raw private key does **not** appear as a substring anywhere in the stored JSON.

### 8.3 Unit — token module (round-trips through the library's own verifier)

`src/server/services/meshcoreObserverToken.test.ts` (NEW)

Fixture generation — a valid orlp private key must be clamped, so tests derive one deterministically:
```ts
const seed = Buffer.alloc(32, 7);
const h = crypto.createHash('sha512').update(seed).digest();
h[0] &= 248; h[31] &= 63; h[31] |= 64;
const PRIV = h.toString('hex');    // deterministic, valid, checked in as a constant
```
Assertions:
- `deriveObserverPublicKey(PRIV)` is 64 uppercase hex chars and **differs from `PRIV.slice(64).toUpperCase()`** — this is the §2.2 regression guard. Name the test so it is obvious why: *"public key is derived, not the second half of the private key"*.
- `Utils.validateKeyPair(PRIV, derived)` is `true`.
- `isValidObserverPrivateKey`: `true` for `PRIV`; `false` for `'00'.repeat(64)`, for a 127-char string, for non-hex, for `crypto.randomBytes(64).toString('hex')` (unclamped) — and it never throws.
- **`verifyAuthToken(token, publicKey)` returns a non-null payload** with `aud`, `iat`, `exp` matching what was requested and `publicKey` uppercase. (Epic exit criterion.)
- `verifyAuthToken(token, <other pubkey>)` → `null`.
- Tamper: flip one char of the payload segment → `verifyAuthToken` → `null`.
- Expiry: `mintObserverToken(PRIV, 'aud', { ttlSeconds: -1 })` → `verifyAuthToken` → `null`.
- Header segment decodes to exactly `{"alg":"Ed25519","typ":"JWT"}`; signature segment is 128 chars and matches `/^[0-9A-F]{128}$/`.
- `mintObserverToken` does not mutate a caller-visible object and two calls with different `nowSeconds` produce different tokens.

WASM warning: these tests instantiate WASM several times. If the file is slow, keep it under ~30 cases; do not add a `beforeAll` WASM cache (the library re-instantiates internally regardless).

### 8.4 Repository — per-source isolation (**required**)

`src/db/repositories/meshcoreObserverKeys.perSource.test.ts` (NEW) — model on `src/db/repositories/meshcorePacketLog.perSource.test.ts`.
- Store distinct envelopes for `source-a` and `source-b`; `getBySourceId` returns each source's own row and never the other's.
- `deleteBySourceId('source-a')` leaves `source-b` intact.
- `hasKey` is per-source.
- `upsert` on `source-a` twice updates in place (one row) and does not create a row for `source-b`.

### 8.5 Routes — harness-based (**must** use `createRouteTestApp`)

`src/server/routes/sourceObserverRoutes.test.ts` (NEW)

Setup:
```ts
harness = await createRouteTestApp({ mount: app => app.use('/api/sources', sourceRoutes) });
await harness.db.sources.createSource({ id: 'obs-a', name: 'Obs A', type: 'meshcore', config: {}, enabled: true });
await harness.grant(harness.limited.id, 'configuration', 'read',  'obs-a');
await harness.grant(harness.limited.id, 'configuration', 'write', 'obs-a');
```
Mock only non-DB collaborators: `sourceManagerRegistry` (to return a fake MeshCore manager) and `setMeshCoreObserverKeyStoreForTesting(new MeshCoreObserverKeyStore('test-secret', true))`. **Do not** `vi.mock('../../services/database.js')`.

Cases:
- `GET /key` on an empty source → 200, `data.stored === false`.
- `PUT /key` with a valid `PRIV` → 200, `data.stored === true`, `data.publicKey` matches the derived value, `data.origin === 'manual'`; a follow-up `GET` agrees.
- `PUT /key` with 127 hex → 400 `INVALID_KEY_LENGTH`; with 128 non-hex chars → 400 `INVALID_KEY_LENGTH`; with unclamped 128-hex → 400 `INVALID_KEY_MATERIAL`; with `privateKey: 12345` → 400 `INVALID_PARAMETER_TYPE`.
- `POST /key/import` with a mocked manager returning `PRIV` → 200, `origin === 'device'`.
- `POST /key/import` with `exportPrivateKey → null` → 409 `EXPORT_FAILED`.
- `POST /key/import` with no registered manager → 409 `SOURCE_NOT_CONNECTED`.
- `POST /key/import` with a manager returning `'abcd'` → 502 `INVALID_KEY_LENGTH`.
- `DELETE /key` → 200 `stored:false`; a second `DELETE` also 200 (idempotent).
- Non-meshcore source (`harness.sourceA`, which is `meshtastic_tcp`) → 400 `INVALID_PARAMETER` on every route.
- Unknown source id → 404 `SOURCE_NOT_FOUND`.
- `canStore:false` store (constructed with `sessionSecretProvided:false`) → `PUT`/`POST` return 400 `CREDENTIAL_PERSISTENCE_DISABLED`; `GET` still 200 with `canStore:false` and a non-null `reason`.
- **Secret-leak sweep:** for every 2xx response above, assert `!/[0-9a-fA-F]{128}/.test(JSON.stringify(res.body))`.
- Envelope shape: every success body has `success:true` + `data`; every error body has `success:false`, `error`, `code`.

`src/server/routes/sourceObserverRoutes.perSource.test.ts` (NEW)
- `limited` granted `configuration:write` on `obs-a` only: `PUT /api/sources/obs-b/observer/key` → 403 (real middleware, real SQL).
- A key stored on `obs-a` is invisible from `GET /api/sources/obs-b/observer/key` (`stored:false`).
- Admin can reach both.
- Anonymous (no grants) → 403/401 on all four.

`src/server/routes/sourceRoutes.observerStrip.test.ts` (NEW, small) — seed a meshcore source whose stored `config` contains `observer.privateKey` (simulating a pre-validation row), then assert `GET /api/sources` and `GET /api/sources/:id` omit it **for both the admin and the limited user**.

### 8.6 Migration

`src/server/migrations/133_add_meshcore_observer_keys.test.ts` (NEW) — model on `130_add_waypoint_channel.test.ts`.
- Fresh SQLite DB: migration creates the table with the expected columns.
- Running it twice is a no-op (idempotency).
- Insert + select round-trip through the repository against the migrated schema.

### 8.7 Multi-backend

Per CLAUDE.md, a local run skips PG/MySQL silently. Before claiming the schema is verified, start the containers:
```bash
docker run -d --rm --name mm-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=meshmonitor_test -p 5433:5432 postgres:16
docker run -d --rm --name mm-test-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_USER=test \
  -e MYSQL_PASSWORD=test -e MYSQL_DATABASE=meshmonitor_test -p 3307:3306 mysql:8.4
```
and confirm via `numPendingTests` in the JSON reporter, not just `success:true`. `src/db/repositories/nodes.test.ts`'s hand-written DDL is **not** affected (we add no `nodes` column).

### 8.8 Lint ratchet

`npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` must be empty. New files must not introduce `@typescript-eslint/no-explicit-any` (the migration files' `client: any` / `pool: any` parameters follow the existing 088 pattern and are already the baselined convention for that directory — match it exactly rather than inventing new types). Do **not** run `npm run lint:baseline`.

---

## 9. Work packages

Implementers may run **concurrently in one shared worktree**. Files are assigned to exactly one package unless noted. Packages that touch a shared file are explicitly sequenced.

> **Shared-file hazard:** `src/db/migrations.ts`, `src/db/activeSchema.ts`, `src/services/database.ts`, `src/db/schema/index.ts`, `src/db/repositories/index.ts` are all touched by **WP1 only**. `src/server/meshcoreConfig.ts` and `src/server/meshcoreManager.ts` are touched by **WP2 only**. `src/server/routes/sourceRoutes.ts` has **two writers, separated in time, never concurrent**: WP2 lands the validator + 2 call sites + strip hoist; WP4 later adds the 2 mount lines. WP2 blocks WP4, so the file has exactly one writer at any instant — the temporal ordering resolves the sharing without either package holding a lock. No other package edits an existing file except `package.json` (WP0).
>
> **Never commit a dangling import.** Every package's commit must leave `npm run build` (server tsc) green on its own. In particular, the `import observerRoutes from './sourceObserverRoutes.js'` line and the file it names must land in the **same** commit (WP4's) — see the sequencing note under WP4.
>
> **rtk commit hazard:** `rtk`-wrapped `git commit` auto-stages. With concurrent agents in one worktree, always commit with an explicit pathspec (`git commit -- <files>`) or `rtk proxy git commit`, and audit the file list in each commit.

### WP0 — Dependency (blocking, ~10 min)

**Files:** `package.json`, `package-lock.json`
**Depends on:** nothing. **Blocks:** WP3.

- `npm install @michaelhart/meshcore-decoder@0.3.0` (`.npmrc` already pins `legacy-peer-deps=true`).
- Verify the lockfile records `0.3.0` and the license resolves MIT.

**Acceptance:** `npm ls @michaelhart/meshcore-decoder` shows `0.3.0`; a throwaway `node -e` round-trip of `createAuthToken` → `verifyAuthToken` succeeds; `npm run build` (server tsc) still passes.

### WP1 — Persistence layer (parallel with WP2)

**Files (exclusive):**
`src/db/schema/meshcoreObserverKeys.ts`, `src/db/schema/index.ts`, `src/db/activeSchema.ts`,
`src/db/repositories/meshcoreObserverKeys.ts`, `src/db/repositories/index.ts`, `src/services/database.ts`,
`src/server/migrations/133_add_meshcore_observer_keys.ts`, `src/server/migrations/133_add_meshcore_observer_keys.test.ts`,
`src/db/migrations.ts`, `src/db/repositories/meshcoreObserverKeys.perSource.test.ts`
**Depends on:** nothing. **Blocks:** WP3, WP4.

Scope: §3.2–3.5, tests §8.4 and §8.6.

**Acceptance:** migration 133 registered and idempotent on all three backends; `databaseService.meshcoreObserverKeys` resolves after `waitForReady()`; per-source isolation test green; no raw SQL outside the migration file.

### WP2 — Config block, validation, secrets strip (parallel with WP1)

**Files (exclusive):**
`src/server/meshcoreConfig.ts`, `src/server/meshcoreManager.ts` (single `observer?:` field addition at L344),
`src/server/routes/sourceRoutes.ts` — **validator + 2 call sites + strip hoist ONLY**,
`src/server/meshcoreConfig.observer.test.ts`, `src/server/routes/sourceRoutes.observerValidation.test.ts`,
`src/server/routes/sourceRoutes.observerStrip.test.ts`
**Depends on:** nothing. **Blocks:** WP4 (which is the sole writer of the 2 mount lines in `sourceRoutes.ts`).

Scope: §4.1, §4.3, §5.1–5.4, tests §8.1 and §8.5's strip test.

> **Sequencing note (WP2 side):** do **NOT** add `import observerRoutes from './sourceObserverRoutes.js'` or `router.use('/:id/observer', observerRoutes)`. Those two lines belong to WP4 and must land in the same commit as the file they reference. Adding them here would leave `sourceRoutes.ts` importing a non-existent module, breaking `npm run build` and every test that imports `sourceRoutes` — for the entire WP3 window, since WP4 cannot start until WP3 finishes. WP1 and WP3 implementers verify against this tree; keep it green.
>
> Note that §5.3's import list ("`fail`, `normalizeBrokerUrl`, and the observer sub-router") therefore splits across the two packages: WP2 adds `fail` + `normalizeBrokerUrl`; WP4 adds the sub-router import.

**Acceptance:** every §5.1 row has a test; `PUT`/`POST /api/sources` reject an observer block containing key material with `OBSERVER_KEY_IN_CONFIG`; `stripSourceSecrets` removes observer key material for admins too, with existing non-admin behaviour unchanged; §4.2 restart decision recorded as a comment near L836; **`npm run build` and the existing `sourceRoutes` test files are green at WP2's final commit** (no reference to `sourceObserverRoutes` anywhere in the diff).

### WP3 — Key store + token module

**Files (exclusive):**
`src/server/services/meshcoreObserverKeyStore.ts`, `src/server/services/meshcoreObserverKeyStore.test.ts`,
`src/server/services/meshcoreObserverToken.ts`, `src/server/services/meshcoreObserverToken.test.ts`
**Depends on:** WP0 (dependency), WP1 (repository + facade getter). **Blocks:** WP4.

Scope: §6.1, §6.2, tests §8.2 and §8.3.

**Acceptance:** the §2.2 regression test (*"public key is derived, not the second half of the private key"*) exists and passes; a token round-trips through the library's own `verifyAuthToken`; key-separation test proves the new KDF info string; no key or token appears in any log line (grep the module for `logger.*privateKey|logger.*token`).

### WP4 — HTTP routes

**Files (exclusive):**
`src/server/routes/sourceObserverRoutes.ts`, `src/server/routes/sourceObserverRoutes.test.ts`,
`src/server/routes/sourceObserverRoutes.perSource.test.ts`,
**+ 2 lines in `src/server/routes/sourceRoutes.ts`** — the `import observerRoutes from './sourceObserverRoutes.js'` and the `router.use('/:id/observer', observerRoutes)` mount next to L1420. WP4 is the **sole writer** of these two lines.
**Depends on:** WP1, WP3, and **WP2's final commit** (WP2 owns every other edit to `sourceRoutes.ts`). **Blocks:** nothing.

Scope: §6.3, §7, tests §8.5.

> **Sequencing note (WP4 side):** start only after WP2 has committed. Rebase/pull first, then add the 2 mount lines **in the same commit as `sourceObserverRoutes.ts`** so the import never dangles. Because WP2 is already finished by then, there is no concurrent writer to conflict with — the two-line diff applies cleanly next to L1420 (`router.use('/:id/waypoints', waypointRoutes)`).

**Acceptance:** all four routes behave per §7; every code in the §7.5 table has a test; the 128-hex leak sweep passes on every 2xx body; both route test files use `createRouteTestApp()` with real permission SQL; write routes emit audit rows; **the mount lines and `sourceObserverRoutes.ts` are in one commit and `npm run build` is green at that commit**.

### WP5 — Verification & docs (sequential, last)

**Files:** `docs/internal/dev-notes/MESHCORE_ANALYZER_OBSERVER_EPIC.md` (tick Phase 1 boxes, fill "Deviations / notes")
**Depends on:** WP1–WP4.

- Full Vitest suite with PG + MySQL containers up; confirm `numPendingTests` shows the multi-backend suites actually ran.
- `npm run lint:ci` (with the worktree grep filter) clean.
- Record in "Deviations / notes": (a) the §2.2 correction — public key is derived, not sliced; (b) the §4.2 restart decision and its Phase-2 follow-up; (c) the orphaned-row gap on source delete.

**Acceptance:** 0 test failures, lint gate clean, epic doc updated. PR created via `/create-pr`; CI monitored via `/ci-monitor`.

### Dependency graph

```
WP0 ─┐
     ├─────────────► WP3 ──┐
WP1 ─┤                     ├──► WP4 ──► WP5
     └─────────────────────┤
WP2 ─────────────────────► ┘   (WP2 finishes sourceRoutes.ts; WP4 then adds the 2 mount lines)
```
WP0, WP1, WP2 start in parallel. WP3 starts when WP0 and WP1 are committed. WP4 starts when WP2 and WP3 are committed.

`src/server/routes/sourceRoutes.ts` is written by WP2 then by WP4, never at the same time. The `WP2 → WP4` edge is what makes that safe, and it is also why the mount lines cannot be pre-added: between WP2's commit and WP4's commit the tree must stay buildable, because WP1 and WP3 implementers are verifying their own work against it during that window.

---

## 10. Explicitly OUT OF SCOPE for Phase 1

Do not implement any of the following. A PR containing them will be sent back.

- The observer publisher service (`meshcoreObserverPublisher`) — Phase 2.
- Any subscription to, or consumption of, the `ota_packet` event — Phase 2.
- Any MQTT connection, `MqttBrokerClient` instantiation, LWT, retained `/status` publish, or `MqttReconnectCoordinator` use — Phase 2.
- The analyzer packet JSON payload builder, MeshCore packet-hash computation, or advert privacy filtering — Phase 2.
- Token renewal, caching, or scheduling — Phase 2.
- Observer status fields on `MeshCoreManager.getStatus()` / `useSourceStatuses` — Phase 2.
- Any frontend change: no `DashboardPage.tsx` fieldset, no `MeshCoreConfigurationView` button, no locale strings, no `UiIcon` additions — Phase 3.
- User-facing documentation — Phase 3.
- A targeted `reconfigureObserver` hot-swap hook — Phase 2 (see §4.2).
- Cascade cleanup of `meshcore_observer_keys` on source delete (§7.5) — separate change.
- Any new global setting or `VALID_SETTINGS_KEYS` entry (§4.3).
