# Reticulum Source — Feature Survey & Design Proposal

**Issue:** [#3960 [FEAT] Reticulum Source](https://github.com/Yeraze/meshmonitor/issues/3960)
**Supersedes:** `RETICULUM_SOURCE_RESEARCH.md` (2026-07-06) — see §0 for what changed
**Date:** 2026-08-04
**Status:** Design proposal. No implementation yet.

---

## 0. What changed since the July research

Five findings move the needle. Two make Reticulum a *better* fit than the July doc concluded;
three change the recommended architecture.

| # | Finding | Effect |
|---|---|---|
| 1 | RNS ships a **rich stats API** — airtime, channel load, noise floor, interference, per-packet RSSI/SNR/quality, battery, bitrate, announce rates | The July doc's "interface throughput" is really a full telemetry feed. Feeds our existing Dashboard charts. |
| 2 | RNS has **native remote management** (`rnstransport.remote.management`, identity-ACL'd) | Real remote-node monitoring over the mesh, analogous to MeshCore remote admin. Not previously identified. |
| 3 | Alternate stacks matured: **Reticulum-Go** (Apache-2.0, wire-compatible, ~90% feature parity) and **Reticulum-rs/Leviculum** (Rust, functionally complete) | Changes the sidecar language question — but Go has **no RNode driver**, so Python still owns the direct-LoRa case. |
| 4 | The Python RNS **license is not OSI-approved** — it forbids use in AI/ML training datasets and in systems that can harm people | MeshMonitor is BSD-3. Shipping RNS in our image is permitted but must be disclosed; it blocks distro packaging. |
| 5 | Mark Qvist has **stepped back from public engagement**; governance is diffusing to the community | Long-term protocol risk is lower than single-maintainer risk implies (many implementations), but upstream responsiveness is worse. |

Current versions: RNS **1.4.2** (2026-07-26), LXMF 0.9.x, Reticulum-Go v0.9.5.

---

## 1. Native feature surface

The user's question: *what can we monitor when wired directly to a Reticulum LoRa node,
without leaning on higher protocols?*

The honest answer has a hard boundary in it, so state it first.

### 1.1 The boundary

**RNS core alone** gives you the *network*: announces, paths, radio and interface stats,
link probes, remote instance management. It gives you **no messages, no positions, no
telemetry, no node names** — those concepts do not exist below the application layer.

**LXMF** is where user-facing data lives — messages, display names, attachments, and (by
Sideband's convention) telemetry and position. LXMF is a higher protocol, but it is *the*
universal one: Sideband, NomadNet, MeshChat/MeshChatX, and every bot framework speak it.
Treating LXMF as in-scope is equivalent to treating Meshtastic's `TEXT_MESSAGE_APP` portnum
as in-scope. Skipping it leaves a source with no messaging and an empty map.

So: **RNS core + LXMF (incl. the Sideband telemetry convention) = the design surface.**
NomadNet pages and LXST telephony stay out of scope.

### 1.2 Feature-by-feature against MeshMonitor

| MeshMonitor feature | Reticulum native support | Where it comes from |
|---|---|---|
| **Node list** | ✅ Announced destinations — hash, app name, aspects, display name, hops, last-seen, announce rate | `Transport.register_announce_handler` |
| **Node signal (RSSI/SNR)** | ✅ Per-packet RSSI, SNR, and a normalised quality `q` | `Reticulum.get_packet_rssi/snr/q` |
| **Node names** | ✅ via LXMF announce `app_data` (display name) | LXMF |
| **Direct messages** | ✅ Full — opportunistic, direct-over-link, and store-and-forward via propagation nodes; delivery proofs; signature validation | LXMF |
| **Message features** | ✅ Richer than Meshtastic: replies, quotes, reactions, threads, file/image/audio attachments, markdown/micron renderers, groups, tickets | `LXMF.FIELD_*` |
| **Channels / group chat** | ⚠️ No PSK-channel analog. `FIELD_GROUP` + symmetric group destinations exist but no broadcast-channel convention | — |
| **Position / map pins** | ✅ Sideband telemetry `SID_LOCATION`: lat, lon, altitude, speed, bearing, accuracy, timestamp | LXMF `FIELD_TELEMETRY` |
| **Telemetry graphs** | ✅ Large sensor set: battery, temperature, humidity, pressure, power in/out, CPU, RAM, NVM, tank/fuel, physical-link RSSI/SNR/q, RNS transport stats, LXMF propagation stats | Sideband `sense.py` |
| **Local-node telemetry** | ✅ Extensive and always available: airtime short/long, channel load short/long, noise floor, interference, bitrate, RX/TX bytes and speeds, battery, announce/path-request rates, held announces, peers, clients | `Reticulum.get_interface_stats` |
| **LoRa radio config** | ✅ Full parity for RNode: frequency, bandwidth, TX power, spreading factor, coding rate, short/long airtime limits, radio on/off | RNode KISS `CMD_FREQUENCY`/`BANDWIDTH`/`TXPOWER`/`SF`/`CR`/`ST_ALOCK`/`LT_ALOCK`/`RADIO_STATE` |
| **Device info** | ✅ Firmware version, MCU, platform, EEPROM/ROM, battery, chip temperature, CSMA and PHY params | RNode KISS `CMD_FW_VERSION`/`MCU`/`PLATFORM`/`STAT_BAT`/`STAT_TEMP`/`STAT_CSMA`/`STAT_PHYPRM` |
| **Traceroute** | ⚠️ Partial. Path table gives hop *count*, next hop, and interface. `rnprobe` gives round-trip proof. **No per-hop identity, no per-hop SNR** — the protocol deliberately hides the route | `Reticulum.get_path_table`, `Transport.next_hop*` |
| **Neighbor info** | ❌ No analog. Reticulum packets carry **no source address**; you only learn of peers who announce or message you | — |
| **Packet monitor** | ⚠️ Announces and own traffic only. There is no promiscuous decode feed — everything else is end-to-end encrypted to a destination you are not | — |
| **Remote node admin** | ✅ Genuine analog: `rnstransport.remote.management` destination with `/status` and `/path` requests, gated by an identity allowlist | `rnstatus`/`rnpath` remote mode |
| **Reachability check** | ✅ `rnprobe` — RTT, hops, and per-hop-free proof of reachability | RNS utility |
| **Store-and-forward** | ✅ Propagation nodes, with metadata (name, sync stratum, throttle, auth band, utilisation pressure) | `LXMF.PN_META_*` |
| **Key management** | ✅ Identities, ratchets, forward secrecy, ticket-based auth. No "key mismatch repair" problem — identity *is* the address | RNS Identity |

### 1.3 Verdict

A Reticulum source can fill roughly **75%** of MeshMonitor's existing surface: node list,
messaging, telemetry, map, radio configuration, device info, remote monitoring, and a
reduced topology view.

Three areas stay empty and their tabs should be hidden: **channels**, **neighbor-link
graph**, and **promiscuous packet monitor**. One area — **traceroute** — degrades to a
hop-count-and-next-hop view rather than a per-hop path.

That is a better fit than the July research implied, and materially better than "the map
stays empty."

---

## 2. Where the data comes from

Three distinct planes. The design uses all three.

1. **In-process RNS API** — announces, LXMF router, sending, radio driver. Python only
   (Go has no RNode driver). This is where the LoRa node actually gets driven.
2. **Shared-instance RPC** — `get_interface_stats`, `get_path_table`, `get_rate_table`,
   `get_packet_rssi/snr/q`, `get_link_count`. msgpack over `multiprocessing.connection`,
   on an abstract AF_UNIX socket by default, or `127.0.0.1:37429` when `use_af_unix = No`.
   Authenticated by `rpc_key` (config-settable). **Localhost only** — this constrains
   containerisation (§8).
3. **The mesh itself** — remote transport-node status, path lookups, probes, and LXMF
   traffic. Works over any distance; needs our identity on the remote's ACL.

---

## 3. Architecture: the bridge

MeshMonitor's backend cannot speak RNS natively and should not try.

### 3.1 Options considered

| Option | Verdict |
|---|---|
| `@liamcottle/rns.js` in-process | **No.** Dormant since Feb 2025, v0.0.4, self-described as incomplete, missing ratchets — breaks interop with every modern LXMF client. Adopting it means owning a crypto stack. |
| Go sidecar (Reticulum-Go, Apache-2.0) | **Not yet.** Excellent license and a single static binary, but **no RNode driver** — it cannot drive a directly-attached LoRa node, which is the requested case. Keep as a future swap. |
| Rust sidecar (Leviculum) | **Not yet.** Same RNode gap; earlier in its life. |
| Python sidecar (RNS + LXMF) | **Yes.** Owns the RNode driver, the LXMF router, and the reference behaviour. What MeshChat, Sideband, and NomadNet all do. |
| Wrap MeshChat/MeshChatX's API | **No.** Undocumented internal API, forked ecosystem, makes us a dashboard-for-MeshChat rather than a peer source. |

### 3.2 Recommendation

A **`meshmonitor-rns-bridge`** Python daemon speaking versioned JSON over a loopback
WebSocket, consumed by a Node `ReticulumManager` — the same shape as `MeshCoreManager`
consuming `meshcore.js`.

Define the bridge protocol as an explicit contract, not an internal detail. When
Reticulum-Go gains an RNode driver, a Go bridge drops in behind the same contract and the
Node side never changes.

### 3.3 Three connection modes

The `sources.config` blob carries `mode`. They differ in *what the bridge can see*, not
just where it runs.

| Mode | Setup | What it gets | What it misses |
|---|---|---|---|
| **`own`** | Bridge holds the interfaces itself, including `RNodeInterface` on `/dev/ttyUSB*` | Everything — announces, LXMF, paths, full local interface stats, **editable radio config**. This is *"connected directly to a Reticulum LoRa node"* | Nothing |
| **`tcp_peer`** | Bridge adds a `TCPClientInterface` pointing at `host:port` of someone else's `TCPServerInterface` | Announces, LXMF messaging, our own path table, stats for *our own* TCP interface. **No local radio needed** | That remote box's airtime / channel load / noise floor / RNode battery / radio config |
| **`attach`** | Bridge runs as a client of a local `rnsd` shared instance | Same as `tcp_peer`, plus that instance's full interface stats and path table over the RPC socket | Nothing, but the RPC is **localhost-only** (§8) |

`tcp_peer` is the low-friction default for anyone already running Reticulum somewhere: one
host and port, no device access, no host networking. It does require the far end to expose
a `TCPServerInterface` — that is a config change on their side, not a given.

### 3.4 Remote management — the fourth data path

Orthogonal to all three modes. Any RNS instance that sets `enable_remote_management = Yes`
and lists our identity hash in `remote_management_allowed` answers two requests over
Reticulum itself, from any distance:

- `/status` → the complete `get_interface_stats()` payload — every field in §1.2's
  local-telemetry row, including per-interface airtime, channel load, noise floor, RNode
  battery and bitrate.
- `/path` → that instance's path table.

Read-only, identity-gated, and it needs no IP address — it routes over the mesh. This is
what recovers the "what I miss in `tcp_peer` mode" column above, and it turns MeshMonitor
into a **fleet monitor for remote Reticulum nodes**. The most differentiated feature in
this proposal.

Radio *configuration* stays local-only: remote management is read-only, so changing SF or
frequency requires `own` mode.

All modes present the same API upward. The UI hides editable radio config outside `own`
mode, the same way MeshCore hides Meshtastic-only panels.

### 3.5 Bridge protocol sketch

```
bridge → MeshMonitor (events)
  announce            { destHash, identityHash, appName, aspects, displayName,
                        appData, hops, viaInterface, rssi, snr, q, ts }
  interface_stats     { interfaces: [...], traffic: {...}, transport: {...} }   # ~2s poll
  path_table          { paths: [{ destHash, via, hops, interface, expires }] }
  lxmf_message        { hash, from, to, title, content, fields, signature, method, ts }
  delivery_state      { hash, state, method, attempts }
  telemetry           { destHash, sensors: { location: {...}, battery: {...} } }
  rnode_stats         { interfaceHash, fwVersion, mcu, platform, temp, battery, phyParams }
  remote_status       { destHash, status, linkCount }
  probe_result        { destHash, rtt, hops, ok }
  log                 { level, message }

MeshMonitor → bridge (commands, request/response with an `id`)
  send_lxmf, announce_self, set_display_name, request_path, probe,
  sync_propagation, set_propagation_node, set_rnode_config, get_remote_status,
  list_interfaces, set_interface_config, get_identity, import_identity
```

Auth: a shared token from an env var, bound to loopback. Version the protocol with a
`protocol_version` field checked on connect (MeshCore's handshake precedent).

---

## 4. Reuse map

This is the core of the proposal. Almost nothing needs inventing.

| Existing infrastructure | Reticulum reuse | Change needed |
|---|---|---|
| `ISourceManager` (`sourceManagerRegistry.ts`) | `ReticulumManager` implements it verbatim — 8 members | New class |
| `sourceManagerRegistry` (single unified registry) | Register alongside Meshtastic/MeshCore managers | None |
| `sourceManagerTypes.ts` type guards | Add `isReticulumManager(m)` | +1 predicate |
| `Source['type']` union (`sources.ts:14`) | Add `'reticulum'` | +1 literal; `config` is opaque JSON, **no sources-table migration** |
| `bootstrapSources.ts` | Add a `reticulum` branch to the boot loop | ~1 branch |
| `sourceRoutes.ts` lifecycle | create / enable / disable / config-change / connect / disconnect / delete | ~9 branches, mirroring the meshcore ones |
| Response envelope `ok()` / `fail()` | All new handlers | Mandatory, free |
| `requirePermission(..., { sourceIdFrom: 'params.id' })` | Every route | Free |
| `createRouteTestApp()` harness | All route tests | Free |
| Generic `telemetry` table | Sensor readings **and** interface stats as `telemetryType` strings with `nodeId` = dest hash; `nodeNum: 0` (MeshCore already does exactly this) | No schema change |
| `Dashboard` + `dataSources.ts` | `reticulumDashboardSource` adapter → favorite charts, graphs, retention all work | ~1 adapter (~40 LOC) |
| `BaseMap` + `NodeMarkersLayer` + `MapLegend` + `GeoJsonOverlay` + `MeasureDistanceController` | `ReticulumMap` composes them, exactly as `MeshCoreMap` does | ~1 component |
| `map/popups/NodeCard` + `sections` | Add a `ReticulumDetails` section beside `MeshCoreDetails` | +1 section |
| `MeshCoreSubToolbar` pattern | `ReticulumSubToolbar` with its own view union | ~1 component |
| `SaveBarProvider` / `SaveBar` | Configuration and settings views | Free |
| `styles/settings.css`, CSS modules | Per-component modules (`ReticulumX.module.css`) | Per project rule |
| `UiIcon` / `BrandIcon` | All icons | Free |
| `main.tsx` `SourceApp` dispatch | Third branch → `<ReticulumSourcePage>` | +1 branch |
| `DashboardPage` add/edit modal | `formType === 'reticulum'` fieldset | +1 fieldset |
| `SourceContext` / `useSource()` | Unchanged | Free |
| `CliConsoleBody` (shared console primitive) | Bridge log console + `rnprobe`/`rnpath` output | Free |
| Automation engine | Reticulum events onto `dataEventEmitter`; **watch the self-origin guard** (own sends re-enter the bus) | Small |
| Notifications, `SearchModal`, `DashboardSidebar`, `nodeTypeCategory` | Small per-type conditionals | ~8 files, 1 line each |
| Packet-log services | **Skipped** — no promiscuous feed to log | — |

Roughly **26 shared files** carry a one-line `'meshcore'` branch today; Reticulum adds a
comparable set. That diffuse cost is real but well-trodden.

---

## 5. Data model

Four new tables, all `sourceId`-scoped, following the `meshcore_*` precedent (keyed by an
opaque identity string rather than an integer `nodeNum`).

### `reticulum_destinations` — the Nodes-list analog
```
sourceId, destinationHash (32 hex chars), identityHash, appName, aspects,
displayName, iconAppearance, hops, viaInterfaceName,
rssi, snr, quality,
latitude, longitude, altitude, speed, bearing, accuracy, positionUpdatedAt,
isPropagationNode, isTransportNode, stampCost,
firstSeen, lastHeard, lastAnnounceAt, announceRate,
isFavorite, isLocalIdentity,
createdAt, updatedAt
PRIMARY KEY (sourceId, destinationHash)
```

### `reticulum_messages` — LXMF
```
id (= `${sourceId}_${lxmHashHex}`), sourceId,
fromHash, toHash, title, content,
timestamp, receivedAt,
state (draft|outbound|sending|sent|delivered|failed),
method (opportunistic|direct|propagated),
signatureValidated, ratcheted,
fields (JSON: attachments, reactions, thread, replyTo, renderer),
replyToHash, threadHash,
rssi, snr, quality,
createdAt
```
The LXMF message hash is globally unique, so the composite key is simpler than
Meshtastic's — but keep the `${sourceId}_` prefix so the cross-source dedup rule
(`feedback_message_row_id_format`) still holds.

### `reticulum_interfaces` — current state, one row per interface
```
sourceId, interfaceHash, shortName, name, type, mode, status, bitrate,
rxb, txb, rxs, txs,
airtimeShort, airtimeLong, channelLoadShort, channelLoadLong,
noiseFloor, interference, batteryPercent, batteryState,
clients, peers, announceQueue, heldAnnounces,
incomingAnnounceFreq, outgoingAnnounceFreq,
loraFreq, loraBandwidth, loraSf, loraCr, loraTxPower, stAlock, ltAlock,
fwVersion, mcu, platform, chipTemp,
updatedAt
PRIMARY KEY (sourceId, interfaceHash)
```
History goes to the **shared `telemetry` table** as `rns_airtime_short`,
`rns_channel_load_long`, `rns_noise_floor`, … with `nodeId = 'if:<interfaceHash>'`.
Charts then come free.

### `reticulum_paths` — topology
```
sourceId, destinationHash, viaHash, hops, interfaceName, expiresAt, updatedAt
PRIMARY KEY (sourceId, destinationHash)
```

**Migrations:** 4 new, numbered from **135**, via the `/migration` skill (SQLite +
PostgreSQL + MySQL, `settingsKey` required, idempotent helpers). No changes to `nodes`, so
the hand-written PG/MySQL DDL in `nodes.test.ts` is untouched.

---

## 6. Backend surface

```
src/server/
  reticulumManager.ts          ~1,400  ISourceManager, bridge client, event fan-out
  reticulumConfig.ts             ~150  config-from-source mapper + ensureStarted
  reticulumBridgeClient.ts       ~400  WS transport, reconnect, request/response
  services/
    reticulumTelemetryIngest.ts  ~300  Sideband sensor decode → telemetry rows
    reticulumInterfacePoller.ts  ~200  stats poll → reticulum_interfaces + telemetry
    reticulumRemoteStatus.ts     ~150  remote-management client
  routes/
    reticulumRoutes.ts            ~40  barrel
    reticulumStatusRoutes.ts     ~200  status/connect/disconnect/identity
    reticulumDestRoutes.ts       ~250  destinations, favorites, announce
    reticulumMessageRoutes.ts    ~350  LXMF send/list/threads/propagation sync
    reticulumInterfaceRoutes.ts  ~300  stats, RNode config get/set
    reticulumPathRoutes.ts       ~200  paths, probe, remote status
bridge/                          ~1,400 Python (own repo dir, shipped as a sidecar image)
```

Mounted at `/api/sources/:id/reticulum/*`, matching `/api/sources/:id/meshcore/*`.

---

## 7. Frontend surface

`src/pages/ReticulumSourcePage.tsx` → `src/components/Reticulum/ReticulumPage.tsx`,
mirroring `MeshCorePage.tsx` (222 LOC — the page itself is thin; the views carry the work).

```ts
export type ReticulumView =
  | 'destinations'   // Nodes analog — announced destinations
  | 'dms'            // LXMF conversations
  | 'map'            // BaseMap + NodeMarkersLayer from telemetry positions
  | 'telemetry'      // shared Dashboard + reticulumDashboardSource
  | 'interfaces'     // rnstatus-over-time; airtime/channel-load/noise charts
  | 'paths'          // path table, probe, remote transport status
  | 'info'           // local identity, RNode device info, bridge health
  | 'configuration'  // RNode LoRa params (mode: own only)
  | 'automations'
  | 'notifications'
  | 'settings';
```

Deliberately **absent**: `channels`, `packets`, `rooms`. Hiding a tab per source type is
already the established pattern.

Map story: positions arrive from `FIELD_TELEMETRY` → `SID_LOCATION`, so the map is
populated for any peer sharing telemetry with our identity (Sideband's default collector
model). Bearing and speed are in the payload, so heading arrows work. Neighbor links stay
off — there is no neighbor data. A light path-graph overlay (dest → next-hop, when both
have positions) is a Phase 4 nicety.

---

## 8. Deployment

### 8.1 How the bridge reaches an `rnsd` that owns the radio

This is the mechanic that makes `attach` mode cheap, so state it precisely.

**The bridge writes no IPC code.** It is an ordinary RNS application process. It calls
`RNS.Reticulum(configdir=...)`, which detects the already-running `rnsd`, fails to bind the
shared-instance socket, and falls back to `LocalClientInterface` — attaching as a client of
that instance (`Reticulum.py` `__start_local_interface`). From that point:

- **Network plane** — announces, LXMF, links, and outbound sends all ride the shared-instance
  socket into `rnsd` and out over its RNode. The bridge never touches `/dev/ttyUSB*`.
- **Stats plane** — `get_interface_stats()`, `get_path_table()`, `get_rate_table()`,
  `get_packet_rssi/snr/q()` each begin with `if self.is_connected_to_shared_instance:` and
  transparently proxy the call over the RPC socket to `rnsd`, returning **rnsd's** data.
  Free, by construction.
- **Identity** — a client instance keeps its *own* identities and destinations. MeshMonitor
  gets its own LXMF address, which is exactly what we want.

```
RNode (/dev/ttyUSB0)
   │  KISS serial
   ▼
rnsd  ── owns the radio, untouched by us ───────────────┐
   │  shared-instance socket (AF_UNIX abstract, or 127.0.0.1:37428)
   │  + control/RPC socket (AF_UNIX abstract, or 127.0.0.1:37429, msgpack + rpc_key)
   ▼
meshmonitor-rns-bridge  (Python: RNS client instance + LXMF router)
   │  WebSocket JSON, versioned, token-auth
   ▼
ReticulumManager (Node)  →  MeshMonitor
```

**Two hard requirements**, both from RNS internals rather than our design:

1. **Same host, same network namespace.** `LocalServerInterface` binds `127.0.0.1`
   (`LocalInterface.py:408`) or an abstract AF_UNIX socket — and abstract sockets are
   namespace-scoped. A bridged-network container cannot reach either. Use
   `network_mode: host` for the bridge container.
2. **Same `~/.reticulum` directory.** The RPC `authkey` defaults to
   `full_hash(Transport.internal_identity().get_private_key())`, derived from
   `<storagepath>/transport_identity`. A client can only compute it by reading the same
   storage dir — which is exactly why `rnstatus` needs no configuration. Mount the host's
   `~/.reticulum` into the bridge container, or have the user set an explicit `rpc_key` in
   their config.

Neither requirement needs device access, privileged mode, or any change to how `rnsd` runs.

### 8.1.1 Exactly what `attach` sees

The RPC proxy exports a fixed subset of each interface object, not the whole thing. The
difference matters for the Configuration tab.

**Available** (verified in `get_interface_stats()`, `Packet.get_rssi()`):

- Airtime short/long, channel load short/long, noise floor, interference (+ last dBm and
  timestamp), battery state and percent, bitrate, `rxb`/`txb`, RX/TX speeds, clients,
  peers, announce queue, held announces, incoming/outgoing announce and path-request
  frequencies, rate targets and penalties, status, mode, IFAC config, transport uptime, RSS.
- Path table, rate table, link count, blackholed identities.
- **Per-packet RSSI, SNR and quality** — `Packet.get_rssi()` returns the local value if set,
  otherwise calls `reticulum.get_packet_rssi(packet_hash)`, which proxies to `rnsd`
  (`Packet.py:355–373`). RNS added these accessors precisely so shared-instance clients keep
  physical-layer data.
- Announces, LXMF messaging, and Sideband telemetry from peers — these ride the network
  plane, unaffected.

**Not available** — held on the interface object but never placed in the RPC payload:

- LoRa parameters: `frequency`, `bandwidth`, `sf`, `cr`, `txpower`, `st_alock`, `lt_alock`.
- RNode device detail: chip temperature (`r_temperature`), instantaneous RSSI
  (`r_current_rssi`), symbol time/rate, preamble timing, CSMA parameters, firmware version,
  MCU, platform.

**Mitigation:** `attach` already mounts `~/.reticulum` for the RPC authkey, so parse the
`[[RNode]]` block of the user's config for frequency/bandwidth/SF/CR/TX power. RNS pushes
those to the radio at startup, so the configured values are the live values. That fills the
Configuration tab read-only. The live device stats (chip temp, CSMA, instantaneous RSSI)
need `own` mode — the driver has to be ours.

**One caveat:** a shared-instance client builds its own path table from forwarded announces,
so its hop counts can differ by one from `rnsd`'s. Treat the RPC path table as the
authority and ignore the local one.

### 8.2 Targets

1. **Docker Compose (primary)** — a second service, `meshmonitor-rns-bridge`, from its own
   small `python:3.12-alpine` image. **Do not** add Python to the `node:24-alpine` app
   image. Per mode: `tcp_peer` needs nothing special; `attach` needs
   `network_mode: host` + a `~/.reticulum` bind mount; `own` needs `/dev/ttyUSB*` and the
   `dialout` group instead.
2. **Helm** — an optional second container in the pod, gated by `reticulum.enabled` in
   `values.yaml`. `attach` mode implies `hostNetwork: true`.
3. **LXC template** — `python3` + `pip install rns lxmf` inside the chroot; add any new
   top-level directory to `lxc/sparse-cone.txt` in the same commit.
4. **Tauri desktop** — mark Reticulum sources unsupported in v1. Bundling a Python daemon
   into the desktop app is its own project.

One further constraint:
- **License disclosure.** Python RNS and LXMF carry the non-OSI Reticulum License
  (no-harm and no-AI-training-dataset clauses). Keeping it in a separate optional sidecar
  image keeps the main BSD-3 image clean, and the sidecar's `NOTICE` states it plainly.

---

## 9. Phasing

Each phase ships on its own.

| Phase | Scope | Est. LOC (incl. tests) |
|---|---|---|
| **1 — Attach & observe** | Python bridge (both modes), `ReticulumManager`, source type + lifecycle branches, `reticulum_destinations`, `reticulum_interfaces`, Destinations + Interfaces + Info views, interface telemetry into the shared Dashboard | ~7,500 |
| **2 — Messaging** | LXMF identity, send/receive, delivery proofs, propagation-node sync, threads/replies/reactions, `reticulum_messages`, DMs view, notifications, automation events | ~5,000 |
| **3 — Position & radio** | Sideband telemetry decode, map view, `ReticulumDetails` popup section, RNode configuration view (`own` mode), device info | ~4,000 |
| **4 — Topology & remote** | `reticulum_paths`, probe, remote transport-node status, path-graph overlay, fleet monitoring of remote instances | ~3,500 |

Realistically **2–3 weeks of focused work for Phase 1**, and a multi-month arc for all four
— MeshCore scale, as the July research said. Phase 1 is where you learn whether the bridge
approach holds up; do not commit past it before that.

---

## 10. Risks and open questions

1. **The sidecar is a new deployment shape for MeshMonitor.** Every install path grows a
   moving part. Phase 1 must prove the compose story before Phase 2 starts.
2. **Upstream responsiveness is now worse.** With Qvist stepped back, protocol questions
   route through community implementations. Mitigation: the bridge contract keeps us one
   swap away from Reticulum-Go.
3. **Telemetry and position are opt-in and peer-to-peer.** A user with no telemetry-sharing
   peers sees an empty map. Set that expectation in the UI, not just the docs.
4. **The Sideband telemetry format is a convention, not a spec.** It lives in one file of
   one app (`sense.py`). Pin the sensor IDs we decode and treat unknown SIDs as opaque.
5. **Test rig.** System tests need either a second RNS instance in CI or a loopback pair of
   bridges over a `TCPInterface`. The latter is cheap and hardware-free — unlike the
   MeshCore rig — so Reticulum can get real end-to-end CI coverage from Phase 1.

**Open questions for the issue thread:**
- Is demand there? One discussion upvote so far. Phase 1 is ~3 weeks.
- Do we require an existing `rnsd` (attach-only, much smaller Phase 1), or own the radio
  from the start? Owning it is what "connect a Reticulum LoRa node" means to most users.
- Does the desktop app need parity, and by when?

---

## 11. Evidence

All claims above trace to source, read 2026-08-04:

| Claim | Source |
|---|---|
| Interface stats fields | `RNS/Reticulum.py` `get_interface_stats()` L1359–1516 |
| Path table fields | `RNS/Reticulum.py` `get_path_table()` L1517–1536 |
| Per-packet RSSI/SNR/quality | `RNS/Reticulum.py` L1645–1690 |
| Shared-instance RPC transport | `RNS/Reticulum.py` L346–362, `get_rpc_client()` L1298 |
| Remote management + ACL | `RNS/Reticulum.py` L541–554, L1779–1790; `RNS/Utilities/rnstatus.py` `get_remote_status()` |
| RNode config + stat commands | `RNS/Interfaces/RNodeInterface.py` `class KISS`, `setFrequency`/`setBandwidth`/`setTXPower`/`setSpreadingFactor`/`setCodingRate` |
| Announce/path/probe API | `RNS/Transport.py` L2549–2880 |
| LXMF field set | `LXMF/LXMF.py` `FIELD_*`, `PN_META_*`, `RENDERER_*` |
| Sideband sensors | `Sideband/sbapp/sideband/sense.py` `class Sensor` SIDs, `Location.pack`, `PhysicalLink` |
| RNS license terms | `Reticulum/LICENSE` |
| Reticulum-Go parity + no RNode driver | `Quad4-Software/Reticulum-Go/COMPATIBILITY.md` |
| Governance / implementations | FOSDEM 2026 Reticulum community meetup; nodestar.net "Moving Reticulum Forward" |
| MeshMonitor seams | `sourceManagerRegistry.ts`, `sourceManagerTypes.ts`, `sources.ts:14`, `main.tsx:68–86`, `MeshCoreSubToolbar.tsx:8`, `Dashboard/dataSources.ts:131–146` |
