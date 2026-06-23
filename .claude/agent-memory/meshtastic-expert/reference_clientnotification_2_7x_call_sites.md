---
name: clientnotification-2-7x-call-sites
description: Complete enumeration of every FromRadio.clientNotification (mesh.proto field 16) emitter in firmware 2.7.25, with level/text/trigger/frequency — for a TCP observer (MeshMonitor) deciding what to toast
metadata:
  type: reference
---

Verified against firmware tag **v2.7.25.104df5f** and protobufs tag **v2.7.25** (2026-06).

## Proto structure (mesh.proto, ClientNotification)
- `optional uint32 reply_id = 1` (has_reply_id when set)
- `fixed32 time = 2` (epoch secs, 0 = unknown)
- `LogRecord.Level level = 3` — enum: UNSET=0, TRACE=5, DEBUG=10, INFO=20, WARNING=30, ERROR=40, CRITICAL=50
- `string message = 4` (free text; firmware buffers ~max 250-ish)
- `oneof payload_variant`: key_verification_number_inform=11, key_verification_number_request=12, key_verification_final=13, **duplicated_public_key=14, low_entropy_key=15**
- NO source/subsystem identifier. Only level + free text + optional reply_id + optional structured key-verification variant. Caller subsystem is NOT identifiable except by parsing message text.
- **duplicated_public_key (14) and low_entropy_key (15) variants EXIST in v2.7.25 proto but are NOT populated by v2.7.25 firmware** (those structured handlers are develop/2.8). The duplicate-key warning in 2.7.x uses free-text message only.

## Delivery path
`clientNotificationPool.allocZeroed()` -> set fields -> `service->sendClientNotification(cn)` -> `MeshService::toPhoneClientNotificationQueue` (StaticPointerQueue, cap MAX_RX_NOTIFICATION_TOPHONE) -> drained by `PhoneAPI::getFromRadio` as `FromRadio.clientNotification` (field 16). If phone not connected and queue fills, oldest dropped.

## RECURRING / NOISY (auto-toast would annoy) — fires unprompted in normal operation
1. **Router.cpp:311** duty-cycle abort. WARNING. `"Duty cycle limit exceeded. You can send again in %d mins"`. has_reply_id = aborted packet id. Fires EVERY time a send is attempted while over regional duty cycle (override_duty_cycle off, region dutyCycle<100, e.g. EU868). Can repeat rapidly per-packet during heavy tx. **Most likely to be noisy.**
2. **PositionModule.cpp:379** INFO. `"Sending position and sleeping for %us interval in a moment"`. ONLY when role==TRACKER/TAK_TRACKER AND power.is_power_saving. Fires on EVERY position broadcast cycle (recurring, timer-driven). Noisy for power-save trackers.
3. **EnvironmentTelemetry.cpp:660** INFO. `"Sending telemetry and sleeping for %us interval in a moment"`. ONLY role==SENSOR AND power.is_power_saving. Every telemetry cycle.
4. **AirQualityTelemetry.cpp:418 AND :432** INFO, same message as #3. **BUG: emitted TWICE per cycle** (duplicated if-block) for role==SENSOR + power_saving. Recurring.
5. **PhoneAPI.cpp:808** WARNING. `"TraceRoute can only be sent once every 30 seconds"`. reply_id set. Fires when phone/app sends traceroute within 30s of last. User-action-driven but app-spammable.

## ONE-SHOT / RARE (safe to toast)
6. **NodeDB.cpp:1859** WARNING. `"Remote device %s has advertised your public key. This may indicate a compromised key..."`. Gated by `duplicateWarned` bool — **once per boot max**. Security-relevant; good toast candidate.
7. **PhoneAPI.cpp:813** WARNING. `"Multi-hop traceroute to broadcast address is not allowed"`. reply_id set. Only on that specific bad request.
8. **RadioInterface.cpp:817** ERROR. region-too-narrow, e.g. `"%s region too narrow for 500kHz preset (%s). Falling back to LongFast."` or `"%s region span %.0fkHz < requested %.0fkHz. Falling back to LongFast."`. Fires at radio init when LoRa config invalid for region. Effectively boot/config-change only.

## ADMIN-/CONFIG-ACTION GATED (only fire in response to a user/admin command, never unprompted)
All via `AdminModule::sendWarning` (WARNING) or `sendWarningAndLog`:
9. handleSetOwner / handleSetChannel / handleConvertToLicensed (AdminModule.cpp:617,1026,1424) — `licensedModeMessage` = `"Licensed mode activated, removing admin channel and encryption from all channels"`. Only when toggling is_licensed / setting channel while licensed.
10. handleSetConfig device (AdminModule.cpp:666) — `"Rebroadcast mode can't be set to NONE for a router role"`. Only on that bad config set.
11. handleSetConfig security (AdminModule.cpp:894) — `"You must provide at least one admin public key to enable managed mode"`. Only on bad managed-mode set.
12. OTA handler (AdminModule.cpp:243-278, sendWarningAndLog) — ESP32 only, several: `"Cannot start OTA: Invalid ota_hash provided."`, `"...Cannot find OTA Loader partition."`, `"...Device does have a valid OTA Loader."`, `"OTA Loader does not support %s"`, `"Rebooting to %s OTA"`, `"Unable to switch to the OTA partition."`. Only on ota_request admin msg.

## CONFIG-VALIDATION ON SETTING SAVE (admin/config action)
13. **MQTT.cpp:677** WARNING `"Could not reach the MQTT server. Settings will be saved, but please verify..."` (fires on MQTT config save if test TCP connect fails — connectivity dependent, could repeat per save).
14. **MQTT.cpp:693** ERROR `"Invalid MQTT config: proxy_to_client_enabled must be enabled on nodes that do not have a network"` (no-networking builds).
15. **MQTT.cpp:709** ERROR `"Invalid MQTT config: default server address must not have a port specified"`.
16. **SerialModule.cpp:98** ERROR `"Invalid Serial config: override console serial port is only supported in NMEA and CalTopo output-only modes."`. On serial config save.

## KEY VERIFICATION (structured variants — only during a user-initiated key-verification flow)
17. **KeyVerificationModule.cpp:70,102,199,263** WARNING, with payload_variant set (key_verification_number_request / _final / _number_inform). Messages like `"Enter Security Number for Key Verification"`, `"Final confirmation for incoming manual key verification ..."`. Only during the manual key-verification handshake the user explicitly started. These carry structured payload — app should handle as a flow, NOT a plain toast.

## EXCLUDED (NOT ClientNotification — common confusion)
- StoreForwardModule::sendErrorTextMessage — sends a TEXT_MESSAGE_APP mesh packet ("S&F - Busy...", "S&F not permitted on the public channel."), NOT a ClientNotification.
- PaxcounterModule::sendInfo — mesh packet, not a notification.
- PhoneAPI.cpp position/text rate-limit sendNotification calls (lines 826,834) are COMMENTED OUT in 2.7.x — they do NOT fire. Only the two traceroute ones (#5, #7) are live.

## Toast-policy recommendation for MeshMonitor
- Suppress/throttle by message text: #1 (duty cycle), #2/#3/#4 (power-save "sleeping" infos). These are the unprompted recurring ones.
- The "level" field alone is insufficient to distinguish noisy from important (both INFO and WARNING appear in recurring set). Must inspect message text or build an allow/deny list, since proto carries no subsystem id.
- PhoneAPI::sendNotification hardcodes level=WARNING ignoring its `level` arg — minor firmware quirk.
