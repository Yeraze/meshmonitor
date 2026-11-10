# Spec: #6316, split long MeshCore messages in Auto Responder, Timer Triggers, Auto Announce and the Automation Engine send-message action

## Maintainer decisions (2026-11-10, binding)
Q1: max 3 parts (shared constant, replaces AUTO_ACK_SPLIT_MAX_PARTS). Q2: fixed 10 s gap between parts; chat parts do NOT stamp recordMeshTx. Q3: per-source split mutex so (i/N) sequences never interleave. Q4: split-enabled timers must have an interval of at least 5 minutes (enforced server-side + UI warning). Q5: scripts split only single-message output. Q6: no Meshtastic multiline change in this issue (open a follow-up). Q7: with split off, all four senders truncate to the cap app-side. #6303 has merged: src/utils/meshcoreMessageLimits.ts and the sync autoAckReplyByteCap are on main (WP0 done).


Repo is at main `f0b325a63`. Line numbers refer to that commit. This was a read-only investigation; no files were changed.

## Findings

### Splitter and caps that already exist
- **The shared splitter is already pure and protocol-neutral.** `src/server/utils/splitUtf8Message.ts:117` `splitUtf8Message(text, {maxBytes, maxParts})`:
  - Counts UTF-8 bytes and cuts on grapheme boundaries.
  - Break preference is: line break, then sentence end, then punctuation, then space, then hyphen (`findBreakIndex` :64).
  - Adds a `(i/n) ` marker (`partMarker` :53). The marker size is reserved up front for `maxParts`.
  - Truncates the last allowed part and returns `truncated`. `maxParts: 1` means truncate only.
  - No IO, no timers. Also exports `truncateUtf8Bytes` :26 and `utf8ByteLength` :18. Tests: `src/server/utils/splitUtf8Message.test.ts`.
- **The Auto Ack split is the only MeshCore user today.** `src/server/meshcoreManager.ts:14527-14572`:
  - Gets the cap from `autoAckReplyByteCap` (:14591).
  - `maxParts` is `AUTO_ACK_SPLIT_MAX_PARTS = 3` (:14579) when `meshcoreAutoAckSplitLongMessages` is on, otherwise 1. With the toggle off it truncates.
  - Waits a fixed `AUTO_ACK_SPLIT_PART_DELAY_MS = 10_000` (:14582) between parts. The wait is outside the send lock.
  - Re-checks `canTransmit()` before every part and stops at the first failed part.
  - Tests: `src/server/meshcoreManager.autoAckSplit.test.ts`.
  - Settings: the key is in `src/server/constants/settings.ts:461` (valid keys) and :772 (per-source keys). Route: `src/server/routes/meshcoreAutomationRoutes.ts:841/866/897/964`. UI: `src/components/MeshCore/MeshCoreAutoAckSection.tsx:511-543`, with a warning text that already states "up to 3 messages, 10 seconds apart" (locale `public/locales/en.json:7344-7347`).
- **Current caps on main.** `src/server/constants/meshcoreMessageLimits.ts:13-27`: DM 150, channel 130, scoped channel 120.
- **#6303/#6304 work in progress** (worktree `.claude/worktrees/i6303`, branch `fix/6303-meshcore-message-caps`, not yet committed):
  - Moves the caps into a new shared client+server module `src/utils/meshcoreMessageLimits.ts`. It exports `meshcoreMessageByteCap({isDm, nodeName})`, which gives DM 160 and channel `160 - (nameBytes + 2)`.
  - Falls back to a 31-byte worst-case name (cap 127) when the name is unknown. Scope no longer affects the cap.
  - The server constants file re-exports it, and `autoAckReplyByteCap(sendAsDM)` becomes sync and uses `this.localNode?.name`. **This design builds on that helper.**

### Meshtastic reference ("multiline")
- `src/server/meshtasticManager.ts:14049-14104`.
- Applies only when the trigger has `multiline` and the parsed response is a single message. Multi-response JSON bypasses it and each item is truncated to 200.
- Splitter is `splitMessageForMeshtastic` (:14241). It uses a 200-byte cap, has **no part limit and no marker**, and paces parts through `messageQueueService` `SEND_INTERVAL_MS = 30000` (`src/server/messageQueueService.ts:45`).
- Meshtastic timers, announce and the automation engine **truncate** to 200 and never split (`meshtasticManager.ts:4678, 5168`; `meshActionDeps.ts:118-124`).
- So splitting in MeshCore timers, announce and the automation engine goes beyond Meshtastic parity. Auto Responder is the only true parity item.
- UI: `src/components/auto-responder/TriggerEditor.tsx:381-391`, plus the chip at `AutoResponderSection.tsx:451`.

