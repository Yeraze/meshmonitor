---
name: want-ack-dm-routing-acks
description: A want_ack DM yields TWO Routing ACKs both with error_reason=NONE and same request_id — self/transmit (from==local node) first, destination end-to-end (from==dest node) second. Match by `from`, not request_id alone.
metadata:
  type: reference
---

For a `want_ack` DM (TEXT_MESSAGE_APP or any), the local node can deliver TWO ROUTING_APP packets to a connected client via FromRadio, BOTH `error_reason=NONE` and BOTH `request_id == sent packet id`, distinguished ONLY by `from`:

1. **Self/transmit implicit ACK — `from == our local node num`, arrives FIRST.** Generated in `ReliableRouter::shouldFilterReceived` when our node overhears a neighbor rebroadcasting our own packet: `if (p->from == getNodeNum()) { ... sendAckNak(Routing_Error_NONE, getFrom(p), p->id, old->packet->channel); stopRetransmission(key); }`. Comment literally says "Generate implicit ack". Proves only that the packet entered the mesh, NOT that the target got it. Airtime optimization so originator stops retransmitting.

2. **End-to-end ACK — `from == destination node num`, arrives SECOND (or never).** Generated on the destination when `isToUs(p)` && `want_ack` → `sendAckNak(Routing_Error_NONE, getFrom(p), p->id, ...)`. Originates at destination so `from`==dest. This is the genuine delivery confirmation.

Why both share request_id: `MeshModule::allocAckNak` (src/mesh/MeshModule.cpp:48-71) sets `decoded.request_id = idFrom` (= original packet id) and leaves `from` unset (0 → stamped to the originating node num by the send path). So self-ACK gets from==local, dest-ACK gets from==dest, both request_id==sent id.

**error_reason=NONE (0) means success for BOTH** transmit-confirmation and end-to-end delivery. Genuine FAILURE = a NAK (non-zero error_reason) from the ORIGINATING node: `MAX_RETRANSMIT` (reliable retransmit exhausted = DM delivery failed — the key negative signal), `NO_RESPONSE`, `NO_CHANNEL`, `PKI_UNKNOWN_PUBKEY`/`PKI_FAILED`, etc. (enum `Routing.Error` in mesh.proto).

**For round-trip connectivity to a specific node: the correct positive signal is the end-to-end ACK where `from == destination node num`. IGNORE any Routing ACK where `from == local node num` (transmit-only).** Matching purely by `request_id` (ignoring `from`) is a BUG — it latches onto the self-transmit ACK first and treats it as the response. Count is topology-dependent: multi-hop/flood almost always produces the self-ACK first; zero-hop direct link may produce only the dest ACK. Next-hop routing: a relay (not the dest) can also produce a Routing NONE with from==relayer — same rule, only from==dest counts.

Verified firmware master. See also [[admin-set-favorite-ack]] for the admin-path implicit-vs-explicit ACK distinction.
