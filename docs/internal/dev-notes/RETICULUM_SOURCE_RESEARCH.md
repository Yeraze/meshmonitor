# Reticulum Source — Research (Issue #3960)

**Issue:** [#3960 [FEAT] Reticulum Source](https://github.com/Yeraze/meshmonitor/issues/3960) (promoted from discussion #3885)
**Ask:** Add Reticulum as a third protocol source alongside Meshtastic and MeshCore ("the big 3").
**Status:** Research / feasibility. No implementation yet.
**Date:** 2026-07-06

---

## 1. What Reticulum is (and isn't)

[Reticulum Network Stack (RNS)](https://reticulum.network/) is a cryptography-first networking
stack by Mark Qvist. Current release **1.3.6** (June 2026), actively developed, ~6.2k stars.
It is *not* a LoRa protocol per se — it is a general routing/encryption stack that runs over
any carrier: LoRa (via RNode hardware), packet radio, TCP, UDP, I2P, serial, etc.
Messaging happens on top via **LXMF** (msgpack-based, store-and-forward via propagation nodes);
apps include Sideband, MeshChat/MeshChatX, NomadNet.

Key architectural differences vs Meshtastic/MeshCore that shape what a "Reticulum source"
can even show:

| Concept | Meshtastic | MeshCore | Reticulum |
|---|---|---|---|
| Node identity | uint32 `nodeNum` | pubkey (companion contact) | 16-byte **destination hash** per (identity, app, aspect) — one identity has *many* destinations |
| Discovery | NodeInfo broadcast | Adverts | **Announces** (opt-in, per destination; carry app_data e.g. LXMF display name) |
| Position | Broadcast POSITION_APP | Advert lat/lon | **None natively** — only Sideband's opt-in telemetry-over-LXMF (FIELD_TELEMETRY 0x02, msgpack) |
| Telemetry | DEVICE/ENV_METRICS broadcast | Repeater stats | Same — Sideband telemetry collector model, peer-to-peer, not broadcast |
| Channels | PSK channels | Hashtag channels | **None** — LXMF is 1:1; group comms via NomadNet boards/pages or symmetric Group destinations |
| Topology | Traceroute, neighborInfo | Path/out_path | Path table hops (only if you run a Transport node); `rnpath`/`rnprobe`; no per-hop SNR |
| "Local node" | Companion radio over TCP/serial | Companion/repeater | An **RNS instance** on a host (rnsd), typically with RNode/TCP interfaces attached |
| Source addressing | On every packet | On every packet | **Packets carry no source address** — you only know senders who announce or message you |

Implication: a Reticulum source is closer to "monitor an RNS instance" (its interfaces,
announce stream, path table, LXMF inbox/outbox) than "monitor a mesh of nodes". The Nodes-list
UX becomes "announced destinations"; the map is mostly empty unless peers run Sideband
telemetry sharing with us; channel chat has no equivalent.

## 2. Integration paths evaluated

### Option A — `@liamcottle/rns.js` (native JS, same author as meshcore.js) — **not viable today**
- README self-describes as "extremely limited… probably not what you should be using."
- **Dormant: last commit 2025-02-10 (~17 months), npm v0.0.4, 23 stars, MIT.**
- Does implement: identities, `TCPClientInterface`/`WebsocketClientInterface` into an existing
  RNS instance, announces, destinations, links, opportunistic + direct LXMF.
- Missing: ratchets (modern LXMF peers default to ratcheted delivery → decryption failures),
  Resources over Links (large messages/attachments), LXMF signature validation, stamps/tickets,
  transport-node mode.
- RNS wire format is declared stable, so it hasn't necessarily bit-rotted, but adopting it means
  owning/forking a crypto stack. High risk.

### Option B — Python sidecar bridge (rnsd + small bridge daemon) — **the workable path**
- The official RNS API is **in-process Python only**. Every real integration (MeshChat, NomadNet,
  Sideband) embeds Python RNS/LXMF. MeshChat's architecture is exactly this: `meshchat.py` runs
  an RNS instance + WebSocket server; the web UI speaks JSON over the socket.
- Shape: a `meshmonitor-rns-bridge` Python process (RNS + LXMF pip deps) exposing a local
  WebSocket/HTTP API: announce events, interface stats (what `rnstatus` shows), path table,
  LXMF send/receive, identity management. Node backend's `ReticulumManager` speaks to it —
  analogous to how `meshcoreManager` speaks meshcore.js to a companion.
- Deployment cost is the real price: Docker image (node:24) must add Python3 + pip deps;
  LXC template ditto (and `lxc/sparse-cone.txt`); baremetal Node users need Python;
  the Tauri desktop app has no good story for bundling a Python daemon.
- Users who already run rnsd/MeshChat could point the bridge's RNS config at their existing
  network via a TCP interface — no radio hardware required to join a Reticulum network.

### Option C — Consume an existing app's API (MeshChat / MeshChatX) — thin but fragile
- MeshChat exposes an HTTP + WebSocket API (undocumented/internal, changes freely).
- liamcottle's MeshChat has slowed; the community fork **MeshChatX** (git.quad4.io/RNS-Things)
  is the active continuation — API stability across the fork split is a gamble.
- Would make MeshMonitor a dashboard-for-MeshChat rather than a first-class source. Not
  recommended as the primary path, but a running MeshChat instance is a good manual test peer.

### Option D — Wait / help mature a JS implementation — the "not yet" answer
- If rns.js (or another JS RNS) matured, Option A becomes the clean answer, matching the
  meshcore.js precedent. Nothing in the ecosystem suggests this is imminent.

## 3. What a Reticulum source could actually surface (MVP scope)

Realistic v1 feature set, mapped to existing MeshMonitor concepts:

1. **Announce monitor → Nodes list.** Row per announced destination hash: app name
   (`lxmf.delivery`, `nomadnetwork.node`, …), display name from app_data, hops, last-seen,
   announce rate. This is the closest analog to the node database.
2. **Interface status → Connection/telemetry panel.** Per-interface (RNode, TCPClient, …)
   TX/RX bytes, bitrate, status — the `rnstatus` view over time.
3. **LXMF messaging → Messages page.** MeshMonitor holds its own LXMF identity; send/receive
   DMs with delivery proofs; optional propagation-node sync. Maps to direct messages only —
   no channel tab.
4. **Path table → a modest topology view** (hops per destination, next-hop interface) when the
   bridge's RNS instance is a Transport node.
5. **Later:** Sideband-compatible telemetry (FIELD_TELEMETRY msgpack decode → map pins,
   telemetry graphs) for peers that explicitly share with our identity; NomadNet page browsing
   is out of scope.

Not mappable: channels, traceroute SNR, position broadcast, remote node administration
(Meshtastic-style), key-repair — these UI areas would be hidden for Reticulum sources
(the per-source-type UI branching MeshCore introduced already establishes that pattern).

## 4. Codebase integration surface

### The template is MeshCore's *parallel-stack* pattern, not `ISourceManager`

MeshCore did not end up implementing `ISourceManager`/shared tables as
`docs/internal/meshcore-design/MESHCORE-INTEGRATION-PLAN.md` originally planned. The shipped
architecture is a parallel system, and Reticulum (whose data model fits the Meshtastic-shaped
`nodes`/`messages` tables even less) should copy it:

| Layer | MeshCore precedent | Reticulum equivalent |
|---|---|---|
| Type discriminator | `type` union in `src/db/repositories/sources.ts:14` (`'meshtastic_tcp' \| 'mqtt_broker' \| 'mqtt_bridge' \| 'meshcore'`); copies in `src/contexts/SourceContext.tsx:16`, `src/pages/DashboardPage.tsx:127` | Add `'reticulum'`. `sources.config` is opaque JSON — no sources-table migration needed |
| Manager + registry | `MeshCoreManager` (EventEmitter) + own `MeshCoreManagerRegistry` (`src/server/meshcoreRegistry.ts`) with `xxxConfigFromSource()` mapper | `ReticulumManager` + `ReticulumManagerRegistry`; config = bridge endpoint / RNS interface settings |
| Lifecycle wiring | Scattered `if (source.type === 'meshcore')` branches in `src/server/routes/sourceRoutes.ts` (~75 refs: create/enable/disable/config-change/delete) + startup in `server.ts` | Add a `reticulum` branch at each lifecycle point |
| Tables | Parallel `meshcore_*` tables (nodes, messages, neighbors, packet_log, position_history, heard_repeaters), all with `sourceId`; `MeshCoreRepository` in `src/db/repositories/meshcore.ts`; ~20 numbered migrations | `reticulum_announces`, `reticulum_messages` (LXMF), `reticulum_interfaces_stats`, `reticulum_paths` — 2-3 migrations for MVP (use the `/migration` skill; all three backends) |
| Routes | One nested router: `src/server/routes/meshcoreRoutes.ts` (3,682 LOC, 82 endpoints) mounted at `/api/sources/:id/meshcore/*`, every handler `requirePermission(..., { sourceIdFrom: 'params.id' })` | `reticulumRoutes.ts` at `/api/sources/:id/reticulum/*` — MVP needs ~15-20 endpoints (status/connect/announces/interfaces/paths/messages/send/identity) |
| Frontend fork | `src/main.tsx:49-86` `SourceApp` branches to `<MeshCoreSourcePage>`; dedicated tree `src/components/MeshCore/` (~50 files, ~14k LOC) | Third branch → `<ReticulumSourcePage>` with Announces / Interfaces / Messages views |
| Source form | `DashboardPage.tsx` add/edit modal `formType` per-type fields | Bridge host/port or managed-sidecar toggle + RNS interface config |
| Transport | No shared abstraction — each manager owns its own (`meshcoreNativeBackend.ts`) | The Python bridge owns transports (RNode/serial/TCP are *RNS interfaces*, configured on the bridge, not in Node) |

Diffuse cost: ~30+ shared files (Unified* pages, DashboardSidebar, SearchModal,
`nodeTypeCategory.ts`, SourceContext, etc.) carry small per-type conditionals to extend.

Nothing in the repo references Reticulum today except the unrelated Meshtastic
`RETICULUM_TUNNEL_APP = 76` portnum. This is greenfield.

### Scale reference: what MeshCore cost

MeshCore-specific code (non-test): **~84 files, ≈36,700 LOC** (server core ~9.7k, routes ~3.7k,
services ~3.2k, DB ~2.2k, frontend ~14.1k, migrations ~2.9k) — 163 files including tests.
A Reticulum **MVP** (announces + interfaces + LXMF DMs, no rooms/admin/telemetry/CLI) is
plausibly **~10-15k LOC** across Python bridge (~1-2k), manager/registry (~1.5k), routes (~1k),
DB (~1k), frontend (~4-6k), plus tests. Months of effort, not a weekend feature.

## 5. Recommendation

**Feasible, but only via a Python sidecar (Option B), and it's a MeshCore-scale commitment.**
Concretely:

1. **Don't build on rns.js** — dormant since Feb 2025, self-declared incomplete, missing
   ratchets (breaks modern LXMF interop). Adopting it means maintaining a crypto stack.
2. **Architecture if/when built:** `meshmonitor-rns-bridge` Python daemon (official `rns` +
   `lxmf` pip packages) exposing a local WebSocket API (MeshChat's proven shape);
   `ReticulumManager` in Node consumes it, following the MeshCore parallel-stack pattern above.
   Ship it as an optional sidecar container (compose/helm) rather than fattening the node:24
   image; LXC adds python3 via chroot; desktop (Tauri) marks Reticulum sources unsupported in v1.
3. **Set expectations on the issue:** a Reticulum "source" monitors an RNS instance —
   announced destinations, interface throughput, path table, LXMF messaging. No channels, no
   broadcast positions/telemetry (map stays empty unless peers share Sideband telemetry with
   MeshMonitor's identity), no remote node admin. It will feel different from the other two tabs.
4. **Suggested phasing** (if accepted): Phase 1 bridge + announce monitor + interface stats;
   Phase 2 LXMF identity + DMs + propagation-node sync; Phase 3 path-table topology +
   Sideband-compatible telemetry/map. Each phase is independently shippable.
5. **Posture:** given the effort-to-user-demand ratio (one discussion upvote so far), reasonable
   to label `enhancement` + `help wanted`, post this research as a comment, and gauge demand
   before committing.

## Sources

- rns.js: https://github.com/liamcottle/rns.js (activity via GitHub API 2026-07-06)
- Reticulum manual — Understanding Reticulum: https://reticulum.network/manual/understanding.html
- Reticulum software list: https://reticulum.network/manual/software.html
- MeshChat: https://github.com/liamcottle/reticulum-meshchat
- LXMF: https://github.com/markqvist/LXMF · Fields wiki: https://github.com/markqvist/Reticulum/wiki/LXMF-Fields
- Sideband (telemetry system): https://github.com/markqvist/Sideband
