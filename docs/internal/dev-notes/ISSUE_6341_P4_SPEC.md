# #6341 P4 spec: sender-name override follow-ups

Base: origin/main `4baa177a1`. Line numbers are origin/main. They differ from the brief's numbers.

## 1. Reuse inventory

| What | Where |
|---|---|
| Policy read + check | `src/server/utils/meshcoreSenderNamePolicy.ts`: `readSenderNamePolicy`, `checkSenderName` (:83) |
| Request decision (already shared by both routes, so nothing to extract) | `src/server/utils/meshcoreSenderNameRequest.ts:21` `decideSenderName`. A name equal to the local name counts as no override |
| Name syntax (server + client) | `src/utils/meshcoreSenderName.ts:31` `validateMeshcoreSenderName`, `SENDER_NAME_ALLOWLIST_MAX` |
| Raw cap | `src/utils/meshcoreMessageLimits.ts:60` `meshcoreChannelTextCap(name,{raw})`; `meshcoreChannelMaxBytes` (:43) |
| Raw send | `meshcoreManager.ts:6892` `sendChannelMessageAs`. It throws `MeshCoreSenderNameError` (`src/server/errors/meshcoreSenderNameError.ts`) or `TxDisabledError`, never returns false |
| Loop protection | own echo `registerOwnRawEcho` plus the process registry `noteSenderNameOverride` (:997-1013, sets `selfOrigin` at :3086), both inside `performRawChannelSend`; responders skip `selfOrigin` (:5805) |
| Split | `sendAutomatedText` (:15557), `planMeshCoreTextParts` (`src/server/utils/meshcoreSplitPlan.ts`), `sendAutomatedTextParts` (`automatedTextSplit.ts:118`: a throw from `sendPart` reaches the caller) |
| Firmware gate | backend `send_raw_packet` (`meshcoreNativeBackend.ts:3099`) throws FIRMWARE_UNSUPPORTED before RF; `localNode.firmwareVer` is on the manager |
| Resend precedent | `meshcoreManager.ts:7803-7810`: a name dropped from the list blocks the raw resend |
| Callers | announce :14308, timer :14513/:14518, responder :14863/:14868, AE `meshActionDeps.ts:247` → `actionExecutor.ts:678/686` |

