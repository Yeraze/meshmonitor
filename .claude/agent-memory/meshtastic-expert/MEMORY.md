# Meshtastic Expert Memory

## Research method
- [Firmware branches and fetching](firmware_branches_and_fetching.md) — `develop`=2.8, `master`=2.7; raw.githubusercontent works, api.github.com is 403-scoped
- [Firmware PhoneAPI source locations](reference_firmware_phoneapi_files.md) — key file paths/functions for PhoneAPI / StreamAPI / Heartbeat work

## Admin & config
- [set_module_config is replace, not merge](admin_module_config_semantics.md) — omitted fields get wiped to proto3 defaults, for every module
- [set_favorite_node ACK behavior](reference_admin_set_favorite_ack.md) — routing ACK + Routing_NONE via want_response; no admin-app response of its own
- [traffic_management admin gap](reference_traffic_management_admin_gap.md) — proto field 15 exists but no admin set-handler shipped through 2.7.25
- [LoRa tx_power clamping](reference_lora_tx_power_clamping.md) — proto type, valid range, negative-value handling

## Modules & portnums
- [MeshBeacon module (portnum 37)](meshbeacon_module.md) — field numbers, 3600s interval floor, offer-region clearing rules, PhoneAPI PSK redaction
- [Store and Forward module](reference_store_forward_module.md) — PortNum 65, message types, PSRAM storage, replay format, config fields
- [Telemetry request/reply](reference_telemetry_request_reply.md) — empty Telemetry{} oneof yields a NO_RESPONSE NAK, not a reply

## Nodes & NodeDB
- [NodeInfo.channel semantics](reference_nodeinfo_channel_field.md) — field 7 is local channel index, never a shared-channel hint
- [Two ignore mechanisms](reference_ignored_nodes_two_mechanisms.md) — config.lora.ignore_incoming vs NodeInfoLite.is_ignored
- [NodeDB warm store PR #10705](reference_nodedb_warmstore_pr10705.md) — 3-tier NodeDB + snr_q4; which parts are on-disk vs over-the-air

## Packets, routing, crypto
- [PKI DM crypto scheme](reference_pki_dm_crypto_scheme.md) — X25519 ECDH + SHA-256 + AES-256-CCM, nonce layout, wire format
- [want_ack DM yields TWO routing ACKs](reference_want_ack_dm_routing_acks.md) — match by `from`, not request_id alone
- [transport_mechanism enum](reference_transport_mechanism_enum.md) — field 21 values; MQTT re-injection preserves the original packet id

## Phone API client behavior
- [Heartbeat reply mechanism](project_phoneapi_heartbeat_reply.md) — every ToRadio.heartbeat gets a FromRadio.queueStatus; deterministic liveness pong
- [PhoneAPI connection timeouts](reference_phoneapi_timeouts.md) — serial is 15 min inactivity; TCP uses socket state
- [ClientNotification call sites in 2.7.x](reference_clientnotification_2_7x_call_sites.md) — every emitter with level/text/trigger/frequency
