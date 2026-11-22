# Spec #6341 P6: one store path for MeshCore GRP_TXT (device + MQTT)

Refactor. Row ids, rows and key-gating fields do not change. Intended changes, all MQTT-only: (a) events gain
`selfOrigin`; (b) late reaction resolutions emit after the message, not before (Q1); (c) a pending reaction is noted
only with format and hash (no-op in practice, see matrix).
Line numbers are from `origin/main` at 673324045. Re-check them after #6538 (P4) and #6539 (P5) merge.

## 1. Reuse inventory

| What | Where |
|---|---|
| Decrypt (both paths) | `decryptGroupTextFrame` `services/meshcoreFrameIngest.ts:240` |
| Filing rule | `keyedFilingFor` / `KeyedFiling` `meshcoreFrameIngest.ts:109` / `:96` |
| Id hash | `frameChannelMessageId(prefix, sourceId, channelKey, ts, text)` `meshcoreFrameIngest.ts:382` |
| MQTT id wrapper | `channelMessageId` `meshcoreMqttManager.ts:204` (`'mqtt'` + `group.channelHash`; migration 228 depends on it) |
| Virtual-key counter | `noteVirtualChannelDecrypt` `meshcoreFrameIngest.ts:366` |
| Reactions | `isReactionsInboundEnabled` / `resolveInboundReaction` / `notePendingReaction` / `resolvePendingReactionsFor` / `emitReactionResolutions` `services/meshcoreReactionIngest.ts:104/230/340/357/429` |
| MC1 hash | `meshcoreWireSecond`, `meshcoreWireChannelText`, `mc1HashForChannelWire` `utils/meshcoreReactionTarget.ts` |
| Filter | `meshcoreMessageFilter.classify` / `countHit` `services/meshcoreMessageFilter.ts` |
| Packet Monitor link | `meshCorePacketHashOrUndefined` `services/meshcoreObserverPacket.ts` |
| Local-name check | `isLocalMeshCoreSenderName` `meshcoreManager.ts:1032` (module-private; override registry `:990-1018`, `isRecentSenderNameOverride` `:1004`) |
| Device store | `ingestRepeaterGroupText` `:5379`, `ingestCompanionGroupText` `:5413` (keeps `companionHoldsChannelHash` `:5447` pre-filter), `storeDecryptedGroupText` `:5471`, `afterMessageStored` `:5757` (also used by `deliverReceivedMessage` `:5797`, so it stays) |
| MQTT store | `ingestChannelMessage` `meshcoreMqttManager.ts:682`, `decryptGroupText` `:851`, `rememberBlockedId` `:834` |
| selfOrigin readers | `automationEngineService.ts:1351`, `meshcoreMessageNotifier.ts:73`, `meshcoreMentionNotificationService.ts:139` |

## 2. Behaviour matrix

| Aspect | Repeater (`rpt`) | Companion (`cmp`) | MQTT (`mqtt`) | After |
|---|---|---|---|---|
| Id key input | `keyFingerprint` | `keyFingerprint` | `group.channelHash` | Kept: caller passes `buildId(filing)` |
| snr / rssi | radio | radio | observer event (`:731`) | Kept: caller passes values |
| hopCount / routePath | set (null if absent) | set | absent | Kept: `radio` option, MQTT omits |
| Insert `toPublicKey: null`, `senderTimestamp` null when no clock | yes | yes | key absent | Kept per path (repository treats both as NULL) |
| Block verdict | return, no hit | return, no hit | hit once per id (`rememberBlockedId`) | Kept: `onBlocked?(id, verdict)` hook |
| Reaction self name/key | local node | local node | null | Kept: `self` option |
| `notePendingReaction` guard | needs format and hash | same | only missing target, `''` fallbacks | Unified on device guard: `fieldsOf` (`meshcoreReactionIngest.ts:210`) always sets both; WP1 pins it, else keep MQTT guard by option |
| Insert returned false | return | return | return | Same |
| In-memory pool | push + trim | push + trim | none | Kept: `onStored(poolMessage)` hook in manager |
| Late reactions | after emit, via `afterMessageStored` (patches pool) | same | inline, before emit | Unified order: emit, then resolve (see Q1). Device keeps its hook; MQTT uses store default |
| `stats.channelMessages++` | n/a | n/a | yes | Kept: inside MQTT `onStored` |
| Event keys | `MeshCoreMessage` (+`receivedAt`, `sourceId`, hop fields) | same | row incl. `createdAt`, no `sourceId`/`receivedAt` | Kept: event built from the path's message object |
| `packetHash` on event | from `rawHex` | same | from `event.raw_hex` | Same |
| `selfOrigin` | `isLocalMeshCoreSenderName` | same | never | **Change: MQTT uses the same check** |
| Errors | caller `try` (`ingestRepeaterFrame`) | own `try` | own `try` | Same; store does not catch |

