# Spec: MeshCore `senderName` override for API channel sends (#6282)

## Maintainer decisions (2026-11-10, binding)
All recommended: (Q1) per-source opt-in setting, default off, edited with configuration:write: enable + up to 16 allowed names; callers need today's send grants plus a name from the list (403 SENDER_NAME_DISABLED / SENDER_NAME_NOT_ALLOWED). (Q2) names 1-31 bytes, NFC, no ':' / control / bidi / zero-width / leading '#', allowlist only. (Q3) full scope support mirroring sendFloodScoped incl. CMD_GET_DEFAULT_FLOOD_SCOPE. (Q4) refuse with 409 when the companion has client repeat on. (Q5) firmware gate >= 13 plus runtime Err 1 -> FIRMWARE_UNSUPPORTED. (Q6) #6303 has merged: build the raw cap on src/utils/meshcoreMessageLimits.ts. Every override send audited (no text). Echo suppression, sibling self-origin and raw resend are mandatory. Migration: next free number at implementation time (229 is taken; #6274 is taking 230).


This is a read-only design. Nothing was edited. I checked every firmware claim against `/tmp/claude-1000/-home-yeraze-Development-meshmonitor/95d1a848-1ce0-4732-8d0a-72e3b4f29f64/scratchpad/fw/MeshCore` (commit `81dbae59`, 2026-10-15, `FIRMWARE_VER_CODE 14`). Firmware paths below are relative to that tree. The issue's line numbers are slightly out of date: `CMD_SEND_CHANNEL_TXT_MSG` is at `MyMesh.cpp:1178-1197` and `sendGroupMessage` is at `BaseChatMesh.cpp:518-537`.

The idea works, but the raw path behaves differently from a normal send in four ways the issue doesn't mention:
1. **The radio delivers our own echo back as an incoming message.** A raw send is never marked "seen" on the radio, so it shows up as a new message from the override name. That causes a duplicate bubble and lets automations reply to it.
2. **The usable text is 5 bytes shorter than #6303's formula,** because of the radio's 176-byte frame limit.
3. **Scope has to be computed in software,** including the node's own default region.
4. **The existing resend button would re-send the text under the real node name,** because it goes through the normal send path.

## Findings

### Firmware
- **How a normal send is built.** `sendGroupMessage` (`src/helpers/BaseChatMesh.cpp:518-537`):
  - Plaintext is `ts(4 LE) | 0x00 | "<name>: " | text`, with no NUL counted in `data_len`. The firmware silently truncates when `prefix+text > MAX_TEXT_LEN (160)` (`BaseChatMesh.h:8`).
  - It then calls `createGroupDatagram` (`src/Mesh.cpp:540-558`): payload is `channel_hash(1) | MAC(2) | AES-128-ECB(zero-padded)`.
  - It sends with `sendFloodScoped(channel, pkt)`.
  - The companion passes `_prefs.node_name` (`MyMesh.cpp:1192`).
- **Scope on a normal send.** `MyMesh::sendFloodScoped(GroupChannel)` (`MyMesh.cpp:514-525`):
  - If `send_unscoped` is set, the packet goes out unscoped.
  - Otherwise it uses `send_scope`, falling back to `_prefs.default_scope_key`.
  - The `TransportKey` overload (`:491-500`) sets `codes[0] = scope.calcTransportCode(pkt)` and `codes[1] = 0`, then `sendFlood(pkt, codes, …, path_hash_mode+1)`.
  - `calcTransportCode` (`src/helpers/TransportKeyStore.cpp:4-18`) is `HMAC-SHA256(key16, [type] || payload)[0..1]`, with 0 and 0xFFFF reserved. MeshMonitor already has an exact copy in `computeTransportCode` (`src/server/meshcoreScopeResolve.ts:57-66`).
