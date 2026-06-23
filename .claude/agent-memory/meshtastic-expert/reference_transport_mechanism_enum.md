---
name: transport-mechanism-enum
description: MeshPacket.transport_mechanism (field 21) enum values; MQTT re-injection preserves original packet id (does NOT regenerate)
metadata:
  type: reference
---

## MeshPacket.transport_mechanism (mesh.proto field 21)

Enum `TransportMechanism` (added relatively recently; firmware-internal, marks how a packet ARRIVED):
- `TRANSPORT_INTERNAL = 0` — node generated the packet itself
- `TRANSPORT_LORA = 1` — arrived via primary LoRa radio
- `TRANSPORT_LORA_ALT1 = 2`
- `TRANSPORT_LORA_ALT2 = 3`
- `TRANSPORT_LORA_ALT3 = 4`
- `TRANSPORT_MQTT = 5` — arrived via an MQTT connection
- `TRANSPORT_MULTICAST_UDP = 6`
- `TRANSPORT_API = 7`

So **transport_mechanism == 1 means TRANSPORT_LORA (heard over the air on primary LoRa radio), NOT MQTT.** MQTT is 5.

Related fields on MeshPacket:
- `via_mqtt = 14` (bool) — packet passed via MQTT somewhere along its path
- `hop_start = 15`, `relay_node = 19` (last byte of relaying node), `next_hop = 18`
- `rx_rssi = 12`, `rx_snr` — both 0 when packet originated from MQTT (no RF reception)
- `pki_encrypted = 17`, `public_key = 16`

NodeInfoLite also has `via_mqtt = 8` ("witnessed the node over MQTT instead of LoRA").

## MQTT re-injection (downlink) PRESERVES packet id

`src/mqtt/MQTT.cpp` `onReceiveProto()` (master):
- Line 119: `p->id = e.packet->id;` — copies the ORIGINAL packet id from the ServiceEnvelope.
- Line 124: `p->via_mqtt = true;`
- Line 125: `p->transport_mechanism = TRANSPORT_MQTT;`
- Then `router->enqueueReceivedMessage(p.release())`.

Implication: an MQTT->LoRa downlink does NOT generate a new packet id. The mesh-level dedup (PacketHistory, keyed on from+id) is exactly what suppresses re-broadcast of an already-seen id. So "same payload, DIFFERENT packet id" is NOT explained by simple MQTT re-injection of one original packet.

## Store & Forward does NOT cache telemetry

`src/modules/StoreForwardModule.cpp`: historyAdd is gated on `mp.decoded.portnum == TEXT_MESSAGE_APP` (line ~399). Telemetry (portnum 67) is never stored, so S&F can never replay it. Rules out S&F as a source of ghost telemetry.

ServiceEnvelope (mqtt.proto): `packet=1`, `channel_id=2` (global channel id), `gateway_id=3` (the node id of the gateway that uplinked — use this to identify WHICH node bridged it).