### selfOrigin for a feed
`isLocalMeshCoreSenderName` = name in the override registry (#6282) OR any MeshCore manager's local node name. A feed's
`getLocalNode()` is null, so for MQTT it means "a sibling radio's name or a recent override name". It is event-only (no
column, no migration). Blast radius: the automation engine stops reacting to our own sends heard via the feed (unless
`includeSelf`); the notifier already skips sibling names (`isOwnMeshCoreName`), so it now also skips override names;
the mention service returns `no_own_name` first on a feed, so no change. No frontend code reads `selfOrigin`.
A region feed carries many strangers; one who shares a local node's name is now muted for automations (the #5551 rule,
wider reach). Mesh impact: no packets; fewer triggers.

## 3. File-by-file changes

**New `src/server/services/meshcoreLocalSenderNames.ts`** (leaf). Move these symbols verbatim from `meshcoreManager.ts`
(`:990-1050`; `MESHCORE_PAYLOAD_GRP_TXT` and `PendingChannelSend` in that range stay):
`SENDER_NAME_OVERRIDE_TTL_MS`, `recentSenderNameOverrides`, `noteSenderNameOverride(name, now?)`, `isRecentSenderNameOverride(name, now?)`,
`isLocalMeshCoreSenderName(name): Promise<boolean>` (keep the lazy `sourceManagerRegistry` import and its try/catch),
`__resetSenderNameOverridesForTests()`. `meshcoreManager.ts` imports them and re-exports
`__resetSenderNameOverridesForTests` so `meshcoreManager.senderNameOverride.test.ts` stays unchanged.

**New `src/server/services/meshcoreChannelTextStore.ts`:**
```ts
export interface StoreChannelTextOptions {
  sourceId: string;
  rawHex: string;                                   // packetHash
  buildId: (filing: KeyedFiling) => string;
  snr?: number | null; rssi?: number | null;
  radio?: { hopCount?: number | null; hops?: string[] | null };  // device only: receivedAt + hop fields
  self: { name: string | null; key: string | null } | null;
  onBlocked?: (id: string, verdict: MeshCoreClassifyResult) => void;
  onStored?: (poolMessage: MeshCoreMessage) => void; // pool push / stats; no packetHash/selfOrigin/filtered
  afterStored?: (message: MeshCoreMessage, mc1Hash: string | null) => Promise<void>; // default: resolve + emit resolutions
}
export type StoreChannelTextResult =
  | { kind: 'blocked' | 'duplicate-reaction' | 'not-inserted' }
  | { kind: 'stored'; id: string; event: MeshCoreMessage };
export async function storeDecryptedChannelText(
  plain: DecryptedGroupText, opts: StoreChannelTextOptions,
): Promise<StoreChannelTextResult>;
```
Order inside: filing, id, message, classify, block, reaction parse, mc1Hash, insert, `countHit`,
`noteVirtualChannelDecrypt`, `onStored`, pending note, `selfOrigin`, emit, `afterStored` (only when not a reaction).
MQTT-only fields (`createdAt` on event, no `toPublicKey`) follow from `radio` being absent. No `any`; `.js` imports.

