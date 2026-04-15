---
name: Meshtastic has TWO ignore mechanisms
description: config.lora.ignore_incoming (hard drop, survives node delete) vs NodeInfoLite.is_ignored (UI flag, destroyed on remove_by_nodenum)
type: reference
---

Meshtastic firmware has two distinct "ignore" mechanisms that are often conflated:

**1. `Config.LoRa.ignore_incoming`** (the list, capacity 3)
- Protobuf: `meshtastic_Config_LoRaConfig_ignore_incoming` (tag 103), `config.pb.h:586`
- Stored in config partition (survives reboot, survives NodeDB operations)
- Enforced in `src/mesh/Router.cpp:853`: `is_in_repeated(config.lora.ignore_incoming, p->from)` — packet dropped before any further processing
- Independent of NodeDB: `removeNodeByNum` does NOT touch this list
- Set via AdminMessage SetConfig (LoRa section)

**2. `NodeInfoLite.is_ignored`** (per-node bool, unlimited count via NodeDB)
- Protobuf: `deviceonly.pb.h:96` (tag 11), also mirrored in `mesh.pb.h:1079` for NodeInfo
- Stored as a field on the NodeDB entry (device state file)
- Enforced in `src/mesh/Router.cpp:860`: `if (node != NULL && node->is_ignored)` — packet dropped
- Set via AdminMessage at `src/modules/AdminModule.cpp:418` (true) / :431 (false)
- **Destroyed by `removeNodeByNum`** (`NodeDB.cpp:1038`) — node entry gone means flag gone

**Key implication for MeshMonitor "ignore then delete" flow:**
- Using `is_ignored` + `remove_by_nodenum` → ignore flag is LOST. If node transmits again, NodeDB re-learns it as a fresh node (not ignored).
- Using `ignore_incoming` config list → survives delete, but capped at 3 entries total across entire mesh.
- To truly "ignore and forget" survivability: must add to `config.lora.ignore_incoming` BEFORE or INSTEAD of relying on `is_ignored`.
