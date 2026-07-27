# ATAK / CoT Epic — Phase 3 Implementation Spec

**Epic:** issue #3691. **Phase 3 = final code phase.** Builds on Phase 1 (#4307,
TAKPacket V1 decode + GeoChat→messages) and Phase 2 (#4310, `atak_contacts` table
+ `atakContactService` + `AtakContactsLayer`).

**Deliverable of this phase:** a **plaintext TCP CoT feed server** (SA-server
style) that streams Cursor-on-Target `<event>` XML to ATAK/WinTAK clients that add
MeshMonitor as a network input. Settings-gated, **default OFF**, configurable port.
RX-only mesh→TAK: the server serves data outward and **discards** any inbound bytes
(no CoT ingestion). TLS is out of scope.

Feed content:
- **(a) ATAK contacts** — Phase 2 `atak_contacts`, all sources.
- **(b) all positioned mesh nodes from every source, including MeshCore** — the
  `nodes` table cross-source, synthesized into CoT events. This is MeshCore's only
  participation in the epic.

---

## 0. Binding decisions (interview + epic, do not relitigate)

| Decision | Value | Rationale |
|---|---|---|
| Transport | Plaintext TCP, streaming `<event>` XML | ATAK does not poll REST; native SA-server mechanism (cf. TAK Server TCP 8087). |
| Default state | **OFF** | Opt-in; exposing an unauthenticated data feed must be a deliberate act. |
| Port | Configurable, default **8088** | 8087 is the classic TAK streaming port; we default to **8088** to avoid clashing with a co-located real TAK Server, and because the container's other ports are already claimed. Operator maps it in Docker/helm. |
| Distribution model | **Periodic full-snapshot resend** + snapshot-on-connect | Simplest robust SA-server behavior; see §3.4 for the push-vs-periodic justification. |
| Auth | None | Documented limitation; plaintext feed, deploy on a trusted network / behind a firewall. Interview decision. |
| Inbound data | Discarded | RX-only mesh→TAK. |

---

## 1. Reuse inventory (serena/grep-verified — use these, do not reinvent)

### 1a. TCP listener precedent — `src/server/virtualNodeServer.ts` (CLOSEST MODEL)
`class VirtualNodeServer extends EventEmitter` is the codebase's canonical
settings-adjacent multi-client TCP listener. **Copy its lifecycle shape**, not its
protocol. Verified anchors:
- `constructor(config: VirtualNodeServerOptions /* { port } */)` — §L109.
- `async start()` (§L127): guards double-start (`logger.warn('already started')`),
  `this.server = net.createServer(...)`, attaches `this.server.on('error', ...)`
  which on `EADDRINUSE` **nulls `this.server` so a later `start()` can retry** and
  **only re-emits if `this.listenerCount('error') > 0`** (avoids turning a
  recoverable bind failure into an uncaught exception) — §L136–L146. Then
  `this.server.listen(this.config.port, () => { … this.emit('listening'); })`.
- `async stop()` (§L169): iterates `this.clients.values()` destroying each socket,
  `this.clients.clear()`, then closes the server and logs `🛑 … stopped`.
- Client tracking: `private clients: Map<string, ConnectedClient>` (§L87);
  `handleNewClient(socket)` (§L203) wires `socket.on('data'|'close'|'error')`;
  `handleClientDisconnect` deletes from the map. Per-client `socket.on('error')`
  logs and cleans up — no crash on abrupt disconnect.
- Inactive-client sweep: `private readonly CLEANUP_INTERVAL_MS = 60000` +
  `setInterval`. We reuse this idea for the **periodic snapshot resend** timer.

**Difference we must introduce:** `VirtualNodeServer` is *per-source*, constructed
by `MeshtasticManager` from `sources.config.virtualNode`. Our CoT feed is a
**single global singleton** gated by *global* settings (like the notification
services), NOT per-source. So model the *class internals* on `VirtualNodeServer`
but the *ownership/lifecycle* on the notification-service singletons (§1b/§1c).

### 1b. Global-singleton service + settings-save reaction — `settingsRoutes.ts` callbacks
The canonical "a global service reacts to a settings save" seam:
- `src/server/routes/settingsRoutes.ts` defines `interface SettingsCallbacks`
  (optional fn members, e.g. `restartLowBatteryService?`, `stopLowBatteryService?`,
  `restartInactiveNodeService?`, `setNoIndexEnabled?`), a module-level
  `let callbacks: SettingsCallbacks = {}`, and
  `export function setSettingsCallbacks(cb)`.
- Inside the `POST /settings` handler, after persisting, it invokes the relevant
  callback (e.g. `callbacks.restartLowBatteryService?.(check, cooldown)`).
