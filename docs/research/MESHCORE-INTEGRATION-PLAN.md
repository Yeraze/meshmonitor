# MeshCore Multi-Source Integration Plan

**Date:** 2026-05-10  
**Branch:** `feature/meshcore-source`  
**Author:** Research subagent (Merlin)  
**Status:** Draft — awaiting Randall's approval before any code

---

## 1. Summary

MeshCore can be integrated as a first-class multi-source equal to MeshTastic. The shape of the work is: **refactor the existing v3.x singleton `MeshCoreManager` into a proper `ISourceManager`-implementing class**, migrate the two MeshCore DB tables to carry `sourceId`, retire the Python bridge in favor of the JS-native `@liamcottle/meshcore.js` library, and wire MeshCore nodes/messages/map into the existing source-scoped views.

Estimated size: ~4 medium-to-large PRs across 6–8 weeks of part-time work. The biggest technical risk is the **addressing mismatch**: MeshTastic uses 32-bit numeric `nodeNum` as primary key; MeshCore uses 64-hex-char Ed25519 public keys. The `nodes` table cannot store MeshCore contacts without a design decision about the identifier bridge. The biggest operational risk is the **Python bridge deprecation** — users who already run the v3.x MeshCore integration need a seamless migration path, not a hard cut.

---

## 2. MeshCore Protocol Overview

### 2.1 Wire Format

All transports share the same framing (from `src/connection/tcp_connection.js` in the meshcore.js library, confirmed by the existing bridge code):

```
[ frame_type: 1 byte ] [ frame_length: uint16 LE ] [ payload: N bytes ]
```

- Frame types: `0x3c` (`<`) = Outgoing (app→radio), `0x3e` (`>`) = Incoming (radio→app)
- Commands are single-byte command codes followed by typed arguments (see `constants.js`)
- Responses are identified by response/push codes — not a request/response ID scheme; events arrive asynchronously

### 2.2 Command/Response Codes

Key command codes (from `meshcore.js/src/constants.js`):

| Code | Name | Direction |
|------|------|-----------|
| 1 | AppStart | Outgoing — handshake, sent on connect |
| 2 | SendTxtMsg | Outgoing — DM to contact |
| 3 | SendChannelTxtMsg | Outgoing — broadcast to channel |
| 4 | GetContacts | Outgoing — request contact list |
| 5 | GetDeviceTime | Outgoing |
| 7 | SendSelfAdvert | Outgoing — announce presence |
| 9 | AddUpdateContact | Outgoing |
| 10 | SyncNextMessage | Outgoing — pull one buffered message |
| 11 | SetRadioParams | Outgoing |
| 17 | ExportContact | Outgoing |
| 22 | DeviceQuery | Outgoing — protocol version handshake |
| 31 | GetChannel | Outgoing |
| 32 | SetChannel | Outgoing |

Key response/push codes:

| Code | Name | Notes |
|------|------|-------|
| 3 | Contact | One entry in the contact list |
| 4 | EndOfContacts | Marks end of GetContacts stream |
| 5 | SelfInfo | Local node identity/radio info |
| 7 | ContactMsgRecv | Incoming DM |
| 8 | ChannelMsgRecv | Incoming channel broadcast |
| 9 | CurrTime | Device time response |
| 0x80 | Advert (push) | Spontaneous advert from a peer |
| 0x82 | SendConfirmed (push) | Delivery acknowledgment |
| 0x83 | MsgWaiting (push) | New messages available |
| 0x85 | LoginSuccess (push) | Repeater login ACK |
| 0x87 | StatusResponse (push) | Repeater status reply |

### 2.3 Transports

| Transport | Library Support | Server-Side? | Notes |
|-----------|----------------|--------------|-------|
| TCP/WiFi | `TCPConnection` in meshcore.js | ✅ Yes | Companion Radio WiFi firmware |
| Serial/USB | `NodeJSSerialConnection` in meshcore.js | ✅ Yes | Requires `serialport` npm pkg |
| BLE | `WebBleConnection` in meshcore.js | ❌ Browser-only | WebBluetooth API; not available in Node |
| WebSerial | `WebSerialConnection` in meshcore.js | ❌ Browser-only | Same constraint |

**Practical implication for v1:** Server-side support means **TCP and Serial only**. BLE requires either a browser relay or a native BLE addon (e.g., `@abandonware/noble`), which is a larger lift. Meshtastic today only supports TCP in MeshMonitor, so TCP-first for MeshCore is a fair parity target. Serial is bonus.