**Not touched:** `services/autoAnnounceService.ts:264` (Meshtastic only), Auto Ack (:15532, out of scope), Meshtastic, Virtual Node raw packets (#5350). The is_automation bit (#6449) does not apply: it is a Meshtastic Data bit, and GRP_TXT has no field for it.

## 2. Design

### 2a. Runtime rule: decide once, fall back to the normal send, warn
Add `senderName?: string` to the `sendAutomatedText` opts. DM (`toPublicKey`) ignores it. For a channel send, run this before planning:

1. `decideSenderName({sourceId, raw: senderName, isDm:false, hasChannel:true, localNodeName})`. `none` → normal path.
2. `override` → pre-flight: `deviceType` is companion, `localNode.firmwareVer >= MIN_RAW_PACKET_FW_VER` (export it), and `deviceQuery().repeat !== true` (a local read, no RF).
3. Plan with `maxBytes = min(meshcoreChannelTextCap(name,{raw:true}), meshcoreChannelMaxBytes(localName))`, so every part fits either path. Extend `planMeshCoreTextParts` with an optional `maxBytesOverride`.
4. **reject or pre-flight fail → fall back to the normal send under the node name, with a warning.**
   - **Why fall back:** the radio's real name is always honest, so this never widens impersonation.
   - **Why not skip:** skipping drops scheduled or reply traffic without a sound. That is the failure CLAUDE.md warns about.
   - **Why no retry:** a fallback sends the same number of packets.
   - **Logging:** warn at most once per `(sourceId,label,name,code)`, then debug (the `logDrop` pattern), so a busy responder cannot flood the log.
5. Mid-sequence: `sendPart` calls `sendChannelMessageAs` and catches `MeshCoreSenderNameError` → `false` (that target drops its later parts, as with any failure today). It rethrows `TxDisabledError`, same as `sendMessage` (`requireTransmit`), so the AE still records a skip. It never switches names between parts and never retries.

Add `senderName` to the duplicate `sequenceKey`.

### 2b. Save-time rule
- Per-source editors (timer, responder, announce) check syntax only: `validateMeshcoreSenderName` → 400 `INVALID_INPUT`. They do **not** check the allowlist. Otherwise one stale name would block every later save of the whole trigger array. The run-time fallback handles names no longer on the list.
- AE (global, several sources): syntax only, checked in the automation save validator. The name is a literal, not tokens.
- Audit at save, because automated sends have no `req`: `meshcore_sender_name_automation_set` (`automation`), with `{sourceId|automationId, kind, senderName}` whenever a stored name is added or changed. Stored rows keep `senderNameOverride`.

### 2c. Names read for pickers
`GET /config/sender-names` needs `configuration:read`. Editors run under `automation:write`, and the composer under `messages:write`. Add **`GET /api/sources/:id/meshcore/sender-names`** (`meshcoreMessagingRoutes.ts`). It uses `requireAuth()` plus an inline `checkPermissionAsync` that passes on `messages:write` or `automation:write` for that source, and returns `ok(res,{enabled, allowedNames, firmwareSupported})`. When disabled it returns `allowedNames: []`, so a disabled list stays hidden. Use the `ok()` envelope; the consumer is new.

## 3. File-by-file

**Server**
- `meshcoreManager.ts`
  - `sendAutomatedText(text, opts & {senderName?: string})`, per §2a.
  - The timer and responder trigger types gain `senderName?: string`, passed only on channel dispatch (:14518, :14868).
  - Announce (:14308) reads `meshcoreAutoAnnounceSenderName`.
- `utils/meshcoreSplitPlan.ts`: `planMeshCoreTextParts(text, {…, maxBytesOverride?: number})`.
- `utils/meshcoreSenderNameRequest.ts`: add a pure `automatedSenderNameMaxBytes(name, localName)` (the min rule) for the manager and the simulator.
- `routes/meshcoreAutomationRoutes.ts`
  - timers (:1229) and responder (:1328): syntax check plus audit.
  - announce (:1057): accept `senderName` (string; `''` clears), syntax check, store, audit.
  - announce GET (~:1033): return the stored name.
- `constants/settings.ts`: add `meshcoreAutoAnnounceSenderName` to `VALID_SETTINGS_KEYS` (next to :504) and `PER_SOURCE_SETTINGS_KEYS` (next to :828).
- `services/automation/actionExecutor.ts`: add `senderName?: string` to the deps args (:45); forward `senderNameArg` like `splitArg` (:606), only when set.
- `services/automation/meshActionDeps.ts`
  - `MeshCoreSendManager.sendAutomatedText` opts gain `senderName`.
  - `sendTextVia` gets a trailing `senderName?` and passes it only on the MeshCore channel branch (:247). Meshtastic and Reticulum ignore it.
- `services/automation/automationSimulator.ts:205`: use the min-cap rule when `a.senderName` is set.
- `routes/meshcoreMessagingRoutes.ts:452-460` and `routes/v1/messages.ts` (same block): when `senderName` is a string on a channel send, skip the local-name cap and leave the check to the raw cap (:525). Today a name more than 5 bytes shorter than the node name is refused below its raw cap.

**Client**
- `components/MeshCore/hooks/useMeshCore.ts`
  - `sendMessage(text, toPublicKey?, channelIdx?, scope?, senderName?)` adds `senderName` to the body only when set.
  - New `fetchUsableSenderNames()`.
- `components/MeshCore/MeshCoreSenderNamePicker.tsx` (+ `.module.css`): select, "(node name)" plus the names. Hidden when the list is empty or `firmwareSupported` is false.
- `MeshCoreChannelsView.tsx` :1153/:1171
  - Show the picker only when `canSend` and the list is non-empty, and never on virtual channels.
  - When a name is picked, `maxBytes = meshcoreChannelTextCap(name,{raw:true})`.
  - Server errors (`CLIENT_REPEAT_ON` 409, etc.) show through the existing `setError`.
  - Selection lives in state, per source; it is not saved.
- `MeshCoreTimerTriggerEditor.tsx`, `MeshCoreResponderTriggerEditor.tsx` (`meshcoreTimerModel.ts`, `meshcoreResponderTypes.ts` gain `senderName?`), `MeshCoreAutoAnnounceSection.tsx`
  - Picker shown only when the target is a channel (responder: not `replyAsDM`).
  - A stored name that is no longer on the list shows as "(no longer allowed: X), sends as node name".
- `components/automations/catalog.ts` (`action.sendMessage`): `{name:'senderName', kind:'senderNameSelect', advanced:true}`, with help text "MeshCore channel sends only; a source that does not allow this name sends under its own name."
- `AutomationBuilder.tsx:417`: render it like `regionSelect`, an input with a datalist of the names usable on every MeshCore source in `sources` (fetched in the builder's parent, failures ignored).
- `components/search/configSections.ts:378`: change the label to "Sender names".

**Copy and docs:** `public/locales/en.json` only.
- Rename `meshcore.sender_names.title` / `.hint` from "API" to API, automations and composer.
- Add `meshcore.sender_name.picker_label`, `.node_name`, `.stale`, `.help_automation`.
- Update `docs/features/meshcore-using.md` §"sender name" (~:183): automations, composer, the fallback rule, and the shorter cap. Add a line to `docs/features/automation-engine-reference.md` (send action).

## 4. Mesh impact
No new packets. A name lowers the cap by `nameBytes − localNameBytes + 5` at most, so a long text may use one more part. It is still bounded by `SPLIT_MAX_PARTS` (3), the 10 s part gap, the 5-minute split-timer floor and 4 channels per timer. Anything past part 3 is truncated, as today. A fallback is one normal send, not an extra one. Raw sends do not take the #3979 automated channel auto-retry (`autoRetryOnMiss`), so they put out fewer packets. #6240 Auto Resend works the same on both paths.

## 5. Test plan (Vitest)
- `src/server/meshcoreManager.automatedSenderName.test.ts`
  - Override path calls `sendChannelMessageAs`.
  - DM ignores the name.
  - Fallback with one warning for each case: disabled, name not on the list, repeat on, fw < 13.
  - Mid-sequence `MeshCoreSenderNameError` drops the target.
  - `TxDisabledError` propagates.
  - Min-cap plan: long local name vs short override name, and the reverse.
  - Name equal to the local name takes the normal path.
- `src/server/utils/meshcoreSplitPlan.test.ts`: `maxBytesOverride`.
- `src/server/services/automation/meshActionDeps.test.ts` + `actionExecutor.test.ts`: forwarded only when set and only on MeshCore channels; Meshtastic is unchanged.
- `src/server/routes/meshcoreAutomationRoutes.senderName.test.ts` (route harness): syntax 400; an off-list name is accepted; audit row; announce GET/POST round-trip.
- `src/server/routes/meshcoreMessagingRoutes.senderName.test.ts` (extend)
  - New usable-names GET: 403 without either grant, `[]` when disabled, `automation:write` passes.
  - Short-name raw-cap acceptance.
- `automationSimulator.test.ts`: part count uses the raw cap.
- Client: `MeshCoreSenderNamePicker.test.tsx`; `MeshCoreChannelsView` counter switches to the raw cap and the request carries `senderName`; editor tests save `senderName` and show the stale label.

## 6. Work packages
1. **WP1 server core** (first)
   - Covers: §2a, `planMeshCoreTextParts`, the min-cap helper, the manager call sites, `MIN_RAW_PACKET_FW_VER` export, the route raw-cap fix, the usable-names GET, simulator, AE executor/deps.
   - Accept when: the manager, deps, executor and route tests pass, and `lint:ci` is clean.
2. **WP2 editors** (after WP1)
   - Covers: the timer, responder and announce routes with the settings key and audit, the three editors, the AE catalog and builder field, en.json, docs.
   - Accept when: the route harness tests and editor tests pass, and the semanticTokens test passes for the new CSS.
3. **WP3 composer** (after WP1; can run alongside WP2)
   - Covers: the picker component, `useMeshCore.sendMessage`, the `MeshCoreChannelsView` wiring.
   - Accept when: the counter uses the raw cap, the picker is hidden without names, permission or firmware, and a browser check sends one message under a name on the gauntlet channel.

## 7. Open questions (recommendation first)
1. **Stale or refused name at run time:** (A) fall back to the node name with a warning (recommended, §2a), or (B) skip and log. B means an announcement admins expect goes missing.
2. **Who may read the allowed list:** (A) `messages:write` or `automation:write` on the source (recommended), (B) `configuration:read` only, which hides the picker from most senders.
3. **Audit for automated sends:** (A) audit when the name is saved in a config (recommended), (B) also audit each send with no actor, which is noisy for responders.

## Maintainer answers (2026-11-22)
1. Refused name at run time: fall back to the node's own name with a warning (recommended option).
2. Allowed-list read: senders too: new endpoint passes on `messages:write` or `automation:write` (or `configuration:read`) for the source.
3. Audit on save only; no per-send rows.
