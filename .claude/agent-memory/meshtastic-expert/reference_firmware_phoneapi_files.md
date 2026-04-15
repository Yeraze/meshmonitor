---
name: Firmware PhoneAPI Source Locations
description: Key firmware file paths and functions for PhoneAPI / StreamAPI / Heartbeat investigation
type: reference
---

**Firmware repo:** https://github.com/meshtastic/firmware (master)

**Phone API core:**
- `src/mesh/PhoneAPI.h` — base class, defines `lastContactMsec`, `checkConnectionTimeout()`, `checkIsConnected()` (pure virtual), `APIType` enum (BLE/WIFI/SERIAL/PACKET/HTTP/ETH), State machine enum
- `src/mesh/PhoneAPI.cpp` — `handleToRadio()` switch on `toRadioScratch.which_payload_variant`, `getFromRadio()` state machine (STATE_SEND_MY_INFO → STATE_SEND_UIDATA → ... → STATE_SEND_PACKETS), heartbeat → queueStatus reply at top of `getFromRadio()`

**Transport-specific subclasses:**
- `src/modules/SerialModule.cpp` — Serial transport, defines `SERIAL_CONNECTION_TIMEOUT` ~15min, implements `checkIsConnected()` via `Throttle::isWithinTimespanMs(lastContactMsec, SERIAL_CONNECTION_TIMEOUT)`
- `src/mesh/api/StreamAPI.*` — base for stream-oriented transports (note: URL path may be `src/mesh/` not `src/mesh/api/` depending on firmware version)
- BLE phone API subclass under `src/mesh/` or platform-specific dirs

**Protobuf definitions:**
- `meshtastic/mesh.proto` lines ~2287 (ToRadio.heartbeat field 7), ~2512-2520 (Heartbeat message with single uint32 nonce field)
- https://github.com/meshtastic/protobufs/blob/master/meshtastic/mesh.proto

**Key constants in PhoneAPI.h:**
- `MAX_TO_FROM_RADIO_SIZE = 512` — BLE packet size cap
- `SPECIAL_NONCE_ONLY_CONFIG = 69420` — client asks for config but no node DB
- `SPECIAL_NONCE_ONLY_NODES = 69421` — client asks for node DB only

**Config handshake flow:** Client sends `ToRadio.want_config_id = nonce`, firmware replies with a sequence of `FromRadio` messages ending in `config_complete_id = nonce` that echoes the client's nonce. This is the ONE place where a nonce IS echoed (unlike Heartbeat.nonce which is not).