- `src/server/server.ts` wires them once at boot: `setSettingsCallbacks({ …,
  restartInactiveNodeService: (t,c,cd) => …, stopLowBatteryService: () =>
  lowBatteryNotificationService.stop(), … })` (§server.ts L843–L861).

**We add two callbacks:** `restartCotFeed?: () => void` and `stopCotFeed?: () => void`
(or a single `applyCotFeedSettings?`). See §2c.

### 1c. Boot wiring — `src/server/server.ts`
Notification/scheduler singletons are imported at top (`inactiveNodeNotificationService`,
`lowBatteryNotificationService`, `positionEstimationScheduler`, …) and started in
the async boot block (`duplicateKeySchedulerService.start()`,
`positionEstimationScheduler.initialize()`), reading persisted values via
`await databaseService.settings.getSetting('<key>')` (e.g. `discardInvalidPositions`,
`noIndexEnabled`, `inactiveNodeThresholdHours`). **We import `cotFeedService` and
call `await cotFeedService.startFromSettings()` there.**

### 1d. Node enumeration across sources — `src/db/repositories/nodes.ts`
- `getAllNodes(sourceId: SourceScope): Promise<DbNode[]>` (§L233). Pass
  `ALL_SOURCES` (from `src/db/repositories/base.ts` §L33, a `unique symbol`;
  `type SourceScope = string | typeof ALL_SOURCES`) to get **every source incl.
  MeshCore + MQTT**. `DbNode` carries `sourceId`, so one call yields cross-source
  rows already tagged. (`databaseService.getAllNodesAsync()` is a deprecated
  cross-source shim over the same call — prefer `databaseService.nodes.getAllNodes(ALL_SOURCES)`.)
- `DbNode` position fields (from `src/db/schema/nodes.ts`): `nodeNum`, `nodeId`,
  `longName`, `shortName`, `hwModel`, `latitude`, `longitude`, `altitude`,
  `batteryLevel`, `lastHeard`, `publicKey`, plus `latitudeOverride`/
  `longitudeOverride`/`altitudeOverride`/`positionOverrideIsPrivate`.
- **Effective position helper:** `getEffectiveDbNodePosition(node)` in
  `src/server/utils/nodeEnhancer.ts` (§L47) applies the override columns. Use it so
  operator-set positions and privacy flags are honored (a private override must be
  respected — see §4).

### 1e. Source metadata — `src/server/sourceManagerRegistry.ts`
`getAllManagers(): ISourceManager[]` (§L129) and `getAllManagers().map(m =>
m.getStatus())` yield `SourceStatus { sourceId, sourceName, sourceType, connected,
nodeNum?, nodeId? }`. Build a `Map<sourceId, sourceName>` from this to enrich CoT
`<remarks>` with the human source name. (Nodes already carry `sourceId`; the
registry only supplies the display name.)

### 1f. MeshCore node identity (edge-case-critical)
`meshcoreManager.ts` §L5477 comment: **"MeshCore nodes have no meshtastic-style
nodeNum"** (synthesized/garbage — the write path keeps junk out but nodeNum is not
a stable network address). MeshCore `nodeId = '!' + senderPubKey.substring(0,8)`
(§L6760) — a stable, deterministic id. **Therefore the CoT `uid` scheme keys off
`nodeId`, not `nodeNum`** (see §2b uid rules): `nodeId` is stable and unique per
`(sourceId)` for both Meshtastic (`!<nodeNum hex>`) and MeshCore (`!<pubkey8>`).

### 1g. XML escaping — none server-side; hand-roll a tiny helper
No server-side XML escaper exists. `src/utils/nodeExport.ts` has a **frontend**
`escapeHtml` (§L141, private) — not importable server-side and only escapes 4 chars.
Per CLAUDE.md guidance, a tiny hand-rolled escape is fine. Ship `escapeXml()` inside
`cotFeedService.ts` (or a `src/server/utils/xml.ts`) escaping `& < > " '` — **this
is load-bearing security** (callsign/longName are attacker-influenceable → XML
injection). See §2b + §3.

### 1h. Docker / helm port surfaces (for docs WP)
- `Dockerfile` §L109 `EXPOSE 3001 8000`. Add the CoT port to this line.
- `docker-compose.yml` §L17 maps `"8080:3001"`; document adding
  `"8088:8088"` when the feed is enabled.
- Helm: `helm/meshmonitor/templates/service.yaml` + `deployment.yaml`
  (`containerPort: {{ .Values.service.targetPort }}`), `values.yaml`. Docs note
  only — the feed is a raw TCP port an operator opts into; no default helm change
  required beyond a documented values snippet.

