# Reticulum `attach` Mode — Phase 1 Implementation Spec

**Parent:** `RETICULUM_SOURCE_DESIGN.md` · **Issue:** #3960
**Scope:** Attach to a user's running `rnsd`, ingest announces + interface stats, render
Destinations / Interfaces / Info views. **No messaging, no map, no radio config** — those
are Phases 2–3.
**Date:** 2026-08-04

---

## 1. Why `attach` first

It is the only mode that needs no hardware, no `/dev` access, no privileged container, and
no RNode driver. It proves the whole bridge architecture against a real `rnsd`, and it is
the mode most users land in — they already run Reticulum somewhere.

It also removes the design's biggest dependency: if Phase 1 ships `attach` + `tcp_peer`
only, the Python bridge never touches a serial port, so swapping in a Reticulum-Go bridge
later stays viable.

**Non-goals for Phase 1:** LXMF messaging, telemetry decode, map, RNode configuration,
remote management, packet log.

---

## 2. Verified mechanics

Everything below was read from RNS 1.4.2 source on 2026-08-04. These four facts are what
make the design work; do not re-derive them.

| Fact | Consequence | Source |
|---|---|---|
| Client instances **skip** interface creation — `if self.is_shared_instance or self.is_standalone_instance:` guards the `[interfaces]` loop | Sharing the user's config dir is **safe**. We will not double-open `/dev/ttyUSB0` or disturb their `rnsd` | `Reticulum.py:717` |
| `RNS.Reticulum(..., require_shared_instance=True)` exists as a constructor parameter | Fail fast when `rnsd` is absent, instead of silently becoming a standalone instance with zero interfaces | `Reticulum.py:215`, `:403` |
| `rpc_key` defaults to `full_hash(Transport._identity.private_key)`, and `Transport._identity = Transport.identity`, loaded from `<storagepath>/transport_identity` | The bridge **must share the config dir**, or both sides must set an explicit `rpc_key` | `Reticulum.py:355`, `Transport.py:234` |
| Announce handlers may take `received_announce(destination_hash, announced_identity, app_data, announce_packet_hash)` | The packet hash is the key into `get_packet_rssi/snr/q()` — this is how we attach signal data to a node row | `Transport.py:2549` |

Socket paths and ports are fixed defaults (`37428`/`37429`, AF_UNIX path `"default"`), not
derived from the config dir — so an explicit-`rpc_key` deployment with separate config dirs
also works.

---

## 3. Prove it in 20 minutes first

Before any MeshMonitor code, run this against a real `rnsd`. If it prints stats, the entire
Phase 1 premise holds.

```python
# spike.py — run on the host where rnsd is already running
import RNS, time

r = RNS.Reticulum(configdir="/home/you/.reticulum", require_shared_instance=True)
print("attached:", r.is_connected_to_shared_instance)

class AnnounceLogger:
    aspect_filter = None                 # all aspects
    receive_path_responses = True
    def received_announce(self, destination_hash, announced_identity, app_data,
                          announce_packet_hash=None):
        print("announce", RNS.hexrep(destination_hash, delimit=False),
              "hops", RNS.Transport.hops_to(destination_hash),
              "rssi", r.get_packet_rssi(announce_packet_hash) if announce_packet_hash else None,
              "app_data", app_data)

RNS.Transport.register_announce_handler(AnnounceLogger())

while True:
    s = r.get_interface_stats()
    for i in s["interfaces"]:
        print(i["short_name"], i["type"], "airtime", i.get("airtime_short"),
              "chload", i.get("channel_load_short"), "nf", i.get("noise_floor"))
    time.sleep(5)
```

**Gate:** this must work before WP1 starts. Budget half a day including installing `rnsd`.

---

## 4. The bridge

### 4.1 Layout

