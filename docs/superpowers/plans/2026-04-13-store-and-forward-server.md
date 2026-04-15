# Store & Forward Server for MeshMonitor — Feasibility & Design

## Context

Meshtastic's Store & Forward (S&F) module lets a server node cache text messages and replay them to clients that were offline. Today only ESP32 nodes with PSRAM can serve S&F — most common boards (Heltec V2, RAK, T-Echo) lack PSRAM entirely. MeshMonitor already receives and stores every text message in its database, making it a natural candidate to act as an S&F server, giving any mesh with a MeshMonitor instance S&F capability for free.

**Goal**: Determine feasibility and design an implementation where MeshMonitor responds to S&F protocol queries over the mesh.

---

## Protocol Summary

- **PortNum 65** (`STORE_FORWARD_APP`) — defined in `src/server/constants/meshtastic.ts:32`
- **Protobuf**: `StoreAndForward` in `protobufs/meshtastic/storeforward.proto`
- **Message types** (RequestResponse enum):
  - Server -> Client: `ROUTER_HEARTBEAT(2)`, `ROUTER_PING(3)`, `ROUTER_PONG(4)`, `ROUTER_BUSY(5)`, `ROUTER_HISTORY(6)`, `ROUTER_STATS(7)`, `ROUTER_TEXT_DIRECT(8)`, `ROUTER_TEXT_BROADCAST(9)`, `ROUTER_ERROR(1)`
  - Client -> Server: `CLIENT_HISTORY(65)`, `CLIENT_STATS(66)`, `CLIENT_PING(67)`, `CLIENT_PONG(68)`, `CLIENT_ABORT(106)`, `CLIENT_ERROR(64)`
- **What gets stored**: Only `TEXT_MESSAGE_APP` (PortNum 1) — DMs and broadcasts
- **Replay format**: Wrapped in `StoreAndForward { rr: ROUTER_TEXT_DIRECT|BROADCAST, text: <bytes> }` sent as PortNum 65. `from` field = server nodeNum (normal S&F behavior). Original sender conveyed inside the protobuf.
- **Drip-feed**: 5-second intervals, only when channel utilization < 25%
- **Heartbeat**: Broadcast every 900s (configurable), contains `period` and `secondary` fields
- **Security**: Refuses to serve history on default (public) channel

---

## Feasibility Assessment: YES, with caveats

### Why it works
1. MeshMonitor already stores all text messages with sender, timestamp, channel, RF metadata
2. Existing `transport.send()` pipeline can send arbitrary-portnum packets
3. The `from` field behavior is correct — S&F servers always send from their own nodeNum; original sender is embedded in the S&F protobuf payload
4. The protobuf definition (`storeforward.proto`) already exists in the repo, just not loaded

### Key constraints
| Concern | Impact | Mitigation |
|---|---|---|
| Connected node must NOT also run S&F | High — duplicate responses | Detect via moduleConfig, warn in UI, refuse to activate |
| Channel utilization data may be stale | Medium | Use connected node's DeviceMetrics telemetry; conservative thresholds |
| MeshMonitor only sees messages it can decrypt | Low | Only replay messages where `text` is non-null (already standard) |
| Firmware expects S&F from a "real" node | None | Protocol doesn't distinguish; packets are valid S&F format |

---

## Architecture

### New files
- **`src/server/services/storeForwardService.ts`** (~400-600 lines) — core S&F server logic

### Modified files
- **`src/server/protobufLoader.ts`** — add `root.load()` for `storeforward.proto` (3 lines, follows existing pattern at lines 32-51)
- **`src/server/meshtasticProtobufService.ts`** — add `createStoreForwardMessage()` and `decodeStoreForwardMessage()` (~100 lines, follows `createNeighborInfoRequestMessage` pattern)
- **`src/server/meshtasticManager.ts`** — add `case PortNum.STORE_FORWARD_APP:` to switch at ~line 4100, init/teardown service (~50 lines)
- **`src/server/constants/meshtastic.ts`** — add S&F RequestResponse enum constants (~15 lines)
- **Database migration** — `sf_replay_state` table for per-client tracking
- **Settings/UI** — enable/disable toggle, heartbeat config, stats display, conflict warning

### Existing code to reuse
| What | Where | How |
|---|---|---|
| Protobuf loading pattern | `protobufLoader.ts:32-51` | Same `root.load()` call |
| Packet creation pattern | `meshtasticProtobufService.ts` `createTracerouteMessage()` | Same Data->MeshPacket->ToRadio flow |
| Message query | `src/db/repositories/messages.ts` `getMessagesAfterTimestamp()` | Core replay data source |
| Channel utilization | `src/db/schema/nodes.ts:26` `channelUtilization` | Throttle replay rate |
| Scheduler pattern | `meshtasticManager.ts` `startTracerouteScheduler` | Heartbeat timer |
| Per-source settings | `getSettingForSource()` pattern | S&F config per source |

---

## Phased Implementation

### Phase 1: Decode & Display (low risk, immediate value)
- Load `storeforward.proto` in protobufLoader
- Add decode logic in protobufService
- Handle PortNum 65 in processMeshPacket switch — decode and log
- Show decoded S&F details in PacketMonitorPanel (already shows brown for portnum 65, add decoded fields)

### Phase 2: Respond to Pings & Stats (low risk, protocol validation)
- Create `StoreForwardService` skeleton
- Respond to `CLIENT_PING` -> `ROUTER_PONG`
- Respond to `CLIENT_STATS` -> `ROUTER_STATS` with real database counts
- Add enable/disable setting
- Validates packet sending works correctly end-to-end

### Phase 3: History Replay (medium risk, core feature)
- Handle `CLIENT_HISTORY` requests
- Query messages from database for the requesting client's time window
- Implement drip-feed timer (5s intervals)
- Check channel utilization before each send
- Track replay state per client in `sf_replay_state` table
- Handle `CLIENT_ABORT` to cancel in-progress replay
- Refuse requests on default channel

### Phase 4: Heartbeat & Discovery (medium risk)
- Broadcast `ROUTER_HEARTBEAT` at configurable interval (default 900s)
- Allow mesh clients to auto-discover MeshMonitor as S&F server
- Configuration UI for heartbeat interval, max return messages, history window

---

## Verification Plan

1. **Phase 1**: Deploy dev container, have a node with S&F enabled send messages — verify MeshMonitor decodes and displays them in PacketMonitor
2. **Phase 2**: Send `CLIENT_PING` from a mesh node (or craft via API) — verify `ROUTER_PONG` response appears on the mesh
3. **Phase 3**: Put a node offline, send messages to the mesh, bring node back online, have it send `CLIENT_HISTORY` — verify it receives replayed messages with correct sender/timestamp
4. **Phase 4**: Check that mesh nodes discover MeshMonitor as an S&F server via heartbeat
5. **Conflict test**: Enable S&F on connected node + MeshMonitor — verify MeshMonitor refuses to activate and warns

---

## Open Questions

1. **Multi-source**: If MeshMonitor connects to multiple sources, should each source get its own S&F server instance? (Probably yes — each source is a different mesh.)
2. **Message scope**: Should MeshMonitor replay messages it received from ALL sources, or only from the source the requesting client is on? (Only same source — cross-mesh replay would be confusing.)
3. **History window**: Firmware default is 120 minutes. MeshMonitor has much deeper storage — should we offer a longer window? (Configurable, default matching firmware for compatibility.)
4. **Original sender metadata**: The firmware S&F wraps only the text bytes, not the original sender nodeNum. How does the client know who sent it? (Need to verify firmware behavior — may embed original `from` in the MeshPacket relay somehow, or clients may just show "via S&F server".)
