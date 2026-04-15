---
name: NodeInfo.channel field semantics
description: NodeInfo.channel (field 7) is the local channel index we heard a node on — it is local state, never shared-channel hint
type: reference
---

`NodeInfo.channel` (uint32, field 7) in `meshtastic/mesh.proto` is defined as:

> "local channel index we heard that node on. Only populated if its not the default channel."

It is **local state on the receiving node**, not a field transmitted by the remote node about itself, and it is **not** a "shared channel" hint. It is the channel index on which the receiver first decrypted/heard a NODEINFO_APP packet from that node.

**Firmware population** (`src/mesh/NodeDB.cpp`, `NodeDB::updateUser`):
```cpp
if (nodeId != getNodeNum())
    info->channel = channelIndex; // Set channel we need to use to reach this node (but don't set our own channel)
```
`channelIndex` is the index of the local Channel whose PSK successfully decrypted the incoming NODEINFO_APP packet.

**Consumption** (`src/mesh/NodeDB.cpp`, `NodeDB::getMeshNodeChannel`):
```cpp
uint8_t NodeDB::getMeshNodeChannel(NodeNum n) {
    const meshtastic_NodeInfoLite *info = getMeshNode(n);
    if (!info) return 0; // defaults to PRIMARY
    return info->channel;
}
```
Header comment: "get channel channel index we heard a nodeNum on, defaults to 0 if not found".

**Implications for MeshMonitor / clients:**
- Do NOT interpret `NodeInfo.channel` as "a channel we have in common with that node" in any global/mesh sense.
- It is only meaningful relative to the **local** device's channel table (index into `channelFile.channels`).
- When sent via PhoneAPI to a phone client, it tells the phone: "to DM this node, use local channel index N".
- It is NOT populated on NodeInfo broadcast over the air — it is stored in `NodeInfoLite` on the receiving device only. The on-air NodeInfo payload is just the `User` subfield; the `channel` field lives in the phone-facing `NodeInfo` wrapper.
- `NodeDB::updateFrom(MeshPacket)` does NOT update `channel` from rx — only `updateUser` (called when a NODEINFO_APP packet with User is received) sets it, using the channel index that decrypted the packet.

**Sources:**
- https://github.com/meshtastic/protobufs/blob/master/meshtastic/mesh.proto (message NodeInfo, field 7)
- https://github.com/meshtastic/firmware/blob/master/src/mesh/NodeDB.cpp (`updateUser`, `getMeshNodeChannel`)
- https://github.com/meshtastic/firmware/blob/master/src/mesh/NodeDB.h (comment on `getMeshNodeChannel`)
