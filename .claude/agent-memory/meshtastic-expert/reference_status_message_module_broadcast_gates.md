---
name: status-message-module-broadcast-gates
description: StatusMessageModule (NODE_STATUS_APP portnum 36) v2.7.23 — what actually gates the periodic broadcast; the has_statusmessage flag drives BOTH interval and send; set path does NOT reboot
metadata:
  type: reference
---

# StatusMessageModule / NODE_STATUS_APP (portnum 36) broadcast gating

Verified against firmware tag **v2.7.23.b246bcd** (read raw source, not docs).

## What the module is at this tag
- Present, functional, and SHIPPING at v2.7.23 (not a later merge). It is a
  `SinglePortModule` + `concurrency::OSThread`.
- Constructed unconditionally at `src/modules/Modules.cpp:164`
  (`statusMessageModule = new StatusMessageModule();`), inside
  `#if !MESHTASTIC_EXCLUDE_STATUS`. Standard ESP32/nRF release builds do NOT
  define `MESHTASTIC_EXCLUDE_STATUS`, so it IS compiled in. Only slim/tiny
  builds exclude it.

## The ONE gate: `moduleConfig.has_statusmessage && node_status[0] != '\0'`
This same compound condition appears in TWO places and drives everything:

1. **Constructor** (`src/modules/StatusMessageModule.h`): if true →
   `setInterval(2*60*1000)` (2 min); else → `setInterval(12h)`.
2. **`runOnce()`** (`src/modules/StatusMessageModule.cpp:11`): if true → build
   `meshtastic_StatusMessage`, `allocDataPacket()`, `to=NODENUM_BROADCAST`,
   `want_response=false`, `priority=BACKGROUND`, `channel=0`,
   `service->sendToMesh(p)`. **Sends on the FIRST fire — no first-run guard, no
   airtime/channel-util gate, no role/wantReplies check, no queue check.**
   Always `return 1000*12*60*60;` (12h) afterward.

There is **NO `enabled` field** in `StatusMessageConfig` (proto has only
`node_status = 1`). The runtime never checks any enable flag beyond the presence
bool + non-empty string.

## OSThread is enabled by default
`OSThread` ctor (`src/concurrency/OSThread.cpp:29`) adds itself to
`mainController`; the ArduinoThread base `Thread` defaults `enabled = true`.
`setInterval` alone arms it (base `Thread::setInterval` recomputes next-run from
`last_run`). So on a clean boot with the config set, the thread fires ~2 min
after boot and sends. No explicit enable call needed.

## The trap: set path does NOT reboot (runtime staleness)
`AdminModule::handleSetModuleConfig` case `statusmessage_tag`
(`src/modules/AdminModule.cpp:1011-1016`) sets `has_statusmessage = true`,
copies the payload, then **`shouldReboot = false;`**. `saveChanges` persists to
flash (via `service->reloadConfig` → saveToDisk) but does NOT reboot.
Consequence: if the node booted WITHOUT a status, the OSThread was constructed
on the 12h branch; setting the status at runtime updates RAM/flash but does NOT
re-arm the thread — next fire is up to 12h away. "Set it and wait" looks dead
for hours. A reboot re-runs the constructor and arms the 2 min interval.

## Why a "set + clean reboot" node can still broadcast ZERO
If, after a genuine reboot with config persisted, it still never broadcasts, the
persisted `has_statusmessage` must be false (or node_status empty). Prime cause:
the set_module_config write must set the ModuleConfig oneof discriminator
`which_payload_variant = meshtastic_ModuleConfig_statusmessage_tag`. If a client
populates `statusmessage.node_status` but leaves the oneof unset, the switch at
AdminModule.cpp:923 matches no case, `has_statusmessage` is never set true, and
nothing persists — yielding the 12h-interval-and-never-send behavior. Note
`get_module_config` (AdminModule.cpp:1197-1200) echoes whatever is in RAM, so a
readback can look "set" from stale RAM even when the write never took; verify
after a reboot.

US region / duty cycle is a red herring — BACKGROUND priority is not blocked by
duty cycle in US.