### 2.4 Addressing

MeshCore uses **Ed25519 public keys** (32 bytes = 64 hex chars) as node identifiers. There are no numeric node IDs. This is a fundamental difference from MeshTastic's 32-bit `nodeNum`.

Consequences:
- The existing `nodes` table (PK: `(nodeNum, sourceId)` since migration 029) cannot store MeshCore contacts without modification
- MeshCore contacts live in separate `meshcore_nodes`/`meshcore_messages` tables, which is actually fine — the question is whether we keep them separate or unify them with the main nodes table

### 2.5 Firmware Types

| Type | Protocol | Connection | Capabilities |
|------|----------|------------|-------------|
| Companion Radio | Binary (meshcore.js protocol) | TCP or Serial | Full: contacts, messages, channels, advert, position, radio config |
| Repeater | Text CLI (line-based commands) | Serial only | Relay only: login, status, neighbor query, traceroute |
| Room Server | Text-based BBS | Via Companion relay | Channel hosting, message store |

The existing `meshcoreManager.ts` handles both Companion (via Python bridge) and Repeater (via direct serial). The Python bridge wraps the meshcore_py library. The JS approach would use `@liamcottle/meshcore.js` for Companion and direct serial readline for Repeater (the existing Repeater serial code can mostly be kept).

### 2.6 Encryption

MeshCore messages use **NaCl box encryption** keyed by Ed25519 public keys (with X25519 conversion). Channel messages use shared symmetric keys. The `meshcore-decoder` library (`@michaelhart/meshcore-decoder`) can decode and verify raw LoRa-level packets including encrypted payloads — relevant for a future MQTT integration but **not needed for the Companion-connection path**, which delivers already-decrypted messages over the binary protocol.

---

## 3. Prior Integration Archaeology

### 3.1 What Was Built

MeshCore support was introduced in **v3.5.0** via **PR #1777** (commit `03bd03b0 feat: Add MeshCore protocol support`). It was **not removed** — it is still present today but was left as a v3.x-style singleton when MeshMonitor 4.0 introduced multi-source architecture.

The v3.x integration included:
- `src/server/meshcoreManager.ts` (1029 lines): singleton `MeshCoreManager extends EventEmitter`, NOT `ISourceManager`
  - Companion firmware: delegates to `scripts/meshcore-bridge.py` (Python, 16K lines) which wraps `meshcore_py`
  - Repeater firmware: direct serial using the `serialport` npm package
  - Exports a singleton `meshcoreManager` default export
- `src/server/routes/meshcoreRoutes.ts` (16.8K): routes mounted at `/api/meshcore/*`, completely separate from source-scoped routes
- `src/db/schema/meshcoreNodes.ts`: Drizzle schema for `meshcore_nodes` table — **no `sourceId` column**
- `src/db/schema/meshcoreMessages.ts`: Drizzle schema for `meshcore_messages` table — **no `sourceId` column**
- `src/components/MeshCore/MeshCoreTab.tsx`: standalone UI tab, not integrated into source-scoped views
- Server mounts MeshCore via `server.ts:853 apiRouter.use('/meshcore', meshcoreRoutes)` and auto-connects from env vars at startup (`MESHCORE_ENABLED`, `MESHCORE_PORT`, `MESHCORE_TCP_HOST` etc.)
- The `sources` table accepts type `meshcore` (line 14 of `src/db/repositories/sources.ts`: `'meshtastic_tcp' | 'mqtt' | 'meshcore'`) but creating a `meshcore` source via `POST /api/sources` does NOT instantiate a manager — the source row is an inert DB record

### 3.2 Key Commits