**`meshcoreManager.ts`:** `storeDecryptedGroupText` becomes a thin wrapper: `buildId: f =>
frameChannelMessageId(idPrefix, sourceId, f.keyFingerprint, ts, text)`, `self` from `localNode`, `onStored` = pool push
and trim, `afterStored` = `this.afterMessageStored(m, h, Promise.resolve(true))`. Lines `:3086` and `:6986` need only
the new import, no edit (keeps P6 out of P4's send paths). Remove now-unused imports.

**`meshcoreMqttManager.ts`:** `ingestChannelMessage` keeps decode and try/catch, calls
`decryptGroupTextFrame` directly (delete `decryptGroupText`), then the store with `buildId: () =>
channelMessageId(sourceId, group.channelHash, ts, text)`, `self: null`, `onBlocked` = `rememberBlockedId` + `countHit`,
`onStored` = `stats.channelMessages++`. Keep the id docblock. `channelMessageId` stays exported.

Overlap: #6539 adds `sampleClock` after `ingestAdvert` (~:621-660) and imports near `:80`; P6 edits the same import block
and code below it. #6538 edits `meshcoreManager.ts` far from `:990-1050` and `:5379-5800`. Both are rebase-only.

## 4. Test plan

New `src/server/services/meshcoreChannelTextStore.test.ts` (mock `database.js`, `dataEventEmitter.js`,
`meshcoreReactionIngest.js`):
- id comes from `buildId`; device and MQTT golden ids equal today's (fixed fingerprint / channelHash vectors);
- block calls `onBlocked`, no insert; ignore stores and flags `filtered`;
- insert false: no emit, no hooks, no count;
- reaction: emoji text, pending note only with format and hash, no `afterStored`; duplicate returns early;
- ordinary: emit before `afterStored`; default `afterStored` emits resolutions;
- `selfOrigin` set for an override name and a sibling manager name, absent otherwise;
- `radio` absent: no `hopCount`/`routePath`/`receivedAt`; key fields present on every row.

New `meshcoreMqttManager.selfOrigin.test.ts`: a feed message from a sibling's name carries `selfOrigin`; from a
stranger does not.

Must pass unchanged: `meshcoreManager.repeaterIngest`, `.companionOtaIngest`, `.otaPacket`, `.senderNameOverride`,
`.channelHeard`, `.reactions` (+`.guards`, `.perSource`); `meshcoreMqttManager.channelIngest`, `.channel`,
`.ignoreBlock`, `meshcoreMqttManager.test`; `meshcoreMqttBrokerManager.integration`;
`services/meshcoreFrameIngest`, `meshcoreReactionIngest`, `meshcoreMessageNotifier`,
`meshcoreMentionNotificationService`, `automation/automationEngineService`, `automation/meshcoreReactionTrigger`;
`migrations/228_refile_meshcore_mqtt_slot_channels`.

## 5. Work packages (sequential)

**WP1 — leaf modules (Sonnet).** Create `meshcoreLocalSenderNames.ts` (move) and `meshcoreChannelTextStore.ts` + its
test. No caller changes yet except the moved helpers' imports. Accept: new test green; `senderNameOverride` suite
unchanged and green; `lint:ci` clean.

**WP2 — device wiring (Sonnet).** Rewrite `storeDecryptedGroupText` as the wrapper. Accept: device suites listed above
green unchanged; golden-id test covers `rpt` and `cmp`.

**WP3 — MQTT wiring (Sonnet).** Rewrite `ingestChannelMessage`, delete `decryptGroupText`, add selfOrigin test.
Accept: MQTT suites, broker integration and migration 228 green unchanged; `lint:ci` clean
(`grep '^FAIL' | grep -v .claude/worktrees` empty).

All: run targeted suites only, under the machine test lock with `--maxWorkers=2`; CI runs the full suite.

## 6. Open questions

**Q1. Emit order on MQTT.** Today MQTT emits reaction resolutions before the message; the device emits the message
first. Recommend: unify on the device order (the target exists on the client before a patch names it). Alternative:
an option that keeps MQTT's order.

## Maintainer answers (2026-11-22)
- `selfOrigin` on MQTT feed events as described (sibling radios' node names + recent override names), accepting the
  rare name-collision side effect.
- Q1: MQTT emits late reaction resolutions after the message, matching the device path.
