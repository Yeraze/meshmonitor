---
name: PhoneAPI Connection Timeouts
description: Firmware phone API inactivity timeouts per transport — serial is 15 minutes, TCP uses socket state
type: reference
---

**Serial transport:** `SerialModule::checkIsConnected()` uses `SERIAL_CONNECTION_TIMEOUT` macro. Source comment (src/modules/SerialModule.cpp line 60): *"API: Defaulting to the formerly removed phone_timeout_secs value of 15 minutes"*. So after 15 minutes of no client traffic, firmware closes the phone API connection.

**TCP/WiFi transport:** `StreamAPI`/WiFi subclass bases `checkIsConnected()` on TCP socket state rather than `lastContactMsec`. So TCP clients are kept alive as long as the socket is open — firmware does NOT enforce an inactivity timeout on TCP. Dead-host detection over TCP is entirely up to the client (because the kernel's socket state lags real connectivity by many minutes due to send-buffer behavior).

**BLE transport:** Managed by NimBLE stack with its own connection supervision timeout.

**All transports share:**
- Base class `PhoneAPI` tracks `lastContactMsec` in `src/mesh/PhoneAPI.h`.
- `checkConnectionTimeout()` is a non-virtual base method that calls pure-virtual `checkIsConnected()` (per-transport).
- `handleToRadio()` updates `lastContactMsec = millis()` on every incoming message.

**Practical implication for clients:**
- Client heartbeats should be well under 15 minutes (30-60s is standard).
- TCP clients MUST implement their own dead-host detection (heartbeat-with-reply, not just heartbeat-fire-and-forget) because firmware won't disconnect them and the kernel won't notice for a long time.

**Source:** 
- https://github.com/meshtastic/firmware/blob/master/src/mesh/PhoneAPI.h
- https://github.com/meshtastic/firmware/blob/master/src/modules/SerialModule.cpp