### 1i. Settings machinery (recipe surfaces — CLAUDE.md "Adding New Settings")
- `src/server/constants/settings.ts` → `VALID_SETTINGS_KEYS` array (§the single
  source of truth; server.ts + persistence tests both import it). Add the two keys.
- `SettingsTab` uses one `SettingsDraft` reducer + a hand-maintained `handleSave`
  object literal (see §2e for the exact edit points).
- `src/server/routes/settingsRoutes.test.ts` /
  `server.settings-persistence.test.ts` key off `VALID_SETTINGS_KEYS` and the
  `handleSave` literal — see §5 test plan.

---

## 2. File-by-file changes

### 2a. `src/server/services/cotFeedService.ts` (NEW) — the feed server
A **single global singleton** (`export const cotFeedService = new CotFeedService();`
+ default export) that owns the TCP server, the client set, and the resend timer.
Class internals modeled on `VirtualNodeServer`; pure builders exported for testing.

```ts
export interface CotFeedConfig { enabled: boolean; port: number; }

const COT_DEFAULT_PORT = 8088;
const COT_MAX_CLIENTS = 16;                    // §3
const COT_RESEND_INTERVAL_MS = 30_000;         // periodic snapshot cadence
const COT_CONTACT_STALE_MS = ATAK_CONTACT_STALE_MS;  // reuse Phase 2 constant (15 min)
const COT_NODE_STALE_MS = 60 * 60_000;         // 60 min — see §3.3 justification

// ---- pure builders (no I/O, unit-tested in isolation) ----
export function escapeXml(s: string): string;  // & < > " ' → entities
/** ATAK contact → <event> XML. uid = row.uid (already the EUD device id). */
export function buildContactEvent(row: AtakContactRow, now: number): string | null;
/** Positioned node → <event> XML. Returns null if no effective position/too stale. */
export function buildNodeEvent(node: DbNode, sourceName: string | undefined, now: number): string | null;
/** uid for a synthesized node event. */
export function nodeUid(node: Pick<DbNode,'sourceId'|'nodeId'>): string; // `MESHMON-${sourceId}-${nodeId}`

class CotFeedService {
  private server: net.Server | null = null;
  private clients: Set<net.Socket> = new Set();
  private resendTimer: ReturnType<typeof setInterval> | null = null;
  private config: CotFeedConfig = { enabled: false, port: COT_DEFAULT_PORT };

  /** Read cotFeedEnabled/cotFeedPort from DB and (re)start or stop accordingly. Boot + settings-save entry point. */
  async startFromSettings(): Promise<void>;
  /** Idempotent restart with the given config (stop-then-start on port change). */
  async restart(config: CotFeedConfig): Promise<void>;
  async start(): Promise<void>;   // binds; EADDRINUSE handled like VN (log + no crash, no retry loop)
  async stop(): Promise<void>;    // clears timer, destroys clients, closes server
  getStatus(): { enabled: boolean; port: number; clientCount: number; listening: boolean };

  private handleNewClient(socket: net.Socket): void; // cap check, add to set, socket.on(data|close|error), send snapshot
  private async buildSnapshot(): Promise<string>;    // all contacts (all sources) + all positioned nodes(ALL_SOURCES)
  private async broadcastSnapshot(): Promise<void>;  // build once, write to every client, drop dead sockets
}
```

Behavior details:
- **`startFromSettings()`**: `enabled = parseBool(getSetting('cotFeedEnabled'))`,
  `port = parseInt(getSetting('cotFeedPort')) || COT_DEFAULT_PORT`. If `!enabled`
  → `await this.stop()`. Else `await this.restart({enabled, port})`.
- **`restart(config)`**: if already listening on the same port and enabled, no-op;
  otherwise `await this.stop()` then, if `config.enabled`, `await this.start()`.
  Capture the target config into `this.config` first.
- **`start()`**: `net.createServer(socket => this.handleNewClient(socket))`;
  `server.on('error', err)` → on `EADDRINUSE` log a clear error
  (`❌ CoT feed port ${port} in use — feed disabled`), set `this.server = null`,
  **do not throw** (must not crash boot). `server.listen(port, host, () => …)`.
  Start `this.resendTimer = setInterval(() => void this.broadcastSnapshot(), COT_RESEND_INTERVAL_MS)`.
- **Bind host:** default **`0.0.0.0`** (all interfaces) — ATAK clients are remote by
  definition, a loopback bind would make the feature useless. Documented as a
  security trade-off (§3). (Optional stretch: a `cotFeedBindAddress` setting; NOT
  in scope — keep to two keys.)