```
bridge/                              # own directory, own image, not in the Node build
  meshmonitor_rns_bridge/
    __init__.py
    __main__.py          ~120   arg/env parsing, lifecycle, signal handling
    instance.py          ~180   RNS.Reticulum attach, health, reconnect-on-rnsd-restart
    announces.py         ~120   announce handler → normalised event dicts
    stats.py             ~160   interface-stats + path-table pollers
    wsserver.py          ~220   threaded WebSocket server, token auth, fan-out
    protocol.py          ~140   event/command schemas, version constant
  pyproject.toml                 deps: rns, websockets   (LXMF added in Phase 2)
  Dockerfile                     python:3.12-alpine
  README.md
```

~940 LOC for Phase 1. `lxmf` is deliberately not a dependency yet.

### 4.2 Threading model

RNS is thread-based, not asyncio. Use `websockets.sync.server` (threaded, stdlib-style) and
skip the asyncio bridge entirely. Announce callbacks fire on RNS threads and push onto a
`queue.Queue`; a single fan-out thread drains it to all connected WebSocket clients. Pollers
are plain `threading.Thread` loops.

No asyncio anywhere. This is the single biggest simplification available and it matches how
`rnstatus` and NomadNet are written.

### 4.3 Configuration

Environment only — no config file of our own.

| Var | Default | Meaning |
|---|---|---|
| `MM_RNS_MODE` | `attach` | `attach` \| `tcp_peer` (Phase 1 ships both) |
| `MM_RNS_CONFIGDIR` | `/rns` | The user's `~/.reticulum`, bind-mounted |
| `MM_RNS_BIND` | `127.0.0.1:8765` | WebSocket listen address |
| `MM_RNS_TOKEN` | *(required)* | Shared secret; rejected connection without it |
| `MM_RNS_STATS_INTERVAL` | `2` | Interface-stats poll, seconds |
| `MM_RNS_PATHS_INTERVAL` | `30` | Path-table poll, seconds |
| `MM_RNS_LOGLEVEL` | `info` | Maps onto `RNS.loglevel` |

### 4.4 Startup and failure modes

```python
r = RNS.Reticulum(configdir=cfg, require_shared_instance=(mode == "attach"))
```

| Failure | Bridge behaviour | Surfaced as |
|---|---|---|
| `rnsd` not running | Constructor raises | `status: 'error', code: 'NO_SHARED_INSTANCE'`; retry every 10 s |
| Config dir unreadable / wrong owner | Constructor raises | `code: 'CONFIGDIR_UNREADABLE'` |
| RPC auth failure (`rpc_key` mismatch) | First `get_interface_stats()` raises | `code: 'RPC_AUTH_FAILED'` — the single most likely user misconfiguration; the message must name the `rpc_key` fix |
| `rnsd` restarts underneath us | Socket drops; RNS marks the local interface down | Bridge tears down its instance and re-attaches from scratch. **Do not** try to keep the instance alive across an `rnsd` restart |
| WebSocket client disconnects | Keep the RNS instance up, keep buffering nothing | Node reconnects with backoff |

The bridge is stateless beyond its RNS instance. Restarting it is always safe.

### 4.5 Wire protocol (Phase 1 subset)

Version constant `PROTOCOL_VERSION = 1`, checked on connect. Mismatch closes with a clear
reason rather than degrading.