| Commit | Message | Significance |
|--------|---------|--------------|
| `03bd03b0` | `feat: Add MeshCore protocol support (#1777)` | Initial addition in v3.5.0 |
| `45c42563` | `chore: bump version to 3.5.0 and add MeshCore news article` | Release marker |
| `888256b7` / `0f7cacc5` | `fix: hide MeshCore sidebar when MESHCORE_ENABLED is not set` | Env-var gating |
| `6297c672` | `Merge PR from dpaschal/fix/meshcore-companion-conn...` | Community fix |
| `15f62a81` | `fix: use apprise venv python for MeshCore bridge and scripts` | Python bridge pain |
| `7836bf6a` | `fix: MeshCore repeater serial protocol — three bugs preventing connection` | Repeater was buggy |
| `08057e8a` | `fix: enable receiving incoming messages on MeshCore companion devices` | RX was broken at launch |
| `82fd97b5` | `fix: auto-connect MeshCore on startup and update documentation (MM-31)` | Latest 3.x-era fix |
| `916b915b` | `feat(4.0): Multi-Source Architecture — MeshMonitor 4.0.0-alpha (#2611)` | Meshtastic migrated; MeshCore was NOT |
| `c906fb65` | `refactor: eliminate branching in MeshCoreRepository via active schema` | Post-4.0 cleanup but still singleton |

### 3.3 Why It Was Not Migrated

The 4.0 multi-source PR migrated ~140 files but explicitly left MeshCore out. Based on commit structure and comments, MeshCore was left as a singleton because:

1. The addressing model (public key vs nodeNum) made it non-trivial to fold into the shared nodes table
2. The Python bridge dependency made the manager non-trivial to refactor
3. The team focused on MeshTastic → MQTT source multiplicity first as a more immediately impactful use case

### 3.4 Lessons Learned From v3.x Integration

