# Issue #6341 Epic: MeshCore parity deferred follow-ups

Goal: ship the six follow-ups deferred from the MeshCore parity epic (#6226, see `MESHCORE_PARITY_EPIC.md`).
One PR per phase, merged in order.

## Decisions (maintainer, 2026-11-22)

- **Feed new-node alerts:** reuse `newNodeAlertGate` (48 h learning window, 10 alerts/hour/source, "(+N more)") on
  Meshtastic MQTT (`mqtt_bridge`, `mqtt_broker`) and `meshcore_mqtt`. Meshtastic MQTT is ungated today.
- **meshcore_mqtt alerts need a verified advert signature**, whatever the global verify toggle says.
- **Reticulum:** Notifications tab with DM prefs (toggle, per-DM mute, whitelist/blacklist), bridge
  connect/disconnect server events, and new-destination alerts behind the same gate (learning window + hourly cap).
- **Sender-name override:** optional "Send as" on automated sends (Auto Responder, timers, Auto Announce, Automation
  Engine) and a composer picker. Virtual Node raw packets stay refused (#5350).
- **Clock samples:** Meshtastic (sender time vs `rxTime`, live RF only, no NodeDB replays, no MQTT) and
  `meshcore_mqtt` (verified advert time vs broker envelope time). `meshcore_mqtt` flags a node only when **two
  different observers** agree, plus the existing two-sample, once-per-episode rule.
- **GRP_TXT pipeline merge:** do it, last phase. Existing row ids do not change.

Mesh impact: no phase adds packets. Phase 4 renames existing sends; a name shortens the raw text cap, so a long
automated text may split into one more part. Phases 2, 3 add notifications, capped by the gate. Phase 5 is passive.

## Phases

- [x] **P1 — Remap moves notification prefs (#5379).** `remapChannelSlots` rewrites `user_notification_preferences`
  `enabled_channels` / `muted_channels` for the source (slot ids only, mutes keep their expiry). Exit: reorder test on
  all three backends shows prefs follow their channels.
- [x] **P2 — MQTT feed new-node alerts.** Gate Meshtastic MQTT `maybeNotifyNewNode`; add gated, signature-required
  alerts to `meshcore_mqtt` `ingestAdvert` via a shared helper extracted from `maybeAlertRepeaterNewNode`; flip the
  capability row. Exit: tests for learning window, cap, overflow, unverified advert refused.
- [x] **P3 — Reticulum Notifications.** Capability row + tab on the Reticulum page; connect/disconnect events; gated
  new-destination alerts. Exit: tab renders right rows; event tests.
- [x] **P4 — Sender-name follow-ups.** `senderName` option on `sendAutomatedText` (raw cap in split planner), editors,
  composer picker. Exit: tests for name validation, split cap, refused name.
- [x] **P5 — Clock samples.** Meshtastic and `meshcore_mqtt` samples into the protocol-neutral clock rule. Exit: tests
  for replay skip, two-observer rule.
- [x] **P6 — GRP_TXT pipeline merge.** One store path for device and MQTT channel text. Exit: existing suites pass,
  MQTT rows get `selfOrigin`, ids unchanged.

## Phase log

### P1
Shipped: `remapChannelSlots` rewrites `enabled_channels` / `muted_channels` (slot ids < 1000 only; `muteUntil` kept;
malformed JSON untouched) in the same transaction. Found while testing on MySQL: the baseline's `userId INT NOT NULL
UNIQUE` left a single-column unique index named `userId` that migration 051 never dropped, so a MySQL database could
hold only one notification-preference row per user across all sources. Migration 243 (MySQL only) swaps it for a
plain index.

### P2 (spec: `ISSUE_6341_P2_SPEC.md`)
Maintainer answer, 2026-11-22: a gate-dropped feed sighting counts as "known" for #5729 cross-source dedup (option a,
no extra code). Shipped: `newNodeAlertTracker.ts` (bounded sets + in-flight claim) and `meshcoreNewNodeAlert.ts`
(shared alert + gated helper) used by the Repeater and the MeshCore MQTT feed (broker subclass inherits); feed alerts
verify the advert signature once per new key; Meshtastic `mqtt_bridge` / `mqtt_broker` alerts pass through
`newNodeAlertGate` in `maybeNotifyNewNode` (TCP ungated); "(+N more)" suffix on `notifyNewNode`; gate's earliest-node
lookup also reads `nodes` (an old Meshtastic MQTT source arms at once on upgrade); node purge re-arms gated sources.
Feed adverts raise no automation events (#5553 precedent).

### P3 (spec: `ISSUE_6341_P3_SPEC.md`)
Maintainer answer, 2026-11-22: accept rare false new-destination alerts for peers evicted past the 2,000-row cap
(no eviction check). Shipped: Reticulum capability row (DM, new destination, server events; `nodeMonitoring:false`
hides inactive/low-battery/picker) and a Notifications view on the Reticulum page; DM pushes go through
`dispatchMessageNotification` (per-DM mute by lowercase hash, click-through to the conversation, sanitised name);
`upsertMessage` / `upsertDestination` return `{ inserted }`, so a bridge re-delivery neither notifies nor re-fires
automations; gated LXMF-delivery new-destination alerts (`reticulumNewDestinationAlert.ts`, own tracker, unnamed
peers alert under a short hash); gate earliest-row lookup also reads `reticulum_destinations`; `brokerLinkNotifier`
gained `link:'bridge'`, custom event names and a name getter, attached once per manager (bridge re-emits
`bridge-up`/`bridge-down`), 120 s grace; user Disconnect alerts at once, `stop()` is silent.

### P4 (spec: `ISSUE_6341_P4_SPEC.md`)
Maintainer answers, 2026-11-22: a name refused at run time falls back to the node's own name with one warning; senders
may read the allowed list; audit on save only. Shipped: `sendAutomatedText({ senderName })` for timers, Auto Responder,
Auto Announce (`meshcoreAutoAnnounceSenderName`) and the Automation Engine send action; split plans use the smaller of
the raw and node-name caps, so every part fits either path; `GET /api/sources/:id/meshcore/sender-names`
(`messages:write` / `automation:write` / `configuration:read`); syntax-only save checks plus a
`meshcore_sender_name_automation_set` audit row; shared `SenderNamePicker` in the editors and the channel composer
(counter uses the raw cap). Fixed: both send routes held a short override name to the node-name cap.

### P5 (spec: `ISSUE_6341_P5_SPEC.md`)
Maintainer answers, 2026-11-22: skip Meshtastic nodes with no clock; accept unauthenticated observer identity.
Shipped: `recordClockSample` (protocol-neutral subject; `detectClockOffset` wraps it); `node:clockOffset` and the
`clockOutOfSync` context carry `nodeNum`; Meshtastic samples from live LoRa telemetry/position (`clockSampleGate.ts`:
rxTime within ±120 s of server time, no replays, S&F, MQTT, proxy or Virtual Node, not the local node, plausible sender
time; offset = server time − sender time, so a wrong local radio clock stops sampling instead of flagging everyone);
`meshcore_mqtt` stores a sample only when two observers agree on sign (`MqttClockAgreement`, bounded; smaller offset
stored; signature verified once per advert). Telemetry type stays `mc_rtc_drift_secs`.

### P6 (spec: `ISSUE_6341_P6_SPEC.md`)
Maintainer answers, 2026-11-22: `selfOrigin` on MQTT feed events (sibling radios' node names + recent override names);
MQTT emits late reaction resolutions after the message, like the device. Shipped: `meshcoreChannelTextStore.ts`
(`storeDecryptedChannelText`: filter, reactions, mc1Hash, insert, `selfOrigin`, emit, after-store hook) used by both
`storeDecryptedGroupText` (device) and `ingestChannelMessage` (MQTT); `meshcoreLocalSenderNames.ts` holds the override
registry and `isLocalMeshCoreSenderName`. Id builders stay per path (`buildId`), so existing row ids are unchanged
(golden-id tests). MQTT's private `decryptGroupText` is gone; it uses `decryptGroupTextFrame`.

All six phases shipped; #6341 can close.