```jsonc
// server → client
{"t":"hello","protocol_version":1,"mode":"attach","rns_version":"1.4.2",
 "attached":true,"transport_id":"<hex>","shared_instance":true}

{"t":"announce","dest_hash":"<32hex>","identity_hash":"<32hex>",
 "app_name":"lxmf","aspects":["delivery"],"display_name":"Alice",
 "app_data_b64":"...","hops":2,"is_path_response":false,
 "rssi":-97,"snr":6.5,"q":48,"ts":1754320000.12}

{"t":"interface_stats","ts":...,"traffic":{"rxb":...,"txb":...,"rxs":...,"txs":...},
 "transport":{"transport_id":"<hex>","uptime":12345,"rss":48210000},
 "interfaces":[{"hash":"<hex>","short_name":"RNode","name":"RNodeInterface[...]",
   "type":"RNodeInterface","status":true,"mode":1,"bitrate":1200,
   "rxb":...,"txb":...,"rxs":...,"txs":...,
   "airtime_short":0.02,"airtime_long":0.01,
   "channel_load_short":0.11,"channel_load_long":0.08,
   "noise_floor":-105,"interference":null,
   "battery_state":"discharging","battery_percent":87,
   "clients":null,"peers":null,"announce_queue":0,"held_announces":0,
   "incoming_announce_frequency":0.004,"outgoing_announce_frequency":0.0}]}

{"t":"path_table","ts":...,"paths":[{"dest_hash":"<hex>","via":"<hex>",
   "hops":2,"interface":"RNodeInterface[...]","expires":1754400000}]}

{"t":"status","state":"attached|degraded|error","code":"...","message":"..."}

// client → server  (request/response, correlated by id)
{"t":"req","id":"c1","cmd":"get_stats"}
{"t":"req","id":"c2","cmd":"get_paths"}
{"t":"req","id":"c3","cmd":"request_path","dest_hash":"<hex>"}
{"t":"res","id":"c1","ok":true,"data":{...}}
```

**Rule:** the bridge normalises. Node never sees msgpack, hex-with-delimiters, or Python
`None` semantics. Hashes are lowercase hex, no delimiters. Times are float epoch seconds.

### 4.6 Announce enrichment

The handler runs this before emitting:

