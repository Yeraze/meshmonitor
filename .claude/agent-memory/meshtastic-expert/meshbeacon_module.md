---
name: MeshBeacon module (MESH_BEACON_APP portnum 37) protocol and firmware behavior
description: Field numbers, the 3600s interval floor, admin-write validation/clearing rules, and the PhoneAPI PSK redaction for MeshBeaconConfig — firmware 2.8 develop only
type: reference
---

MeshBeacon is a **firmware 2.8 / `develop`-branch** feature. Protobufs are merged to
`meshtastic/protobufs` master; firmware code is `develop` only, absent from `master`.
Compiled in unless `MESHTASTIC_EXCLUDE_BEACON` is defined (not defined in `configuration.h`,
so stock builds include it). Two module instances: `MeshBeaconBroadcastModule` and
`MeshBeaconListenerModule` (`src/modules/Modules.cpp`).

## Field numbers — easy to conflate

| Thing | Number |
|---|---|
| `PortNum.MESH_BEACON_APP` | 37 |
| `ModuleConfig.mesh_beacon` | **17** |
| `LocalModuleConfig.mesh_beacon` | **18** (different! localonly.proto) |
| `AdminMessage.ModuleConfigType.MESHBEACON_CONFIG` | **16** (currently the enum MAX) |

`MeshBeaconConfig`: flags=1 (tag 2 unused), broadcast_send_as_node=3, broadcast_message=4,
broadcast_offer_channel=5, broadcast_offer_region=6, broadcast_offer_preset=7 (optional),
broadcast_on_channel=8, broadcast_on_region=9, broadcast_on_preset=10 (optional),
broadcast_interval_secs=11, broadcast_targets=12 (max_count 4).
`Flags`: LISTEN=1, BROADCAST=2, LEGACY_SPLIT=4. Enable/disable is the **flag bit**, never the interval.

## Interval

`default_mesh_beacon_min_broadcast_interval_secs 3600` — `src/mesh/Default.h:34`.
Both floor and default. Two independent enforcement points:

- **On write** (`AdminModule::handleSetModuleConfig`): a nonzero value below 3600 is raised to
  3600 and *persisted*. **0 is stored as 0** — explicitly "unset/use default", not disabled.
- **At runtime** (`MeshBeaconBroadcastModule::runOnce`): `getConfiguredOrDefault(v, 3600)` maps
  0→3600, then `getConfiguredOrMinimumValue(...)`. Note `getConfiguredOrMinimumValue` returns 0
  unchanged by design (`src/mesh/Default.cpp:83`), so the order of the two calls matters.

## Admin write semantics

`moduleConfig.mesh_beacon = beaconCfg;` — **whole-struct replace**. Omitted fields become proto3
defaults. See the general admin-config memory for why this bites every module.
Sets `shouldReboot = false` and calls `meshBeaconBroadcastModule->invalidateCache()`.

Validation performed on write (each *clears* rather than rejects; the admin call still succeeds):
- `broadcast_message[100] = '\0'` hard cap.
- `broadcast_on_preset` invalid for region → clears `has_broadcast_on_preset` **and** `has_broadcast_on_channel`.
- `broadcast_offer_preset` invalid for region → clears `has_broadcast_offer_preset` only (NOT the channel).
- `broadcast_offer_region` not a known region code → reset to UNSET. Detected via
  `getRegion(code)` (`src/mesh/RadioInterface.cpp:667`), which walks the region table and
  returns the UNSET sentinel on miss, so the caller tests `r->code != code`.
- Per-target region/preset/`channel_index` (`>= MAX_NUM_CHANNELS`) cleared the same way.

**There is no coupling between `broadcast_offer_channel` and `broadcast_offer_region`.** An empty
or nameless offer channel does not clear the region or preset. At send time `offer_region` is
copied unconditionally and alone satisfies the `hasRadioContent` check, so a region-only offer is
valid and transmitted. If a region appears to "reset itself", suspect the replace semantics above.

`broadcast_send_as_node` is the one field guarded on the remote path: for a remote admin
(`mp.from != 0`) it must equal the sender's node ID, else it is silently reverted to the stored
value (AdminModule.cpp ~line 346).

## PhoneAPI / want_config

`mesh_beacon` IS included in the normal want_config module-config stream (`PhoneAPI.cpp` ~line 916).
The stream emits one `ModuleConfig` per `FromRadio` (using `ModuleConfig` tag 17), iterating
`config_state` over `ModuleConfigType MIN+1 .. MAX+1` — it does not send a `LocalModuleConfig` blob,
so `LocalModuleConfig` field 18 is the on-disk representation, not the wire one.

**Redaction gotcha:** under `MESHTASTIC_PHONEAPI_ACCESS_CONTROL`, an unauthenticated client gets a
zero-initialized MeshBeaconConfig — the variant is still emitted, but every field reads as default,
because the embedded ChannelSettings carry PSKs. A client seeing an all-zero MeshBeaconConfig may
be unauthorized rather than unconfigured.
