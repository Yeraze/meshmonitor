---
name: Store and Forward Module Reference
description: Comprehensive S&F protocol details -- PortNum 65, message types, server/client behavior, storage in PSRAM, replay format, config fields
type: reference
---

## Store and Forward (S&F) Module

**PortNum**: `STORE_FORWARD_APP = 65` (portnums.proto). Server also intercepts `TEXT_MESSAGE_APP = 1` for storage.

### Key Firmware Files
- `src/modules/StoreForwardModule.cpp` -- full implementation
- `src/modules/StoreForwardModule.h` -- PacketHistoryStruct, class definition

### Protocol Message Types (RequestResponse enum in storeforward.proto)
- Server (1-63): ROUTER_ERROR(1), ROUTER_HEARTBEAT(2), ROUTER_PING(3), ROUTER_PONG(4), ROUTER_BUSY(5), ROUTER_HISTORY(6), ROUTER_STATS(7), ROUTER_TEXT_DIRECT(8), ROUTER_TEXT_BROADCAST(9)
- Client (64-127): CLIENT_ERROR(64), CLIENT_HISTORY(65), CLIENT_STATS(66), CLIENT_PING(67), CLIENT_PONG(68), CLIENT_ABORT(106)

### What Gets Stored
- **Only TEXT_MESSAGE_APP** -- both DMs and broadcasts
- NOT NodeInfo, Position, Telemetry, or control messages
- Stored in PSRAM circular array (PacketHistoryStruct ~260 bytes each)
- Requires 1MB+ free PSRAM; uses 75% of free PSRAM by default
- Circular overwrite when full (destructive reset of counter to 0)

### Server Eligibility
Role must be ROUTER, ROUTER_LATE, or `is_server = true` in config, PLUS device must have 1MB+ free PSRAM. ESP32/Portduino only.

### Replay Format
- Over mesh: Sent as STORE_FORWARD_APP with ROUTER_TEXT_DIRECT/BROADCAST, text in variant.text bytes. MeshPacket preserves original from, id, channel, rx_time, RF metadata.
- To PhoneAPI (local): Sent as TEXT_MESSAGE_APP with raw text, preserves original to/from.
- Drip-fed one packet per 5 seconds, only when channel util < 25%.

### Default Channel Blocking
S&F refuses history requests on the default (public) channel -- sends error text message instead.

### Heartbeat
Default interval 900s (15 min), disabled by default. Broadcasts ROUTER_HEARTBEAT with period and secondary fields. Only sent when channel util < 25%.

### MQTT
No direct MQTT integration. Purely mesh-radio. May passively store/replay messages that transited via MQTT.

### Config Fields (StoreForwardConfig)
enabled, heartbeat, records, history_return_max (default 25), history_return_window (default 240 min), is_server