- Python bridge is an operational burden (`requirements.txt`, venv path issues — see `15f62a81`)
- Repeater protocol had multiple bugs at launch; needs careful test coverage
- The Companion binary protocol needs a full roundtrip test before assuming messages actually arrive
- The `hasAdminAccess` / `adminPassword` design intentionally does NOT store passwords in the DB (correct — don't change this)
- BLE was considered but deemed too complex for v1 (same conclusion now)

---

## 4. Source Abstraction in MeshMonitor Today

### 4.1 The `ISourceManager` Interface

Defined in `src/server/sourceManagerRegistry.ts:20`:

```typescript
export interface ISourceManager {
  readonly sourceId: string;
  readonly sourceType: Source['type'];
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): SourceStatus;
  getLocalNodeInfo(): {
    nodeNum: number;
    nodeId: string;
    longName: string;
    shortName: string;
    hwModel?: number;
    firmwareVersion?: string;
    rebootCount?: number;
    isLocked?: boolean;
  } | null;
}
```

**MeshCore challenge with `getLocalNodeInfo()`:** it returns `nodeNum: number`. MeshCore has no numeric nodeNum. Options:
- Return a synthetic nodeNum (e.g., CRC32 of the public key, or 0)
- Extend the interface with an optional `getLocalMeshCoreInfo()` method
- Return the first 8 bytes of the public key as a uint32 (lossy but consistent)

### 4.2 `SourceManagerRegistry`

- `addManager(manager)`: calls `manager.start()` after registration
- `removeManager(sourceId)`: calls `manager.stop()` before deregistration
- `getAllManagers()`: returns all active managers
- `getAllStatuses()`: used by API to report per-source connection state

### 4.3 How MeshtasticManager Fits In

`class MeshtasticManager implements ISourceManager`:
- Constructor: `new MeshtasticManager(sourceId: string, config: MeshtasticConfig)`
- `start()`: initializes transport, begins polling
- `stop()`: tears down transport, flushes state
- Internally stores `this.sourceId` and scopes all DB writes with it

### 4.4 Server Startup Pattern

In `server.ts` around line 471–483: the server queries all `enabled` sources, then for each one:
```typescript
const manager = new MeshtasticManager(source.id, { nodeIp: ..., tcpPort: ... });
await sourceManagerRegistry.addManager(manager);
```

A new `meshcore` source type needs the same pattern: detect type `meshcore`, instantiate `MeshCoreSourceManager(source.id, config)`, call `addManager`.

### 4.5 DB Schema Implications

MeshCore will need to evolve its data model. The two current approaches:

**Option A — Keep separate meshcore tables, add sourceId:**
- Migration 056: `ALTER TABLE meshcore_nodes ADD COLUMN sourceId TEXT`
- Migration 056: `ALTER TABLE meshcore_messages ADD COLUMN sourceId TEXT`
- Change PK from `publicKey` to `(publicKey, sourceId)` — allows same node visible from multiple sources
- Pro: Clean separation, no confusion with meshtastic nodes
- Con: Source-scoped views need separate code paths to query meshcore vs meshtastic data

**Option B — Merge contacts into the main nodes table:**
- Add MeshCore-specific columns (publicKey, advType) to the shared nodes table
- Use a synthetic nodeNum for MeshCore contacts
- Pro: Unified queries in source-scoped views (map, monitor, nodes list)
- Con: Significant schema change; the `nodeNum` assumption is baked deep in server.ts (500+ references)

**Recommendation: Option A** for v1. The tables stay separate. Source-scoped routes that currently serve meshtastic data will need parallel endpoints for MeshCore, OR the frontend is taught to call two different data sources per sourceId. This is more isolated and lower risk.

### 4.6 Per-Source Permissions

The permission system already scopes `sources`, `nodes`, `messages`, etc. by `sourceId`. A new `meshcore` source will get permissions rows automatically from the existing grants-on-source-create logic (`src/server/routes/sourceRoutes.ts`). No changes needed to the permission model.

---

## 5. Local Sibling Repos

### 5.1 `meshcore.js` (`/home/yeraze/.openclaw/workspace/meshcore.js/`)

**Package:** `@liamcottle/meshcore.js` v1.13.0, MIT license  
**Source:** https://github.com/liamcottle/meshcore.js  

This is the primary client library candidate. It implements the full Companion binary protocol in pure JavaScript with no native dependencies except `serialport` (for serial transport, already used in MeshMonitor). Key files:

- `src/connection/connection.js` (88.5K): base class with all command/response logic
- `src/connection/tcp_connection.js`: TCP/WiFi transport
- `src/connection/nodejs_serial_connection.js`: NodeJS serial transport
- `src/constants.js`: all protocol constants (command codes, response codes, BLE UUIDs)
- `src/packet.js`: packet framing
- `src/advert.js`: Advert payload parsing with Ed25519 verification via `@noble/curves`

**Verdict:** ✅ Reuse directly. Install `@liamcottle/meshcore.js` from npm (v1.13.0+ is stable). Drop the Python bridge entirely for Companion devices. The library handles framing, handshake, contact sync, message rx/tx, and radio params — everything MeshMonitor needs.

**License:** MIT — compatible with MeshMonitor (check if MeshMonitor has a license requirement; if MIT or Apache, this is fine).

### 5.2 `meshcore-cli` (`/home/yeraze/.openclaw/workspace/meshcore-cli/`)

**Language:** Python (uses `meshcore_py`)  
**Source:** https://github.com/meshcore-dev/meshcore-cli  

This is the Python CLI tool, **not directly usable** for server-side Node.js integration. It's useful as a reference for the Repeater text-CLI protocol and as a diagnostic tool for development. The `REPEATER_COMMANDS.md` (11.7K) is a good reference for what repeater commands look like and what responses to expect.

**Verdict:** 📖 Reference only. Not imported as a dependency.

### 5.3 `meshcore-decoder` (`/home/yeraze/.openclaw/workspace/meshcore-decoder/`)

**Package:** `@michaelhart/meshcore-decoder`, TypeScript, MIT  
**Source:** https://github.com/michael-hart/meshcore-decoder (presumed)  

Decodes **raw LoRa-level MeshCore packets** (bytes off the air). Handles: Advert, GroupText, TextMessage, Trace payloads with Ed25519 signature verification and AES channel key decryption.

This is NOT the same as the Companion binary protocol in meshcore.js — it operates at the radio packet layer. It would be useful for:
- An **MQTT/radio-tap integration** (receiving raw LoRa packets from a gateway)
- A **packet log analyzer** feature

For v1 Companion-connection integration, this library is **out of scope** but noted as a potential tool for a future "receive raw air traffic" feature.

**Verdict:** 📦 Not needed for v1. Useful for future MQTT/raw packet ingestion.

### 5.4 `meshcore-ha` (`/home/yeraze/.openclaw/workspace/meshcore-ha/`)

**Language:** Python (Home Assistant custom component)  
**Source:** https://github.com/meshcore-dev/meshcore-ha  

The Home Assistant integration for MeshCore. Uses `meshcore_py` via Python. Supports USB, BLE, TCP. Has MQTT upload capability (for map.meshcore.io). Not directly usable in a Node.js project.

**Useful as reference for:**
- Data model: what sensors/entities HA exposes (telemetry, position, battery, node identity)
- MQTT publish format for map.meshcore.io integration
- BLE connection flow (though HA uses a Python BLE stack)

**Verdict:** 📖 Reference only.

---

## 6. Proposed Implementation Plan

### Phase 1 (S) — Foundation: `MeshCoreSourceManager` class (PR #1)

**Goal:** A working `ISourceManager` implementation for MeshCore Companion (TCP + Serial) that can be registered in the `SourceManagerRegistry` and connects to a device, receiving adverts and contact lists.

**Key work:**
1. Add `@liamcottle/meshcore.js` to `package.json` (already available as npm pkg)
2. Create `src/server/meshcoreSourceManager.ts`:
   - `class MeshCoreSourceManager implements ISourceManager`
   - Constructor: `(sourceId: string, config: MeshCoreSourceConfig)`
   - `config`: `{ connectionType: 'tcp' | 'serial', host?: string, port?: number, serialPort?: string, baudRate?: number }`
   - `start()`: create `TCPConnection` or `NodeJSSerialConnection`, call `connection.connect()`, set up event handlers
   - `stop()`: call `connection.close()`
   - `getStatus()`: return connected state, local node identity
   - `getLocalNodeInfo()`: return local node info with synthetic `nodeNum` (e.g., 0 or first 4 bytes of pubkey as uint32)
3. Wire into `server.ts` startup: when iterating sources, detect type `meshcore` → `new MeshCoreSourceManager(...)`
4. Write unit tests (mock connection)

**Does NOT include:** data persistence, routes, frontend. Just a connectable manager.

**Estimate:** M (1–2 weeks)

---

### Phase 2 (M) — Schema + Data: MeshCore tables gain `sourceId` (PR #2)

**Goal:** MeshCore DB tables are source-scoped so that multiple MeshCore sources can coexist without data collision.

**Key work:**
1. Migration 056: add `sourceId TEXT NOT NULL DEFAULT 'default'` to `meshcore_nodes` (SQLite, PG, MySQL)
2. Migration 056: add `sourceId TEXT NOT NULL DEFAULT 'default'` to `meshcore_messages`
3. Migration 056: migrate existing rows to the `sourceId` of the one legacy meshcore source (or `'default'` if none)
4. Change `meshcoreNodes` PK from `publicKey` to `(publicKey, sourceId)` — allows the same device seen from two MeshCore sources
5. Update Drizzle schema files (`src/db/schema/meshcoreNodes.ts`, `meshcoreMessages.ts`)
6. Update the MeshCore repository classes to scope all reads/writes by `sourceId`
7. Update `MeshCoreSourceManager.start()` to persist contact/message data with its `sourceId`
8. Decide on Option A vs B (separate tables is Option A — recommended; proceed with it)

**Estimate:** M (1–2 weeks, mostly migration boilerplate)

---

### Phase 3 (M) — API: Source-scoped routes for MeshCore (PR #3)

**Goal:** MeshCore data is accessible via source-scoped API endpoints, similar to how Meshtastic data is served.

**Key work:**
1. Add a MeshCore-specific route module that mounts under `/api/sources/:sourceId/meshcore/`:
   - `GET /api/sources/:sourceId/meshcore/contacts` — replaces `/api/meshcore/contacts`
   - `POST /api/sources/:sourceId/meshcore/messages` — send DM
   - `POST /api/sources/:sourceId/meshcore/channel-messages` — send channel broadcast
   - `GET /api/sources/:sourceId/meshcore/status` — connection state
   - `POST /api/sources/:sourceId/meshcore/connect` / `disconnect`
   - `POST /api/sources/:sourceId/meshcore/admin/*` — admin commands (gated by `meshcore:admin` permission)
2. Wire into `sourceRoutes.ts` or a new `meshcoreSourceRoutes.ts`
3. Add per-source permission check on all endpoints
4. Retire `/api/meshcore/*` (keep with deprecation header for one release cycle)
5. Keep `sourceRoutes.ts:GET /:sourceId/nodes` working for Meshtastic — MeshCore uses contacts endpoint

**Note:** MeshCore contacts don't map directly to Meshtastic nodes. We serve them from a separate endpoint rather than trying to merge them into `/nodes`.

**Estimate:** M (1–2 weeks)

---

### Phase 4 (L) — Frontend: Source-scoped MeshCore UI (PR #4)

**Goal:** MeshCore sources appear on the Dashboard and can be configured/monitored via the same UI patterns as MeshTastic sources.

**Key work:**
1. Source creation form (`DashboardSidebar` or `DashboardPage`): add `meshcore` as a selectable type with TCP/Serial config fields
2. Source-scoped MeshCore contacts view (replaces standalone `MeshCoreTab`): list of contacts with signal info, last heard, device type badge
3. Map integration: MeshCore contacts with known positions render as map markers in the per-source map view
4. Messaging: DM and channel message UI, wired to new source-scoped endpoints
5. Dashboard card: MeshCore source shows contact count, connection status
6. Remove/deprecate standalone `MeshCoreTab` and sidebar toggle
7. i18n strings for new MeshCore-specific labels

**Estimate:** L (2–3 weeks, mostly frontend work with no clear precedent)

---

### Phase 5 (S, optional) — Repeater support (PR #5)

**Goal:** Repeater firmware (text-CLI serial protocol) works under the new source architecture.

**Key work:**
1. In `MeshCoreSourceManager`, detect firmware type at connect time (Companion vs Repeater via initial handshake or config)
2. For Repeater: use direct serial readline mode with the existing Repeater command set
3. Surface Repeater-specific commands via the admin API
4. Repeater test coverage (the v3.x Repeater had 3 bugs at launch — see `7836bf6a`)

**Estimate:** S–M (1 week if Repeater protocol is fully understood)

---

## 7. Open Questions for Randall

1. **Addressing strategy:** MeshCore contacts are keyed by 64-char hex public keys, not uint32 nodeNums. The plan above keeps them in separate `meshcore_nodes`/`meshcore_messages` tables (Option A). Is that acceptable long-term, or do you want a unified node view across MeshTastic and MeshCore sources on the same map/monitor page?

2. **Python bridge fate:** The existing v3.x integration uses `scripts/meshcore-bridge.py`. If we switch to `@liamcottle/meshcore.js`, users who have the env-var-based MeshCore running need a migration story. Do you want a single-release deprecation period where both paths work, or a hard cut?

3. **Repeater priority:** The plan puts Repeater in Phase 5 (optional). Is serial Repeater support a blocker for v1 for your use case, or is TCP Companion enough to ship?

4. **BLE scope:** Server-side BLE in Node.js requires `@abandonware/noble` (abandoned, unreliable on Linux) or a USB-BLE bridge approach. The plan excludes BLE from v1. Is that acceptable, or is BLE to MeshCore a common user setup that must be supported?

5. **Source count:** Can a user add multiple MeshCore sources (e.g., two companion radios via TCP)? The architecture supports it with Phase 2's `(publicKey, sourceId)` PK change, but we need to decide if the same contact appearing on two sources should be merged in any views.

6. **`meshcore` source type in DB today:** There are already `sources` rows with `type='meshcore'` created by the existing UI (from the incomplete 4.0 integration). These rows have no live manager. Should migration 056 convert these to the new managed format, or should we start fresh?

7. **`getLocalNodeInfo()` and nodeNum:** The `ISourceManager` interface returns `{ nodeNum: number, nodeId: string, ... }`. For MeshCore, what synthetic `nodeNum` value is acceptable? Options: always 0, first 4 bytes of pubkey interpreted as uint32, or extend `ISourceManager` with an optional override.

---

## 8. Out of Scope (v1)

- **BLE transport**: browser-only WebBluetooth; would need `@abandonware/noble` or a hardware BLE bridge for server-side — deferred
- **MQTT/raw LoRa packet ingestion**: using `meshcore-decoder` to receive raw air traffic via MQTT gateway — not part of Companion connection story
- **Telemetry parity**: MeshTastic has rich device/environment/position telemetry stored in dedicated tables. MeshCore telemetry (battery, uptime, RSSI, SNR) is simpler; we persist what we get, but no dedicated telemetry table for MeshCore in v1
- **Room Server** support: Room Servers communicate via a different protocol through a Companion relay. Deferring until Companion integration is stable
- **Virtual Node equivalent**: MeshTastic has a "Virtual Node" feature that creates a software Meshtastic node. MeshCore has no equivalent concept; out of scope
- **map.meshcore.io uploader**: The `meshcore-ha` project uploads repeater/room server adverts to the public map. Useful feature but separate from the source integration; deferred
- **Firmware OTA update**: MeshTastic supports OTA firmware updates via MeshMonitor. MeshCore does not expose this via the Companion protocol (as of meshcore.js 1.13.0)
- **Meshtastic ↔ MeshCore bridging**: protocol bridge between the two networks is a separate product capability
