---
name: admin-set-favorite-ack
description: set_favorite_node/remove_favorite_node ACK behavior — routing ACK + explicit Routing_NONE reply via want_response; no admin-app response of its own
type: reference
---

Remote admin `set_favorite_node`/`remove_favorite_node` (admin.proto fields 39/40) ACK behavior in firmware `src/modules/AdminModule.cpp`:

- These are SETTERS, NOT in `messageIsRequest()` (lines ~1546-1561). So `handleReceivedProtobuf` requires a valid session passkey (lines 135-141): missing/expired/wrong key => `allocErrorResponse(ADMIN_BAD_SESSION_KEY)` returned to sender (a Routing error / NAK).
- The `set_favorite_node` case (lines 392-401) sets the NODEINFO_BITFIELD_IS_FAVORITE_MASK bit and calls `saveChanges(SEGMENT_NODEDATABASE, false)` => `service->reloadConfig` => `saveToDisk` immediately (unless an open edit transaction is pending, then deferred to commit). It sets NO `myReply` of its own — no admin-app response payload.
- Whether an explicit application-layer ACK is sent depends ENTIRELY on `mp.decoded.want_response`. Line 587-589: `if (mp.decoded.want_response && !myReply) myReply = allocErrorResponse(Routing_Error_NONE, &mp);` => an explicit Routing message with error_reason=NONE (request_id = original packet id). This IS a positive ACK proving the packet reached AdminModule, passed the passkey check, and was processed.
- If the node doesn't exist in its NodeDB (`getMeshNode` returns NULL), the bit is silently NOT set, NOT saved — but want_response still yields a Routing_Error_NONE ACK. So ACK does NOT strictly prove the favorite stuck if the target node is unknown to the remote.

Routing-layer ACK (independent of AdminModule) in `src/mesh/ReliableRouter.cpp::sniffReceived` (lines 92-130): if packet `want_ack` AND `isToUs(p)` AND no module produced a reply (`!MeshModule::currentReply`, line 95), firmware sends `sendAckNak(Routing_Error_NONE,...)`. But when want_response produced the admin Routing reply, currentReply is set, so the router suppresses its duplicate ACK (line 131-132 "Another module replied, no need for 2nd ack"). IMPLICIT ack = overheard rebroadcast (intermediate hops, ReliableRouter.cpp ~54-61). EXPLICIT ack = the Routing message above.

MeshMonitor: `protobufService.createAdminPacket` (src/server/protobufService.ts ~1908-1929) sets BOTH `wantResponse: true` on Data AND `wantAck: true` on MeshPacket for EVERY admin command incl. favorites. So MeshMonitor DOES receive an explicit Routing_Error_NONE ACK (request_id = sent packet id) for remote set/remove favorite. The "no ACK / blind" premise is FALSE for MeshMonitor's own send path.

What the ACK guarantees: packet reached the destination node's AdminModule, passkey accepted, command processed. It does NOT independently confirm the favorite bit persisted if the favorited node is unknown to the remote's NodeDB. NAK cases: ADMIN_BAD_SESSION_KEY (wrong/expired passkey), ADMIN_PUBLIC_KEY_UNAUTHORIZED (PKI sender not in admin_key list), NOT_AUTHORIZED.