- **`handleNewClient`**: if `this.clients.size >= COT_MAX_CLIENTS` → log + `socket.destroy()`.
  Else add to set; `socket.on('data', () => {})` **discards inbound** (RX-only);
  `socket.on('error', …)` logs + removes; `socket.on('close', …)` removes. Then
  immediately `socket.write(await this.buildSnapshot())` inside try/catch (client
  may vanish mid-write — see §4).
- **`buildSnapshot()`**: `now = Date.now()`; gather
  `databaseService.atakContacts.getContacts(<each source>)` **or** a cross-source
  read (see §6 open question Q1), map through `buildContactEvent`; and
  `databaseService.nodes.getAllNodes(ALL_SOURCES)` mapped through `buildNodeEvent`.
  Concatenate non-null events. **De-dupe by uid** so a node that also has an ATAK
  contact row does not appear twice — contact events win (richer team/role/battery);
  drop the node event when its `nodeUid` collides with a contact whose `nodeNum`
  matches (best-effort; document as heuristic).
- **`broadcastSnapshot()`**: build once, `for (const s of this.clients) { try {
  s.write(snapshot) } catch { this.clients.delete(s); s.destroy() } }`.

### 2b. CoT `<event>` XML shape (pure builders)
Minimal ATAK-compatible event (protocol facts, epic doc §"Protocol facts"):

```
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<event version="2.0" uid="MESHMON-<sourceId>-<nodeId>" type="a-f-G-U-C"
       how="m-g" time="<ISO>" start="<ISO>" stale="<ISO>">
  <point lat="<deg>" lon="<deg>" hae="<m|9999999.0>" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="<escaped>"/>
    <__group name="<team>" role="<role>"/>          <!-- ATAK contacts only, when known -->
    <status battery="<0-100>"/>                       <!-- when known -->
    <track speed="<m/s>" course="<deg>"/>             <!-- when known -->
    <remarks><escaped source name + node meta></remarks>
  </detail>
</event>
```

Rules:
- **`type`** — `a-f-G-U-C` (atom · friendly · Ground · Unit · Combat) for both mesh
  nodes and ATAK EUDs. Justification: mesh nodes are "friendly ground units" to the
  operator; `a-f-G-U-C` is the standard generic friendly-ground symbol ATAK renders
  as a blue rectangle. ATAK contacts *could* use their reported CoT type later, but
  V1 PLI carries no CoT type, so a-f-G-U-C is correct and uniform. (Nice-to-have
  future: sensor/repeater → `a-f-G-E-S`; out of scope.)
- **`uid`** — nodes: `MESHMON-${sourceId}-${nodeId}` (deterministic, stable; §1f).
  contacts: the Phase 2 `row.uid` (the ATAK EUD `device_callsign`, already the
  device's own stable UID — reusing it lets ATAK correlate our echo with the EUD's
  own beacon). **Do NOT prefix contact uids with MESHMON-** — that would create a
  ghost duplicate of the EUD's real marker.
- **`time`/`start`** = `now` (ISO 8601, `new Date(now).toISOString()`).
- **`stale`** = last-report + per-type window, floored so we never emit an
  already-stale event we still include (§3.3). Contacts: `lastSeen + COT_CONTACT_STALE_MS`.
  Nodes: `lastHeard*1000 + COT_NODE_STALE_MS` (lastHeard is epoch **seconds**).