- **`CMD_SEND_RAW_PACKET` (65)** (`MyMesh.cpp:2045-2058`):
  - Frame is `[65][priority][raw packet]`. `tryParsePacket` (`src/Dispatcher.cpp:149-189`) reads, in order: header, transport codes (only if the route type carries them), `path_len`, path, then the rest as payload.
  - It then calls `sendPacket(pkt, priority, 0)` directly.
  - **It does not call `sendFlood`.** So it never sets the route bits or path hash size for us, never adds transport codes, and never calls `_tables->markSeen` (compare `Mesh.cpp:651`/`:680`). The raw bytes must already be a complete, scoped flood packet.
  - Replies: Ok, `ERR_CODE_ILLEGAL_ARG` (6) on a parse failure, or `ERR_CODE_TABLE_FULL` (3). Firmware that doesn't know the command answers `ERR_CODE_UNSUPPORTED_CMD` (1) (`:2060`).
- **The echo problem.**
  - When a repeater re-floods our raw packet, the companion hears it and finds it not "seen" (`Mesh.cpp:226-246`). It decrypts it, calls `onGroupDataRecv`, then `onChannelMessageRecv` (`MyMesh.cpp:558-588`), and queues a ChannelMsgRecv frame for the app.
  - So MeshMonitor receives `"<senderName>: text"` as a new incoming channel message. A normal send never does this.
  - If the companion has client repeat on (`allowPacketForward` → `isRepeatEn()`, `MyMesh.cpp:487`), it also re-transmits its own packet once.
- **Frame size limit.** `MAX_FRAME_SIZE = 176` (`src/helpers/BaseSerialInterface.h:5`).
  - USB serial truncates longer frames silently (`ArduinoSerialInterface.cpp:60-66`), which corrupts the MAC.
  - BLE drops them with no reply (`esp32/SerialBLEInterface.cpp:118`).
  - The raw frame is `1 cmd + 1 pri + 1 hdr + (4 tc if scoped) + 1 path_len + 3 + 16·ceil((5+L)/16)`, where L = bytes of `"name: text"`. Both scoped and unscoped give **L ≤ 155**. So text bytes ≤ `155 − (nameBytes + 2)` = `153 − nameBytes`, which is 5 below #6303's `160 − (nameBytes + 2)`.
- **Which firmware has the command.** It was added in commit `c588540b` (2026-05-13), when the version code was 12. By release tag:

| Release tag | Version code | Has `CMD_SEND_RAW_PACKET` |
|---|---|---|
| companion-v1.14.0 | 10 | no |
| companion-v1.15.0 | 11 | no |
| companion-v1.16.0 | 13 | yes |
| companion-v1.17.x | 13 | yes |
| companion-v1.18.0 | 14 | yes |

  Gate on `firmwareVer >= 13`. `CMD_GET_DEFAULT_FLOOD_SCOPE` (64) replies `[28][name 31][key 16]`, or just `[28]` when there is no default (`MyMesh.cpp:2006-2014`); it is available from v11.
- **Packet layout.** `path_len` is `((hashSize−1)<<6) | count` (`src/Packet.h:83`); a normal send uses `path_hash_mode+1`. Header is `(0x05<<2) | route`: `0x15` for an unscoped flood, `0x14` for a transport flood (`Packet.h:14-24`). Firmware uses priority 1 for GRP_TXT (`Mesh.cpp:659`).