1. `hops = RNS.Transport.hops_to(destination_hash)` — but prefer the RPC path table's value
   when present (§8.1.1 of the design doc: a client's local hop count can be off by one).
2. `rssi/snr/q = r.get_packet_rssi/snr/q(announce_packet_hash)` when the hash is provided.
3. Parse `app_data`: for `lxmf.delivery`, the display name is the leading field — decode
   defensively and fall back to `app_data_b64` so Node can re-parse later without a bridge
   change.
4. Split the destination's `app_name` and `aspects` for filtering.

Set `receive_path_responses = True` so a path response also refreshes a row — otherwise a
quiet node vanishes from the list until its next announce.

---

## 5. Node side

### 5.1 Files

```
src/server/
  reticulumBridgeClient.ts   ~380   WS client, backoff, req/res correlation, typed events
  reticulumManager.ts        ~520   ISourceManager, ingest, persistence, status
  reticulumConfig.ts         ~120   reticulumConfigFromSource() + ensureReticulumManagerStarted()
  routes/
    reticulumRoutes.ts        ~30   barrel
    reticulumStatusRoutes.ts ~180   status, connect, disconnect, bridge health
    reticulumDestRoutes.ts   ~220   destinations list/detail/favorite
    reticulumInterfaceRoutes.ts ~160 interface list + history
```

### 5.2 `ReticulumManager implements ISourceManager`

All eight members, no new abstractions:

- `sourceType` → `'reticulum'`
- `start()` → open the bridge WS, handshake, subscribe, arm pollers. Drive status through
  the same connecting → connected → error progression the connection state machine uses.
- `stop()` → close socket, clear timers, flush pending writes.
- `getStatus()` → `{ connected, lastSeen, error }` from the bridge's `status` events.
- `getLocalNodeInfo()` → `{ nodeNum: crc32(transportId), nodeId: transportIdHex, longName,
  shortName }`. Derive the integer with **CRC32 of the full hash, not a slice** — the same
  rule MeshCore follows for pubkeys.
- `startDistanceDeleteScheduler()` / `stopDistanceDeleteScheduler()` → no-op in Phase 1
  (no positions yet). Implement in Phase 3 alongside the map.

Register in the unified `sourceManagerRegistry`. Add `isReticulumManager()` to
`sourceManagerTypes.ts`. Loops over `getAllManagers()` that call Meshtastic-specific methods
already filter — verify none regress.

### 5.3 Ingest and write cadence

The 2 s stats poll must not become 2 s of database writes.

| Event | Live push | Persisted |
|---|---|---|
| `announce` | yes | immediately — upsert `reticulum_destinations` |
| `interface_stats` | yes (WebSocket → UI) | `reticulum_interfaces` upsert **on change only**; `telemetry` rows every **60 s** or on >5 % delta |
| `path_table` | yes | replace-in-transaction every 30 s |

Telemetry rows go into the **shared `telemetry` table**: `nodeId = 'if:<interfaceHash>'`,
`nodeNum = 0`, `telemetryType` one of `rns_airtime_short`, `rns_airtime_long`,
`rns_channel_load_short`, `rns_channel_load_long`, `rns_noise_floor`, `rns_bitrate`,
`rns_rxs`, `rns_txs`, `rns_battery_percent`. No schema change; the existing Dashboard,
favorite-chart, and retention machinery then work untouched.

### 5.4 Lifecycle branches

Mirror the nine `meshcore` branches in `sourceRoutes.ts` (create, enable, disable,
enable+autoConnect toggles, config change, manual connect, disconnect, delete) plus one in
`bootstrapSources.ts`. On disconnect, **remove the manager from the registry** — unlike
MeshCore, there is no reason for `/reticulum/*` routes to keep answering for a disconnected
source.

---

## 6. Data model

Two migrations, **135** and **136**, via the `/migration` skill (SQLite + PostgreSQL +
MySQL, `settingsKey` required, idempotent helpers):

- `135_create_reticulum_destinations` — the `reticulum_destinations` table from the design
  doc, minus the position columns (Phase 3 adds those).
- `136_create_reticulum_interfaces` — `reticulum_interfaces`, minus the LoRa-parameter
  columns (Phase 3, and only in `own` mode).

`reticulum_paths` waits for Phase 4. `reticulum_messages` waits for Phase 2. Both are
cheaper to add later than to carry unused.

No change to `nodes`, so the hand-written PG/MySQL DDL in `nodes.test.ts` stays untouched.

---

## 7. Frontend

`src/pages/ReticulumSourcePage.tsx` → `src/components/Reticulum/ReticulumPage.tsx`.
Phase 1 ships three views; the toolbar declares only these:

```ts
export type ReticulumView = 'destinations' | 'interfaces' | 'info' | 'settings';
```

- **Destinations** — table of announced destinations: hash (truncated, click to copy),
  display name, app name, aspects, hops, RSSI/SNR/quality, last heard, announce rate.
  Reuse the sort/filter/virtualisation patterns from `MeshCoreNodesView`.
- **Interfaces** — one card per interface with live gauges (airtime short/long, channel
  load, noise floor, bitrate, RX/TX speed, battery), plus the shared `Dashboard` mounted
  with a new `reticulumDashboardSource` adapter (~40 LOC) for history.
- **Info** — bridge health, RNS version, transport ID, attach state, and a
  `CliConsoleBody` tailing bridge logs.

Shared pieces used as-is: `ReticulumSubToolbar` (copy of the MeshCore pattern),
`SaveBarProvider`, `UiIcon`, `styles/settings.css`, per-component CSS modules.

Plus the small per-type conditionals: `main.tsx` `SourceApp` branch, `DashboardPage`
`formType` fieldset (mode selector, config-dir path, bridge URL, token),
`SourceContext` type, `DashboardSidebar`, `SearchModal`, `nodeTypeCategory`.

---

## 8. Deployment

```yaml
# docker-compose.reticulum.yml — overlay, opt-in
services:
  meshmonitor-rns-bridge:
    image: ghcr.io/yeraze/meshmonitor-rns-bridge:latest
    network_mode: host                     # required: rnsd binds 127.0.0.1 / abstract AF_UNIX
    volumes:
      - ${HOME}/.reticulum:/rns            # required: rpc_key derivation
    environment:
      MM_RNS_MODE: attach
      MM_RNS_CONFIGDIR: /rns
      MM_RNS_BIND: 127.0.0.1:8765
      MM_RNS_TOKEN: ${MM_RNS_TOKEN:?set a token}
    restart: unless-stopped
```

For `tcp_peer` mode drop both `network_mode: host` and the volume, and point
`MM_RNS_PEER` at `host:port`.

Document the `rpc_key` escape hatch for users who will not share their config dir: set the
same `rpc_key = <hex>` in both `rnsd`'s config and ours, and mount nothing.

---

## 9. Testing

**No hardware required.** This is the strongest argument for `attach` first.

1. **Bridge integration (CI)** — the test container runs `rnsd` with a single
   `TCPServerInterface` and no radio, plus a second `rnsd` connecting to it as a client that
   announces on a schedule. Our bridge attaches to the first. Assert: `hello` reports
   `attached: true`; `interface_stats` lists the TCP interface with sane `rxb`/`txb`;
   the peer's announce arrives with the right hash and hop count.
2. **Protocol contract** — golden fixtures of each event shape, asserted from both sides:
   Python emits them, TypeScript parses them. Prevents silent drift.
3. **Route tests** — `createRouteTestApp()` harness, real SQL, real permission rows. New
   route tests **must** use the harness; no `vi.mock('../../services/database.js')`.
4. **Per-source isolation** — `reticulum.perSource.test.ts` asserting two Reticulum sources
   never see each other's destinations or interfaces.
5. **Failure paths** — `rnsd` absent, wrong `rpc_key`, `rnsd` restart mid-session, bridge
   restart mid-session. Each must reach a named error code, not a hang.

The multi-backend suites skip silently without the PG/MySQL containers — start them before
claiming migrations 135/136 are verified.

---

## 10. Work packages

| WP | Deliverable | Depends on | Est. |
|---|---|---|---|
| **WP0** | The §3 spike works against a real `rnsd` | — | 0.5 d |
| **WP1** | Bridge: attach, announces, stats poll, WS server, protocol v1 | WP0 | 3 d |
| **WP2** | Migrations 135/136 (all three backends) | — | 1 d |
| **WP3** | `ReticulumBridgeClient` + `ReticulumManager` + registry/type-guard wiring | WP1, WP2 | 3 d |
| **WP4** | Source lifecycle branches + `reticulumConfig` + bootstrap | WP3 | 1.5 d |
| **WP5** | Routes: status / destinations / interfaces, with harness tests | WP3 | 2 d |
| **WP6** | Frontend: page, sub-toolbar, three views, dashboard adapter, `main.tsx` + `DashboardPage` branches | WP5 | 4 d |
| **WP7** | CI harness (dual `rnsd`), contract fixtures, failure-path tests | WP1, WP5 | 2 d |
| **WP8** | Compose overlay, Helm gate, docs, `rpc_key` troubleshooting guide | WP6 | 1 d |

**~18 working days**, WP2 parallel with WP1. Two PRs is the natural split: bridge +
backend (WP1–WP5, WP7), then frontend + deployment (WP6, WP8).

---

## 11. Risks

1. **`rpc_key` mismatch will be the top support issue.** Mitigate in the product, not the
   docs: the Info view must show "RPC authenticated: yes/no" with the exact fix inline.
2. **Shared config dir feels invasive to users.** It is read-mostly and provably safe
   (§2), but say so in the UI copy, not just the README.
3. **`network_mode: host` is unavailable on Docker Desktop for macOS/Windows.** Those users
   get `tcp_peer` mode, which loses the RPC stats. Detect and say so rather than failing
   obscurely.
4. **Announce volume on a busy network.** A large mesh can push thousands of destinations.
   Cap the destinations table with a retention setting from day one; do not discover this
   after someone's SQLite hits a million rows.
5. **A second Python process is new operational surface for MeshMonitor.** WP8 is not
   optional polish — if the compose story is not clean, Phase 2 should not start.