- **`hae`** (height above ellipsoid) = altitude in metres, or sentinel `9999999.0`
  when null. `ce`/`le` always `9999999.0` (we don't model circular/linear error).
- **`callsign`** — nodes: `shortName || longName || nodeId`; contacts:
  `row.callsign || row.deviceCallsign || row.uid`. **Always `escapeXml`'d.**
- **`<__group>`** — ATAK contacts only, when `team`/`role` known. Map the numeric
  team/role enums to ATAK strings via a small table (reuse/extend
  `src/utils/atakTeam.ts` team labels/colors from Phase 2 — verify export shape;
  ATAK `<__group>` wants team *name* like "Cyan" and role like "Team Member").
- **`<remarks>`** — `escapeXml(\`${sourceName ?? sourceId} · ${nodeId}\`)` plus
  hwModel/lastHeard age; purely informational.
- **Return `null`** from a builder when there is no usable position (both lat & lon
  null/NaN after `getEffectiveDbNodePosition`), when the effective position is a
  private override, or when `stale <= now` (already expired — don't ship it).

### 2c. `src/server/routes/settingsRoutes.ts` — new callbacks
Add to `interface SettingsCallbacks`:
```ts
  /** Re-read cotFeed* settings and (re)start/stop the CoT feed server. */
  restartCotFeed?: () => void;
  /** Stop the CoT feed server. */
  stopCotFeed?: () => void;
```
In `POST /settings`, after persistence, when either `cotFeedEnabled` or
`cotFeedPort` is present in the incoming body: `callbacks.restartCotFeed?.();`
(a single restart callback covers both enable-toggle and port-change; `restartCotFeed`
internally calls `cotFeedService.startFromSettings()` which stops when disabled, so
`stopCotFeed` is optional — include it for symmetry/explicitness only). Follow the
existing `restartLowBatteryService` invocation pattern.

### 2d. `src/server/server.ts` — boot + callback wiring
- Import: `import { cotFeedService } from './services/cotFeedService.js';`
- In the async boot block (next to `positionEstimationScheduler.initialize()` etc.):
  `await cotFeedService.startFromSettings();` inside a try/catch that logs and
  continues (a feed bind failure must never abort boot).
- In the `setSettingsCallbacks({ … })` object (§server.ts L843): add
  `restartCotFeed: () => { void cotFeedService.startFromSettings(); },`
  `stopCotFeed: () => { void cotFeedService.stop(); },`.
- Graceful shutdown: if there's a SIGTERM/close handler stopping other services,
  add `await cotFeedService.stop();` (search for existing shutdown seam; if none,
  skip — the process exit closes the socket anyway).

### 2e. `src/server/constants/settings.ts` — two new keys
Append to `VALID_SETTINGS_KEYS`:
```ts
  // ATAK/CoT Phase 3 (issue #3691): plaintext TCP CoT feed for ATAK/WinTAK.
  // Default OFF. When enabled, streams CoT <event> XML on cotFeedPort.
  'cotFeedEnabled',
  'cotFeedPort',
```
Neither is secret → **not** added to `SECRET_SETTINGS_KEYS`.

### 2f. `SettingsTab` UI — SettingsDraft recipe (EXACT edit points)
Follow CLAUDE.md "Adding New Settings" precisely. Enumerated edits:
1. **`SettingsDraft` type** (in `SettingsTab`/its context): add
   `cotFeedEnabled: boolean;` and `cotFeedPort: number;` (or string — match how
   other numeric port-ish fields are typed; store as string in the input, coerce on
   save).
2. **`buildBaseline()`** (or the `initial*` source it reads): seed
   `cotFeedEnabled: <from server settings, default false>`,
   `cotFeedPort: <default 8088>`.
3. **Inputs:** a new "ATAK / CoT Feed" section (see §2g) with a toggle bound via
   `updateField('cotFeedEnabled', v)` and a number input bound via
   `updateField('cotFeedPort', v)`. Use `UiIcon` for any iconography — **no raw
   emoji/Unicode** in JSX/locale copy.
4. **`handleSave` object literal:** add `cotFeedEnabled: draft.cotFeedEnabled ? '1' : '0'`
   and `cotFeedPort: String(draft.cotFeedPort)` to the hand-maintained
   `const settings = { … }` literal. **This literal is the source-of-truth the
   persistence test extracts — the keys MUST match `VALID_SETTINGS_KEYS`.**
5. **Do NOT touch any dependency array** — `handleSave`/dirty-diff/re-seed/`resetChanges`
   read the draft generically.
6. Add locale strings (label, help text, "port in use" hint) to the locale files
   touched by Phase 2 (mirror the ATAK section already added there).

### 2g. Settings UI section content (minimal status surface)
A small "ATAK / CoT Feed" card:
- Toggle: **Enable CoT feed** (default off) + one-line help: *"Streams mesh node
  and ATAK contact positions to ATAK/WinTAK over plaintext TCP. No encryption or
  authentication — use only on a trusted network."*
- Number input: **Feed port** (default 8088), only editable/relevant when enabled.
- **Nice-to-have status line (keep minimal):** "N clients connected" read from a new
  `GET /api/atak/cot-feed/status` (or fold into an existing status endpoint)
  returning `cotFeedService.getStatus()`. Gate behind `requirePermission('settings','read')`
  or `optionalAuth`. If time-boxed, ship the toggle+port without the live count and
  file the count as a follow-up — the count is explicitly optional.

---

## 3. Security & resource limits

1. **Bind address = `0.0.0.0` (all interfaces), default OFF.** A loopback-only bind
   would defeat the feature (ATAK EUDs are remote). Trade-off documented in Settings
   help text and README: the feed is **plaintext and unauthenticated**; enabling it
   exposes node/contact positions to anyone who can reach the port. Recommend
   firewalling / VPN / trusted LAN. TLS + auth are deferred (future phase).
2. **Inbound data discarded.** `socket.on('data', () => {})` — we never parse client
   input, eliminating a parser attack surface. No CoT ingestion.
3. **Max clients cap = 16 (`COT_MAX_CLIENTS`).** Justification: a home/edge
   MeshMonitor feeding a TAK team; 16 concurrent EUDs is generous while bounding
   memory/write-amplification of the 30 s broadcast. Excess connections are
   `destroy()`ed immediately with a logged warning. (Configurable knob deliberately
   avoided — keep to two settings.)
4. **No unbounded buffering.** We only ever `write()` a freshly-built snapshot; we
   never accumulate per-client queues. A slow/backpressured client that can't drain
   is dropped on the next failed write.
5. **XML injection** — every attacker-influenceable string (callsign, longName,
   shortName, source name, remarks) passes through `escapeXml`. This is the single
   most important correctness/security invariant of the phase; it has dedicated
   tests (§5).
6. **No secrets in the feed** — positions only; `cotFeed*` keys are not secret.

---

## 3.1–3.4 Design justifications

### 3.3 Stale-time scheme (derived from actual report cadence)
Stale must (a) outlive the resend interval so entries don't flicker between
snapshots, and (b) reflect real data freshness so ATAK naturally ages out things we
stopped hearing.
- **ATAK contacts:** `stale = lastSeen + COT_CONTACT_STALE_MS` where
  `COT_CONTACT_STALE_MS = ATAK_CONTACT_STALE_MS` (Phase 2, **15 min**). ATAK PLI
  beacons cadence is seconds-to-minutes, so 15 min after the last-seen the contact
  is genuinely stale. Reusing the Phase 2 constant keeps the map layer and the feed
  consistent.
- **Mesh nodes:** `stale = lastHeard + COT_NODE_STALE_MS` with
  `COT_NODE_STALE_MS = 60 min`. Node position/telemetry cadence is
  minutes-to-hours; 60 min tolerates a couple of missed intervals before ATAK
  expires the marker. Because we recompute `stale` from `lastHeard` on **every**
  30 s resend, a node we stop hearing ages out on the client at `lastHeard + 60 min`
  even while MeshMonitor keeps broadcasting other nodes.
- **Freshness filter:** builders return `null` when `stale <= now` — we never ship
  an already-expired event. This also means we don't need a separate "only nodes
  seen in the last N hours" query; the stale computation self-filters, and stale
  entries simply drop out of the snapshot.

### 3.4 Push-on-event vs periodic resend — **periodic wins**
Chosen: **periodic full-snapshot resend every 30 s + immediate snapshot on connect.**
- ATAK dedupes by `uid` and honors `stale`, so re-sending an unchanged event is
  free (idempotent refresh) — the SA-server model.
- Push-on-event would require hooking *every* write path that changes a node or
  contact across **three** ingest pipelines (Meshtastic TCP, MQTT, MeshCore) plus
  the Phase 2 contact upsert — a large, fragile, easy-to-miss surface. A missed hook
  = a stale/absent ATAK marker with no visible error.
- Periodic resend is O(clients × nodes) every 30 s — trivial at edge scale (hundreds
  of nodes, ≤16 clients) — and is self-healing: a transiently missed update is
  corrected within 30 s. Complexity/robustness trade strongly favors periodic.
- Snapshot-on-connect guarantees a newly-joined ATAK client sees the full picture
  immediately rather than waiting up to 30 s.

---

## 4. Edge cases (each → a test)

| # | Case | Required behavior |
|---|---|---|
| E1 | **Port already in use** (`EADDRINUSE`) | Log a clear error, leave `server=null`, **do not throw / do not crash boot**. Feed simply doesn't come up; toggling off→on or changing port can retry. |
| E2 | **Client disconnects mid-write** | `socket.write` in try/catch (or rely on `error`/`close` handlers); drop the socket from `clients`; no unhandled exception; other clients unaffected. |
| E3 | **Node with position but no name** | Callsign falls back `shortName→longName→nodeId`; event still emitted. |
| E4 | **Node with name but no position** | `getEffectiveDbNodePosition` → null lat/lon ⇒ builder returns `null` ⇒ node omitted (ATAK contacts must have a point). |
| E5 | **XML-unsafe chars in callsign/name** (`<b>&"'`) | `escapeXml` produces well-formed XML; a fuzz-y string round-trips to valid entities. **Dedicated test.** |
| E6 | **Private position override** (`positionOverrideIsPrivate=true`) | Respect privacy — omit the node from the feed (or emit without a point ⇒ omitted). Verify `getEffectiveDbNodePosition` semantics and gate on the private flag explicitly. |
| E7 | **Source deleted while streaming** | Next `buildSnapshot` simply won't include its nodes/contacts (they're gone from the DB); no crash; sourceName lookup tolerates missing id (falls back to raw sourceId). |
| E8 | **Feed enabled with zero data** | Snapshot is empty string / just the XML preamble; connect succeeds; nothing rendered; no error. |
| E9 | **MeshCore node identity** | uid keys off `nodeId` (`!<pubkey8>`), never the unstable synthesized nodeNum; two MeshCore nodes get distinct uids; a MeshCore node with a position renders. |
| E10 | **Toggle off while clients connected** | `stop()` destroys all client sockets, clears timer, closes server; `clients` empty; a later enable rebinds cleanly. |
| E11 | **Port change while enabled** | `restart()` stops the old listener (dropping clients) and binds the new port; old port freed. |
| E12 | **Node also has an ATAK contact row** | De-duped by uid/nodeNum; contact event (richer) wins; node event suppressed. |

---

## 5. Test plan

All Vitest, SQLite-first (PG/MySQL not needed — no schema/migration in this phase).

### 5a. Pure builder tests — `src/server/services/cotFeedService.builders.test.ts`
- `escapeXml`: `&<>"'` → correct entities; idempotency not required but no double-escape bug; plain strings unchanged.
- `buildNodeEvent`: full node → well-formed `<event>` with correct uid
  (`MESHMON-<sourceId>-<nodeId>`), `type="a-f-G-U-C"`, lat/lon, hae from altitude,
  ISO time/start/stale, callsign fallback chain, `stale = lastHeard + 60min`.
- `buildNodeEvent` returns `null` for: no position (E4), private override (E6),
  already-stale (`lastHeard` older than 60 min) (E from §3.3).
- `buildContactEvent`: full PLI contact → `<__group>`/`<status battery>`/`<track>`
  present; uid == `row.uid` (no MESHMON prefix); `stale = lastSeen + 15min`;
  team/role enum→string mapping; missing group/battery ⇒ those sub-elements omitted.
- **XML validity:** parse each produced event with a lightweight XML parser (e.g.
  `fast-xml-parser` if already a dep, else a regex well-formedness assert) and assert
  attributes; **feed an injection payload callsign (`a"/><evil>`) and assert the
  parsed tree has a single `<event>` with the literal callsign** (E5).
- `nodeUid` stability: same `(sourceId,nodeId)` → same uid; MeshCore `!pubkey8` id
  produces a stable uid (E9).

### 5b. Service lifecycle tests — `src/server/services/cotFeedService.lifecycle.test.ts`
Mock `databaseService.settings.getSetting` + `databaseService.nodes.getAllNodes` +
`databaseService.atakContacts.getContacts`.
- `startFromSettings` with enabled=false → not listening.
- enabled=true, port=0 (ephemeral) → listening; `getStatus().listening===true`.
- Toggle off (`startFromSettings` with enabled=false after being up) → `stop()`
  path, not listening, clients cleared (E10).
- Port change → old server closed, new port bound (E11) (use two ephemeral ports).
- **Port conflict (E1):** occupy a port with a throwaway `net.createServer().listen`,
  point the service at it, assert `start()` resolves (no throw) and `getStatus().listening===false`
  and an error was logged; boot-continues.

### 5c. Integration TCP test — `src/server/services/cotFeedService.integration.test.ts`
Precedent: `src/server/virtualNodeServer.test.ts` exists (in-process TCP server
test). Model on it.
- Start the service on an **ephemeral port** (`port: 0`; read the actual port from
  `server.address()` — expose via `getStatus()` or a test hook).
- Seed 1–2 positioned nodes + 1 contact via the mocked repositories.
- `net.connect(port, '127.0.0.1')`, collect `data`, assert within a timeout that a
  well-formed `<event …>` snapshot arrives containing the seeded uids.
- Assert **inbound data is ignored**: write garbage to the socket, service does not
  error, connection stays open, next periodic snapshot still arrives (use fake
  timers or a short interval override to avoid a 30 s wait).
- Connect a second client → also gets a snapshot (multi-client, E-multi).
- Exceed `COT_MAX_CLIENTS` (temporarily lower the cap via a test hook/const) → the
  extra socket is closed (§3.3 cap).
- Disconnect a client mid-stream → service continues serving the other (E2, E10).

### 5d. Settings allowlist / persistence — expectations
- `src/server/routes/settingsRoutes.test.ts` (or `server.settings-persistence.test.ts`):
  POST `{ cotFeedEnabled:'1', cotFeedPort:'8088' }` is accepted (keys in
  `VALID_SETTINGS_KEYS`) and persisted; an unknown key is still rejected.
- The persistence test that source-extracts the `handleSave` object literal must see
  `cotFeedEnabled`/`cotFeedPort` — ensure the literal keys match exactly (CLAUDE.md
  gotcha). No count-bump test to touch (allowlist is derived).
- If a `restartCotFeed` callback is invoked on save, add a spy assertion that saving
  a `cotFeed*` key triggers it (mirror the existing `restartLowBatteryService`
  save-side-effect test if one exists).

### 5e. Gate
Full Vitest suite 0 failures; `npm run lint:ci` clean (filter out `.claude/worktrees`
noise); `tsc` clean. No new `no-explicit-any` / raw-`fetch` baseline growth.

---

## 6. Work packages (ordered)

### WP1 — CoT feed service + pure builders (backend core) — FIRST
**Files:** `src/server/services/cotFeedService.ts` (NEW: class + `escapeXml` +
`buildNodeEvent`/`buildContactEvent`/`nodeUid`), builder tests (§5a), lifecycle
tests (§5b), integration TCP test (§5c). Reuse `getEffectiveDbNodePosition`,
`getAllNodes(ALL_SOURCES)`, `atakContacts.getContacts`, `ATAK_CONTACT_STALE_MS`,
`atakTeam` mappings.
**Acceptance:** singleton starts/stops/restarts cleanly on an ephemeral port;
EADDRINUSE never throws; snapshot-on-connect + 30 s resend both work; inbound
discarded; max-client cap enforced; builders produce well-formed, injection-safe
XML with correct uid/type/stale; a real `net.connect` receives valid events; all
§5a–§5c tests green; lint/tsc clean.

### WP2 — Settings wiring + boot + SettingsTab UI (depends on WP1)
**Files:** `src/server/constants/settings.ts` (2 keys), `src/server/server.ts`
(import + `startFromSettings()` in boot + `restartCotFeed`/`stopCotFeed` in
`setSettingsCallbacks`), `src/server/routes/settingsRoutes.ts` (callback members +
invocation), SettingsTab draft/baseline/inputs/handleSave (§2f), optional status
endpoint + `getStatus()` surface, locale files, `settingsRoutes.test.ts` /
`server.settings-persistence.test.ts` updates (§5d).
**Acceptance:** feed default OFF; enabling via Settings starts the listener without
a restart; changing the port rebinds; disabling stops it; keys persist and round-trip;
allowlist/persistence tests green; UI uses `UiIcon`, no raw `fetch` in the component;
no dependency-array edits; lint/tsc clean.

### WP3 — Docs + Docker/helm port notes + browser validation (depends WP2)
**Files:** `Dockerfile` (`EXPOSE` add the port), README / user docs section
("ATAK / CoT feed": how to enable, port, add MeshMonitor as an ATAK network input,
security caveats), Docker-compose + helm `values.yaml` port-mapping snippet in docs,
epic doc Phase 3 checkbox close-out + decisions log entry.
**Acceptance:** operator can follow the docs to enable the feed and add it in ATAK;
port surfaces documented for Docker + helm; browser-validate the Settings toggle
end-to-end (enable → `getStatus`/logs show listening; `net.connect`/`ncat` shows XML);
epic doc updated; PR merged with CI green (system-test label only if hardware
needed — not required here).

---

## 7. Open questions / flags for the phase lead

- **Q1 — cross-source contact read.** Phase 2's `atakContacts.getContacts(sourceId)`
  is per-source. For the snapshot we need all sources. Confirm whether to (a) loop
  `getAllManagers()` sourceIds calling `getContacts` per source, or (b) add a
  `getAllContacts()` / `getContacts(ALL_SOURCES)` repository method (cleaner; small
  addition, `withSourceScope` already supports `ALL_SOURCES`). Recommend (b) —
  one query, mirrors `getAllNodes(ALL_SOURCES)`. This is a tiny repo add, not a
  migration.
- **Q2 — default port 8088 vs 8087.** I chose **8088** to avoid colliding with a
  co-located real TAK Server (8087). If the intended deployment never co-locates a
  TAK Server, 8087 is the more "expected" value. Confirm.
- **Q3 — node/contact de-dupe (E12).** The uid schemes differ (nodes: MESHMON-…,
  contacts: raw EUD uid), so they won't auto-dedupe by uid. Matching is best-effort
  by `nodeNum`. Acceptable to ship the heuristic, or prefer emitting both (an EUD
  and its carrying mesh node are arguably distinct map objects)? Recommend: **emit
  both** — they represent different real-world things (the ATAK device vs the mesh
  radio) and ATAK users expect the EUD marker; drop the de-dupe complexity. (If so,
  simplify §2a `buildSnapshot` — remove the collision drop.) **Flagging for a
  decision; leaning emit-both.**
- **Q4 — live client-count status.** Explicitly optional per the brief. Ship the
  endpoint only if WP2 has headroom; otherwise follow-up.
- **Q5 — graceful shutdown.** Confirm whether server.ts has a SIGTERM/close seam to
  hook `cotFeedService.stop()` into; if not, rely on process exit.
