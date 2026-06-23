---
name: telemetry-request-reply
description: TelemetryModule allocReply gates the reply on which_variant (device_metrics OR local_stats tag); empty Telemetry{} oneof -> NULL -> NO_RESPONSE NAK, not a reply
metadata:
  type: reference
---

Firmware: how a remote node replies to a TELEMETRY_APP (portnum 67) request.

**The gate is `which_variant`, NOT just want_response.**
`DeviceTelemetryModule::allocReply()` (src/modules/Telemetry/DeviceTelemetry.cpp) re-decodes
the request payload into a `meshtastic_Telemetry` and replies ONLY if:
- `which_variant == meshtastic_Telemetry_device_metrics_tag` -> `allocDataProtobuf(getDeviceTelemetry())`
- `which_variant == meshtastic_Telemetry_local_stats_tag` -> `allocDataProtobuf(getLocalStatsTelemetry())`
- otherwise -> `return NULL` (no reply).

So a packet whose payload is an EMPTY `Telemetry{}` with no oneof set (which_variant==0)
elicits NO telemetry reply. environment/air_quality/power tags also return NULL (device module
only answers device_metrics + local_stats).

**Framework path (src/mesh/MeshModule.cpp callModules):**
- Reply attempted when `isDecoded && mp.decoded.want_response && toUs && (!isFromUs || isToUs) && !currentReply`.
- `pi.currentRequest = &mp` set before allocReply.
- `setReplyTo()`: reply `to = getFrom(req)`, `channel = req.channel` (SAME channel in), 
  `hop_limit = routingModule->getHopLimitForResponse`, `request_id = req.id`, priority RELIABLE.
- If allocReply returns NULL AND ignoreRequest is false -> firmware sends
  `Routing_Error_NO_RESPONSE` NAK via routingModule->sendAckNak. So an empty-oneof request
  is NOT silent — it returns a NO_RESPONSE routing NAK. (Useful diagnostic: a NAK with
  NO_RESPONSE means "got it, but I have no reply for that variant".)
- `ignoreRequest` (set true by allocReply for multi-hop broadcast telemetry requests from
  non-sensor/non-router roles) suppresses the NAK -> truly silent drop in that one case.

**isMultiHopBroadcastRequest + isSensorOrRouterRole guard:** broadcast telemetry request that
arrived multi-hop is ignored (no reply, no NAK) unless local role is sensor or router.

**Client side (meshtastic/python sendTelemetry + __main__ --request-telemetry):**
- Maps type -> oneof field; default telemetryType = "device_metrics".
- For device: `r.device_metrics.battery_level = ...` (assigning a field SETS the oneof /
  which_variant to device_metrics_tag). Sends with wantResponse=True, on channelIndex, dest=node.
- KEY: assigning ANY device_metrics field (even via CopyFrom of an empty DeviceMetrics) sets
  which_variant. A client that sends Telemetry with NO field assigned does NOT set which_variant
  and will get a NAK instead of telemetry. To force the oneof on an empty submessage in
  protobuf, use SetInParent() on the device_metrics field.

handleReceivedProtobuf in same file only INGESTS inbound device_metrics broadcasts
(updateTelemetry) and returns false; it does NOT generate replies. Replies are allocReply only.