### The four MeshCore senders today
None of them cap or split. The text goes whole to `sendMessage`, and the firmware silently cuts channel text. The stored row then differs from what went on air.
1. **Auto Responder**, `meshcoreManager.ts:13867-14003`.
   - `dispatch` closure at :13940 is used by both the text path (:13995) and the script path via `runMeshCoreScript` (:13813), which sends each `wouldSendMessages` entry (:13831).
   - Cooldown is per `trigger.id:sender` and is stamped at match time, before the send (:13926-13932). Pre-send delay :13956.
   - Trigger type: `MeshCoreAutoResponderTrigger` :550. It is stored as raw JSON in `meshcoreAutoResponderTriggers`; the route at `meshcoreAutomationRoutes.ts:1306-1349` only validates patterns, so a new boolean field persists with no migration.
2. **Timer Triggers**, `runTimerTrigger` at :13601-13687.
   - `dispatch` :13620 sends to each channel in `channelIndexes` back to back (#6230), or to a DM.
   - Script path :13658, text path :13663.
   - Interval minimum is 1 minute (:13551). Type at :600. Route at `meshcoreAutomationRoutes.ts:1217-1249` keeps the raw JSON (`keepServerRunState`).
3. **Auto Announce**, `runAutoAnnounceCycle` at :13405-13494.
   - One `sendMessage` per channel in `meshcoreAutoAnnounceChannelIndexes` (:13449).
   - Interval 1-168 h (`src/server/utils/schedulerInterval.ts:38`), or a cron schedule.
   - Settings route: `meshcoreAutomationRoutes.ts:992-1140`.
4. **Automation Engine `action.sendMessage`**.
   - `src/server/services/automation/actionExecutor.ts:406-573` loops over sources and channels. Each call goes to `deps.sendMessage` and then `meshActionDeps.ts:197-214` (MeshCore branch: `raw.sendMessage(text, toPublicKey, channel, scopeOverride, true)`, with no cap).
   - The engine's `rateLimit` (`automationEngineService.ts:92`) counts fires/actions, not packets.
   - Catalog field list: `src/components/automations/catalog.ts:736-776`.

### TX gap and pacing
- `lastMeshTxAt` (`meshcoreManager.ts:1994`, `getLastMeshTxAt`/`recordMeshTx` :11840-11852) is the 60 s floor shared by **scheduled RF operations**:
  - telemetry, neighbours, time sync, room sync, auto ping, remote repeater, and contacts routes (`services/meshcore*Scheduler.ts`, `routes/meshcoreContactsRoutes.ts:1202`).
  - **Chat sends neither check nor stamp it.** `sendMessage` → `runSerialized` (:6419) is only a per-source scope lock with no gap. Multi-channel announce/timer sends go back to back.
- So "respect the per-source TX gap" in the issue cannot mean the 60 s floor without a new decision (Open question Q2).
- **Auto-retry (#3979).** Automated channel sends pass `autoRetryOnMiss=true`. When the global opt-in is on, a part that no repeater was heard relaying is re-sent once (`maybeArmChannelRetry` :6671). The worst case is 2 origin transmissions per part.

### Repeater sources
`sendMessageWithResult` refuses on `REPEATER` (:6303). Announce and timers also skip repeaters (:13415, :13603). The issue's "cover Repeater" therefore has nothing to cover: only Companion sources can send these messages.

## Design (shared pieces first)

### S1. Server: one shared paced split-send helper
Every MeshCore text sender uses it, and Auto Ack is refactored onto it.
- Put the pure planner next to the splitter, e.g. `splitUtf8Message.ts` or a new `src/server/utils/meshcoreSplitPlan.ts`:
  - `planMeshCoreTextParts(text, {isDm, nodeName, split}) → {parts, truncated, maxBytes}`.
  - It calls `meshcoreMessageByteCap` (the #6303 helper) and `splitUtf8Message` with `maxParts = split ? MESHCORE_SPLIT_MAX_PARTS : 1`.
  - Constants go in the #6303 module `src/utils/meshcoreMessageLimits.ts`, so the UI can show them: `MESHCORE_SPLIT_MAX_PARTS` and `MESHCORE_SPLIT_PART_GAP_MS` (values from Q1/Q2).
- Add one manager method, `MeshCoreManager.sendAutomatedText(text, opts)`:
  - `opts = { toPublicKey?: string; channelIdxs?: number[]; scopeOverride?; split: boolean; label: string }`.
  - It builds the plan once, using the DM cap when `toPublicKey` is set and otherwise the channel cap from `localNode.name`.
  - Send order is **by part**: part *i* goes to every target channel back to back (keeps today's #6230 multi-channel behaviour), then the gap, then part *i+1*.
  - The gap is awaited outside `runSerialized`.
  - Before every part it checks `canTransmit()` and `connected`.
  - A target whose part fails is dropped from later parts. Stop when no targets remain.
  - Returns `{ok, sentParts, totalParts, truncated, perTarget}`.
  - When truncated it logs a warning, using the same text as Auto Ack today.
  - Channel sends pass `autoRetryOnMiss=true`, as now.
- Refactor Auto Ack (:14527-14572) to call it. The two `AUTO_ACK_SPLIT_*` constants become aliases of the shared ones, so its behaviour does not change if Q1/Q2 keep 3 parts and 10 s.
- **Behaviour change even with split off:** all four senders now truncate to the cap app-side, as Auto Ack does. No extra packets, and the stored row now matches the air.

### S2. Client: one shared toggle component
- New `src/components/shared/automation/SplitLongMessagesField.tsx`.
- Props: `checked`, `onChange`, `disabled`, `id`, `protocol: 'meshcore' | 'meshtastic'`, and optional `perTargetCount` for the multi-channel warning.
- It renders the label, the description (caps from the #6303 shared module, so the text cannot drift) and the airtime warning. The warning uses the shared constants: "up to N messages, G s apart, marked (1/N); each is repeated by every repeater in range; × channels".
- Users:
  - `MeshCoreAutoAckSection.tsx:511-543` (replaces the inline markup)
  - `MeshCoreResponderTriggerEditor.tsx`
  - `MeshCoreTimerTriggerEditor.tsx`
  - `MeshCoreAutoAnnounceSection.tsx`
  - Optionally the Meshtastic `TriggerEditor.tsx:381-391` with `protocol='meshtastic'`, which keeps its existing semantics (epic "one implementation" rule).
- Add a "Split" chip in `MeshCoreAutoResponderSection.tsx` near :451, matching the Meshtastic `badge_multiline`.

### S3. Per-sender wiring
- **Responder:** add `multiline?: boolean` to `MeshCoreAutoResponderTrigger`. The field name matches the Meshtastic trigger shape.
  - `dispatch` calls `sendAutomatedText(text, {…, split: trigger.multiline && allowSplit})`.
  - Text responses: split allowed.
  - Script responses: split only when the script emits exactly one message, otherwise truncate each (mirrors Meshtastic's single-response rule). To do this, `runMeshCoreScript` passes the message count to `dispatch`, or the responder checks `wouldSendMessages.length`.
- **Timer:** add `multiline?: boolean` to `MeshCoreTimerTrigger`. `dispatch` calls `sendAutomatedText(text, {channelIdxs | toPublicKey, split})`. Script rule as for the responder.
- **Announce:** new per-source key `meshcoreAutoAnnounceSplitLongMessages`.
  - Add it to `VALID_SETTINGS_KEYS` and `PER_SOURCE_SETTINGS_KEYS` (`settings.ts` ~:468/:779) and to the GET/POST routes (`meshcoreAutomationRoutes.ts:992-1140`).
  - `runAutoAnnounceCycle` makes one `sendAutomatedText(rendered, {channelIdxs, split})` call. The returned `sent` counts channels where every part went out.
- **Automation Engine:** new `splitLongMessages` checkbox in `catalog.ts` (advanced; help text "MeshCore only"; the shared warning text as `warning`).
  - `actionExecutor` passes it through `deps.sendMessage({… splitLongMessages})`. Add it to the `ActionDeps.sendMessage` type at `actionExecutor.ts:35`.
  - The `meshActionDeps` MeshCore branch calls `sendAutomatedText` when it is available.
  - Meshtastic and Reticulum ignore it. Meshtastic keeps truncating to 200.
  - The step result stays one result per target, with `parts`/`truncated` added.
  - The simulator/tester never sends, so it reports the planned part count from `planMeshCoreTextParts`.

## Mesh impact

**Packet size of a full part.** Channel GRP_TXT is header 1 + path_len 1 + channel hash 1 + MAC 2 + AES-padded (timestamp 4 + flags 1 + "name: text" up to 160 → 176), about **181 B**. A DM is about the same (182 B). Scoped sends add 4 B, and each hop adds 1 path byte.

**Airtime per full part,** from `src/utils/loraAirtime.ts` (MeshCore preamble model):

| Preset | 1 full part (181 B) | 3 parts, origin only | 3 parts × (1 + 10 repeaters) |
|---|---|---|---|
| US/CA recommended SF7 / BW62.5 / CR5 | 633 ms | 1.9 s | 20.9 s |
| EU/UK narrow SF8 / BW62.5 / CR8 | 1.69 s | 5.1 s | 55.7 s |
| Legacy SF10 / BW250 / CR5 | 873 ms | 2.6 s | 28.8 s |
| Slow SF11 / BW125 / CR8 | 5.84 s | 17.5 s | 193 s |

**Transmissions per fire.** Parts N (≤ max) × targets C (channels; sources × channels for the automation engine) × (1 origin + R repeaters reached by the flood). A scoped flood reaches only repeaters that carry the region. Auto-retry can add up to N × C more origin sends.

**Text per split.** With 3 parts and a 12-byte node name: channel (146 − 6 marker) × 3 = 420 B; DM 154 × 3 = 462 B.

**Worst cases:**
- **Timer:** 1-minute interval × 4 channels × 3 parts = 12 sends/min from our node alone.
  - US preset: 7.6 s/min (13% duty).
  - EU narrow: 20 s/min (34% duty). That is over the EU 869.4-869.65 MHz 10% duty limit **before** any repeater traffic. This is the most dangerous combination. Today, without split, the same timer is 11%.
- **Responder:** cooldown 0 on a busy channel triples reply airtime per match. Two MeshMonitor instances whose responders match each other's replies already loop today; split multiplies the loop by N. Script output of K messages would be K × N without the single-message rule in S3.
- **Automation engine:** a message trigger with no cooldown, × sources × channels × N. `rateLimit` caps fires, not packets.
- **Announce:** at most 1 per hour × C × N. Low.

**Spam to users.** Parts carry `(i/N)` markers, so receivers can see the sequence. Interleaving between sequences (Q3) is the main readability risk.

## Open questions (limits for the maintainer to choose)

**Q1. Maximum parts per message.**
- (A) 3 for every sender, the same as Auto Ack. **Recommended.**
- (B) 5.
- (C) Configurable 2-5 per trigger.
- With A, the shared constant replaces `AUTO_ACK_SPLIT_MAX_PARTS`.

**Q2. Gap between parts.**
- (A) Fixed 10 s, the same as Auto Ack. **Recommended.**
- (B) Airtime-scaled: `max(10 s, k × estimated part airtime)` from the node's radio params, e.g. k = 8 → about 14 s on EU narrow and 47 s on SF11.
- (C) Honour the 60 s `lastMeshTxAt` floor between parts. A 3-part reply would take 2 minutes; this conflicts with chat semantics.
- Sub-question: should chat parts start stamping `recordMeshTx()`? **Recommended: no.** It would hold back schedulers on any chatty source and is a separate change.

**Q3. Cooldown and overlapping sequences.**
- (A) Per-source split mutex: a new split sequence waits until the running one finishes, so markers never interleave. Cost: later automated replies are delayed by up to (N−1) × gap. **Recommended.**
- (B) While a sequence for the same trigger+sender is running, skip the new fire. Treat it as an extra cooldown, with a log line.
- (C) Raise the effective cooldown to at least (N−1) × gap when split is on.
- (D) Do nothing.

**Q4. Timer frequency × split.**
- (A) Block saving a split-enabled timer with interval < X min (e.g. 10) or channels × parts > Y (e.g. 6), and show the warning. **Recommended:** at least a UI warning, with an enforced floor of 5 minutes when split is on.
- (B) Warning only.
- (C) Nothing.

**Q5. Scripts.**
- (A) Split only single-message script output, the same as Meshtastic. **Recommended.**
- (B) Split every script message.
- (C) Scripts never split.

**Q6. Meshtastic alignment.** Should Meshtastic multiline also get a part cap and markers through the shared splitter (200 B cap)? **Recommended:** no in this issue; open a follow-up.

**Q7. Truncation when split is off.** Is the new app-side truncation acceptable as the default for all four senders? It sends no extra packets and fixes the silent firmware cut. **Recommended:** yes.

## Work packages

**WP0. Wait for #6303/#6304 to merge.** They provide `src/utils/meshcoreMessageLimits.ts` and the sync `autoAckReplyByteCap`. Rebase on top of them.

**WP1. Shared server helper.**
- Files: `src/utils/meshcoreMessageLimits.ts` (new constants), `src/server/utils/splitUtf8Message.ts` or a new `meshcoreSplitPlan.ts`, `src/server/meshcoreManager.ts` (`sendAutomatedText`, Auto Ack refactor).
- Tests:
  - planner unit tests: DM vs channel cap from name, the toggle-off truncation, the marker budget, multi-byte text
  - `meshcoreManager.sendAutomatedText.test.ts` with fake timers: part order across channels, gap outside the lock, receive-only switched on mid-sequence, a failed target dropped, the stored text equals the sent text
  - `autoAckSplit.test.ts` must stay green unchanged

**WP2. Responder and timer.**
- Files: `meshcoreManager.ts` (types :550/:600, `dispatch` at :13940 and :13620, script count), `MeshCoreResponderTriggerEditor.tsx`, `MeshCoreTimerTriggerEditor.tsx`, `meshcoreResponderTypes.ts`, `meshcoreTimerModel.ts` (default `multiline: false`), the chip in `MeshCoreAutoResponderSection.tsx`, and the Q4 guard in `meshcoreAutomationRoutes.ts` timer POST if chosen.
- Tests: manager tests for responder text/script splitting and cooldown/Q3 behaviour; timer multi-channel × parts; editor tests (toggle round-trips, hidden for advert).

**WP3. Announce.**
- Files: `settings.ts` (two lists), `meshcoreAutomationRoutes.ts:992-1140`, `runAutoAnnounceCycle`, `MeshCoreAutoAnnounceSection.tsx`.
- Tests: route GET/POST round-trip; cycle with split on/off; `{sent,total}` semantics; settings-key allowlist test.

**WP4. Automation engine.**
- Files: `catalog.ts:736-776`, `actionExecutor.ts:35/406-573`, `meshActionDeps.ts:197-214`, `automationSimulator.ts` (planned parts).
- Tests: `meshActionDeps.test.ts` (MeshCore split and truncate, Meshtastic unchanged), `actionExecutor.test.ts` (param passed through per source/channel), `catalog.showIf.test.ts` if gated.

**WP5. Shared UI component and copy.**
- Files: `src/components/shared/automation/SplitLongMessagesField.tsx` (+ test), the Auto Ack section migrated onto it, optionally the Meshtastic `TriggerEditor.tsx`, and `public/locales/en.json` keys under `automation.split_long.*`. The Auto Ack description text "about 150 bytes in a DM…" is stale after #6304.
- Docs: `docs/features/meshcore.md`, `docs/features/automation.md`.
- Tick #6316 in the epic/parity notes. The PR body must include the Mesh impact numbers above and the chosen Q1-Q4 values.

## Out of scope
- Repeater and Room Server sources: they cannot send chat.
- Manual composer and HTTP / v1 send routes: they reject over-long text (#6303).
- Changing Meshtastic multiline semantics (Q6 follow-up).
- Making chat sends part of the `lastMeshTxAt` floor.
- Reassembling `(i/N)` parts on receipt.
- Auto Welcome, Auto Ping replies and forwarding/bridge senders, unless the maintainer extends the scope. They can adopt `sendAutomatedText` later.

### Critical Files for Implementation
- /home/yeraze/Development/meshmonitor/src/server/meshcoreManager.ts
- /home/yeraze/Development/meshmonitor/src/server/utils/splitUtf8Message.ts
- /home/yeraze/Development/meshmonitor/.claude/worktrees/i6303/src/utils/meshcoreMessageLimits.ts (lands as src/utils/meshcoreMessageLimits.ts)
- /home/yeraze/Development/meshmonitor/src/server/services/automation/meshActionDeps.ts
- /home/yeraze/Development/meshmonitor/src/server/routes/meshcoreAutomationRoutes.ts
