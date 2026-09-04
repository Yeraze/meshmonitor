---
name: meshbeacon-broadcast-on-fields-removed
description: MeshBeaconConfig tags 8/9/10 (broadcast_on_channel/region/preset) were deleted and reserved on 2026-08-28; all v2.8.0 firmware tags lack them — send broadcast_targets (tag 13) instead
metadata:
  type: reference
---

`ModuleConfig.MeshBeaconConfig` field tags **8, 9, 10** — `broadcast_on_channel`
(ChannelSettings), `broadcast_on_region` (RegionCode), `optional broadcast_on_preset`
(ModemPreset) — **no longer exist**. They were removed and `reserved` in protobufs
commit `4ac5e0fc7e` "Consolidate beacon TX destinations onto broadcast_targets"
(2026-08-28, PR meshtastic/protobufs#1048, merge `7b2464c9b8`), and in firmware by
`7afd270f39` "Gut beacon send-as-node and consolidate TX onto broadcast_targets"
(#11646, 2026-08-28). Tag 3 `broadcast_send_as_node` was reserved in the same wave
(`40c405b570`).

Surviving numbering (protobufs master + firmware develop + every v2.8.0 tag):
`flags=1`, reserved 3, `broadcast_message=4`, `broadcast_offer_channel=5`,
`broadcast_offer_region=6`, `optional broadcast_offer_preset=7`, reserved 8/9/10,
`broadcast_interval_secs=11`, `repeated BroadcastTarget broadcast_targets=13`.
`BroadcastTarget`: `optional preset=1`, `region=2`, reserved 3,
`optional channel_index=4`. `ModuleConfig.mesh_beacon` oneof tag = 17;
`AdminMessage.ModuleConfigType.MESHBEACON_CONFIG = 16`.

**Why this matters:** the `broadcast_on_*` group never shipped in a tagged release
(MeshBeacon merged 2026-07-23 via firmware #10618; first beacon-capable tags are
`v2.8.0.7239fe8` 2026-08-29 and `v2.8.0.47db0e3` 2026-08-31 — both post-removal).
A client built against protobufs older than 2026-08-28 that still sends fields
9/10 hits nanopb's silent unknown-field skip: `set_module_config` decodes fine,
`AdminModule` whole-struct-replaces `moduleConfig.mesh_beacon = beaconCfg`, and the
values simply are not there. Symptom = "region/preset revert to UNSET, broadcast
targets empty" with **no error and no log line**.

**How to apply:** any beacon TX destination must go in `broadcast_targets` (tag 13,
nanopb `max_count:4`). `broadcast_offer_*` (5/6/7) are unaffected — those describe
what the beacon *advertises*, not where it transmits. `broadcast_message` is
`max_size:101` (100 chars + NUL); overlong strings or >4 targets fail nanopb decode
and drop the **whole** ModuleConfig silently.

Related: [[reference-protobufjs-decoded-message-shape]], [[project-mt-28-tracking-state]]