### MeshMonitor
- **Internal send route** (`src/server/routes/meshcoreMessagingRoutes.ts:440-516`): body is `{text,toPublicKey,channelIdx,scope}`, gated by `messages:write` with `sourceIdFrom`. It uses the fixed 130/120 caps that #6303 is replacing. The 6303 branch (`fix/6303-meshcore-message-caps`) has no commits yet.
- **v1 send** (`src/server/routes/v1/messages.ts:292-389`, from #6263): `{text, channel|toNodeId, scope}`. Non-admins need per-channel write via `canAccessMeshcoreChannel`.
- **Manager send path** (`src/server/meshcoreManager.ts`):
  - `sendMessageWithResult` (`:6297`), `runSerialized` (`:6419`), `resolveScopeForSend` (`:6449`), `applyFloodScope` (`:6471`).
  - `performScopedSend` (`:6486-6699`) stores the row with `fromName: localNode.name` (`:6577`), computes `mc1HashForOwnChannelText` (`:6628`), and calls `registerPendingChannelSend(id, idx, text)` (`:6664`).
- **Echo matcher.** `findEchoMatch` (`meshcoreManager.ts:3816-3885`) requires the decrypted body to equal `` `${selfName}: ${text}` `` (`:3873`). It never matches an override send. `pendingChannelSends` is declared at `:1818`.
- **Incoming channel messages** (`meshcoreManager.ts:2874-2946`): there is no self-echo suppression. Messages go to `deliverReceivedMessage` (`:5635`), which triggers Auto-Ack, Auto-Responder and Forwarding. The forwarding `isSelf` check (`:14212-14214`) and `isLocalMeshCoreSenderName` (`:978-994`, the #5551/#3914 loop guard) both compare against local node names only. **With an override, all of these treat our own echo as a stranger's message, which is a feedback-loop risk.**
- **Resend** (`resendChannelMessage`, `meshcoreManager.ts:7303+`) re-sends through `performScopedSend`, so an override row would go out under the real node name. Rows have no field recording that an override was used.
- **Existing helpers:**
  - `encodeGroupTextPayload(secret, senderName, text, ts)` (`src/server/utils/meshcoreGroupEcho.ts:190-220`) already builds the exact GRP_TXT payload. Production code doesn't use it yet; tests do.
  - `loadChannelSecret` (`meshcoreManager.ts:3546`) reads the 16-byte PSK from the channel row.
- **Native backend** (`src/server/meshcoreNativeBackend.ts`): meshcore.js has no raw-packet call, but frames can be hand-built with `c.sendToRadioFrame` and an Ok/Err wait (pattern at `:2499-2520`).
  - `device_query` (`:3057-3090`) returns neither `repeat` nor `path_hash_mode`, although the manager reads both (`:12122-12123`). Today they are always undefined.
  - `cachedFirmwareVer` is at `:461`/`:633`.
- **Receive-only gate** (`src/server/constants/meshcoreTx.ts`): it fails closed, so a new command name must be added to `RF_BRIDGE_COMMANDS`, and the test fails the build if it isn't.
- **Permissions:** resource list is in `src/types/permission.ts:5-32`. The last resource added (`remote_admin`, #3160) touched about 9 files plus the UI. Audit goes through `auditMeshcoreEvent` (`src/server/routes/meshcoreRouteShared.ts:311`).

## Design

1. **API.** Add an optional `senderName` (string) to `POST /api/sources/:id/meshcore/messages/send` and to v1 `POST /messages` on MeshCore sources.
   - DM: 400 `INVALID_INPUT`.
   - Meshtastic source on v1: 400.
   - Absent, or equal to the local node name after trimming (case-sensitive): today's path, unchanged.
2. **Name validation** (shared util `validateMeshcoreSenderName`):
   - NFC-normalise and trim, then require 1–31 UTF-8 bytes (`node_name` is `char[32]`).
   - Reject `:`, C0/C1 control characters (including `\n` and NUL), DEL, and bidi or zero-width characters (U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF).
   - Reject leading `#` (avoids confusion with region/channel names).
   - The name must be in the source's allowlist (see Security).
3. **Byte cap.** Add `meshcoreChannelTextCap(senderName, { raw })` to `src/server/constants/meshcoreMessageLimits.ts`:
   - Normal path: `160 − (bytes(name) + 2)`, which is #6303's formula. Build on #6303; if it hasn't merged yet, add this function there.
   - Raw path: `155 − (bytes(name) + 2)`.
   - Apply it in the internal route (400) and in v1 (413).
   - Also assert `frame.length ≤ 176` in the builder as a backstop.
4. **Packet builder** (new pure module `src/server/utils/meshcoreRawGroupText.ts`). `buildRawGroupTextFrame({secret, senderName, text, ts, pathHashMode, transportKey|null})`:
   - Payload from `encodeGroupTextPayload`.
   - Header `0x14` if a transport key is set, else `0x15`.
   - Transport codes `computeTransportCodeWithKey(key, 0x05, payload)` written LE, plus `0x0000`. Refactor `computeTransportCode` into a key-based variant.
   - `path_len = (pathHashMode & 3) << 6`.
   - Frame `[0x41, 0x01, …]`.
   - Returns `{frame, payloadHex, wireText}`.
5. **Native backend.**
   - `send_raw_packet {frame}`: hand-built, awaits Ok/Err. Err code 1 → typed `FIRMWARE_UNSUPPORTED`, 3 → `TABLE_FULL`, 6 → `ILLEGAL_ARG`. Refuse before sending if `cachedFirmwareVer < 13`. Add to `RF_BRIDGE_COMMANDS`.
   - `get_default_flood_scope`: frame `[64]`, parses RESP 28 into `{name, key}` or null. Serial-only.
   - Extend `device_query` to return `repeat` (v9+) and `path_hash_mode` (v10+) by reading the DeviceInfo tail bytes. meshcore.js folds them into `manufacturerModel`, so parse the raw frame instead.
6. **Manager.** New `sendChannelMessageAs(text, channelIdx, senderName, scopeOverride)` running inside `runSerialized`. Same `requireTransmit`, connected, not-repeater and reorder handling (`channelIdxAfterReorder`).
   - **Scope:** resolve `region` exactly as `performScopedSend` does (override, else channel scope, else source default, else null).
     - `''` → unscoped.
     - a name → `scopeTransportKey(name)`.
     - `null` (inherit the node's own default) → `get_default_flood_scope` key, unscoped if there is none.
   - Do **not** call `applyFloodScope`: the raw path ignores the device's scope state, so leave the `activeFloodScope` cache untouched.
   - Load the secret with `loadChannelSecret`. Refuse with 409 `CHANNEL_KEY_UNAVAILABLE` if it is missing or not 16 bytes.
   - Refuse with 409 if the device reports client repeat on. Recommended, see Open question 4.
   - Stamp `ts` after scope resolution (same rule as `:6547`).
   - **On Ok:**
     - Store the row: `fromPublicKey` = local key, `fromName = senderName`, new column `senderNameOverride = senderName`, `scopeName = region || null`, `senderTimestamp`, and `mc1Hash = mc1HashForChannelWire(wireText, ts)`.
     - Emit to the UI and record the `submitted` message event.
     - `registerPendingChannelSend(id, idx, text, { payloadHex, senderName })`.
     - `registerOwnRawEcho({channelIdx, ts, wireText})`.
     - No auto-retry.
7. **Echo handling.**
   - **(a) Suppress the radio's copy.** In the `channel_message` handler, before the block filter and the reaction branch, drop a frame whose `(sender_timestamp, data.text)` matches a registered own raw send (TTL 10 min; ignore `channelIdx` because two slots can share a secret). Log at debug. This removes the duplicate bubble and the automation, notification and forwarding triggers.
   - **(b) Heard-repeater matching.** Pending entries gain optional `payloadHex`/`senderName`. `findEchoMatch` compares the decoded payload hex directly when `payloadHex` is set, otherwise it compares against `entry.senderName ?? selfName`.
   - **(c) Sibling sources.** Keep a process-wide, time-bounded (30 min) set of recently used override names. `isLocalMeshCoreSenderName` checks it, so a sibling companion or repeater source flags the message `selfOrigin`, which follows the #5551 rule of erring towards "ours". Forwarding's `isSelf` should also call `isLocalMeshCoreSenderName` for channel messages.
8. **Resend.** `resendChannelMessage`: if `row.senderNameOverride` is set, rebuild the raw frame from row text, name, `senderTimestamp` and current scope, then send raw. Same bytes give the same packet hash, so repeaters drop duplicates. Never fall back to `performScopedSend`. If rebuilding fails, `RESEND_UNAVAILABLE`.
9. **UI** (small): show a "sent as X" label on own bubbles where `senderNameOverride` is set. No composer field in this version.

## Mesh impact

- **Airtime:** one flood packet, structurally the same as a normal send. Same 160-byte budget, so worst-case airtime is the same. A different name length only moves bytes between name and text. Hop multiplication is the same as any channel send. No timers, no auto-retry, and it shares `messageLimiter` and the v1 rate limits. It does not scale with node count.
- **Differences from a normal send:**
  - The radio does not mark its own packet as seen, so the first echo is processed locally (handled by 7a). If client repeat is on, the radio re-transmits once; neighbours drop that copy as already seen. Recommend refusing in that case.
  - Scope is computed by MeshMonitor, so it must mirror `sendFloodScoped`, including the node's persistent default region (`CMD_GET_DEFAULT_FLOOD_SCOPE`). A send without the right code in a `region denyf *` mesh would be dropped by repeaters. Getting it wrong means lost messages, not extra traffic.
  - `path_hash_mode` must come from the device. Fallback is 0 (1-byte hashes) with a warning: it still works, but differs from the node's setting.
- **Spam and loops:** the main new risk is our own echo looking like a stranger to Auto-Ack, Auto-Responder and Forwarding, on this source and on sibling sources. 7a and 7c close it. Automations cannot set `senderName` in this version.

## Security

- **Impersonation:** GRP_TXT carries no sender authentication. Today the name is fixed to the companion's name. With this feature, anyone holding channel write can post as "Alice", and receivers, MeshCore apps and MeshMonitor's own block-by-name list (`meshcoreMessageFilter`, `:2884`) cannot tell. The risk to users is real even though the protocol never protected names.
- **Permission proposal (recommended):**
  - **Opt-in per source, default off.** Source setting `meshcoreSenderNameOverride = { enabled: boolean, allowedNames: string[] (≤ 16, each passes validation) }`.
  - **Who can edit it:** anyone with `configuration:write` on that source.
  - **What the caller needs:** today's grants, i.e. `messages:write` with `sourceIdFrom: 'params.id'` on the internal route and `canAccessMeshcoreChannel(write)` on v1, plus a name in the allowlist.
  - **Errors:** 403 `SENDER_NAME_NOT_ALLOWED` / `SENDER_NAME_DISABLED`.
  - **Why:** admins choose bot names once, callers can't pick arbitrary names, and no new resource type or migration of permission rows is needed.
- **Audit:**
  - Every override send: `auditMeshcoreEvent(req, 'meshcore_message_sent_as', 'messages', {sourceId, channelIdx, senderName, scope, textBytes, messageId, via: 'api'|'v1'})`. No message text.
  - Every allowlist change: `meshcore_sender_names_updated` under `configuration`.
- **Side note:** the internal route checks only `messages:write`, while v1 checks per-channel write. Consider aligning them, separately from this issue.

## Work packages

1. **WP1: pure builder and limits.**
   - Files: `src/server/utils/meshcoreRawGroupText.ts` (new); `meshcoreScopeResolve.ts` (key-based code); `constants/meshcoreMessageLimits.ts` (`meshcoreChannelTextCap`, building on #6303); `utils/meshcoreSenderName.ts` (validation).
   - Tests:
     - Golden frame vectors: build, decode with `tryDecodeGroupTextPayload`, compare header and path bytes.
     - Transport code matches `computeTransportCode` for a named region.
     - Frame ≤ 176 at the cap; cap+1 is rejected.
     - Validation table (`:`, controls, bidi, 32 bytes, multibyte).
2. **WP2: backend.**
   - Files: `meshcoreNativeBackend.ts` (`send_raw_packet`, `get_default_flood_scope`, `device_query` repeat and path_hash_mode); `constants/meshcoreTx.ts` and its test.
   - Tests: frame bytes written; Ok/Err mapping (1/3/6); version < 13 refused before any write; receive-only blocks `send_raw_packet`; RESP 28 parse with and without a default.
3. **WP3: manager.**
   - Files: `meshcoreManager.ts` (`sendChannelMessageAs`, scope resolution, pending entry shape, `findEchoMatch`, `channel_message` suppression, recent-override registry, `isLocalMeshCoreSenderName`, forwarding `isSelf`, raw resend).
   - Migration (`/migration` skill, all three backends): nullable `meshcore_messages.senderNameOverride`, plus the repository read/write.
   - Tests:
     - Named, `''` and null scope (null calls `get_default_flood_scope`); `applyFloodScope` never called.
     - Stored row fields.
     - Matching ChannelMsgRecv dropped with no Auto-Ack/Responder/Forwarding; non-matching delivered.
     - `findEchoMatch` with `payloadHex`.
     - Sibling `selfOrigin`.
     - Resend of an override row goes raw with identical bytes and never calls `send_message`.
     - Client-repeat refusal.
4. **WP4: routes and settings.**
   - Files: `routes/meshcoreMessagingRoutes.ts`; `routes/v1/messages.ts`; `routes/v1/openapi.yaml`; the settings allowlist (`constants/settings.ts` plus the per-source settings route); audit helper resource union.
   - Tests (`createRouteTestApp`, real per-source grants): DM + `senderName` → 400; disabled → 403; name not allowlisted → 403; grant on another source → 403; over cap → 400/413; old firmware → 422 `FIRMWARE_UNSUPPORTED`; audit row written; v1 parity.
5. **WP5: UI and docs.**
   - Settings card (enable plus name list) in the MeshCore source settings; "sent as" label in `MeshCoreChannelsView`.
   - Docs: `docs/.../REST_API.md` and `meshcore.md` (impersonation warning, firmware ≥ v1.16, scope behaviour, cap). Phase-log entry in `MESHCORE_PARITY_EPIC.md`.

## Open questions (recommendation first)

1. **Permission model.**
   - (A) **Recommended:** per-source opt-in and allowlist edited under `configuration:write`, with existing send grants at request time.
   - (B) Admin-only callers. Simple, but bots usually run as API-token users who aren't admins.
   - (C) New resource `messages_impersonate`. Heaviest: type, UI editor, docs.
2. **Name validation.** Recommended: 1–31 bytes, no `:`, controls, bidi or zero-width characters, and allowlist only. Alternative: free names that are refused when they match a known contact name. Weaker, and contacts change over time.
3. **Scoped channels.** Recommended: full support by mirroring `sendFloodScoped`, using `CMD_GET_DEFAULT_FLOOD_SCOPE` for "inherit". Alternative: refuse `senderName` whenever the resolved region isn't explicitly unscoped. Safe, but makes the feature unusable in scoped meshes.
4. **Client-repeat companions.** Recommended: refuse with 409. Alternative: allow and document the one extra transmission.
5. **Firmware gate.** Recommended: `>= 13` (first release with the command), and also map a runtime Err 1 to `FIRMWARE_UNSUPPORTED`.
6. **Order relative to #6303.** Recommended: land #6303 first and add the `raw` variant on top.

## Out of scope

- `senderName` for DMs, room posts and reactions.
- Repeater and MQTT-only sources (they can't send channel text).
- Meshtastic.
- Automations, Auto-Responder, scheduled messages and scripts setting a name (follow-up; they would reuse the same allowlist).
- A composer field in the UI.
- Virtual Node clients sending `CMD_SEND_RAW_PACKET`.
- Aligning the internal route's channel-level permission check.

### Critical files for implementation
- /home/yeraze/Development/meshmonitor/src/server/meshcoreManager.ts
- /home/yeraze/Development/meshmonitor/src/server/meshcoreNativeBackend.ts
- /home/yeraze/Development/meshmonitor/src/server/utils/meshcoreGroupEcho.ts
- /home/yeraze/Development/meshmonitor/src/server/routes/meshcoreMessagingRoutes.ts
- /home/yeraze/Development/meshmonitor/src/server/routes/v1/messages.ts
- /home/yeraze/Development/meshmonitor/src/server/constants/meshcoreMessageLimits.ts
- /home/yeraze/Development/meshmonitor/src/server/meshcoreScopeResolve.ts
- /home/yeraze/Development/meshmonitor/src/server/constants/meshcoreTx.ts
