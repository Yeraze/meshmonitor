---
name: AdminMessage.set_module_config replaces the whole sub-message, never merges
description: Why omitting a field in set_module_config wipes it to the proto3 default — applies to every ModuleConfig variant, not just one module
type: reference
---

`AdminMessage.set_module_config` is **replace, not merge**, for every module.

Path: `AdminModule::handleReceivedProtobuf` → `case meshtastic_AdminMessage_set_module_config_tag`
→ `AdminModule::handleSetModuleConfig(const meshtastic_ModuleConfig &c)`
(`src/modules/AdminModule.cpp`, the big `switch (c.which_payload_variant)`).

Every case is a plain whole-struct assignment, e.g.:

```cpp
moduleConfig.has_statusmessage = true;
moduleConfig.statusmessage = c.payload_variant.statusmessage;
```

There is no field-mask and no per-field merge anywhere in the path. Consequences:

- The wire bytes are decoded by nanopb into a zero-initialized struct, so a field the client
  omitted is already the proto3 default (0 / "" / has_=false) *before* the assignment.
- Scalar 0 and "absent" are therefore indistinguishable to the firmware for non-`optional` fields.
  Fields declared `optional` in the .proto get a nanopb `has_` flag and DO round-trip absence.
- **Clients must read-modify-write**: fetch the current config, mutate one field, send the whole
  sub-message back. A partial write silently wipes everything else in that variant.

This is the single most common cause of "the device cleared my setting" reports. Before blaming
firmware normalization for a zeroed field, check whether the client sent a partial sub-message.

Only the variant named by `which_payload_variant` is touched; other modules are unaffected.
Each case decides its own `shouldReboot`, then `saveChanges(SEGMENT_MODULECONFIG, shouldReboot)` runs.
