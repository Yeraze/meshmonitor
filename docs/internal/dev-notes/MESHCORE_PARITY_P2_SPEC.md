# MeshCore Parity P2 (#6261) Spec: Messaging

**Mesh impact: none.** Translation = DB + HTTP to the provider. Mute and mark-read = DB/localStorage. Emoji picker edits the local draft. The MeshCore send path (`onSend` → `sendMessage` / `sendRoomPost` / channel send) is untouched; byte limits stay enforced before send.

## Decisions (orchestrator, per maintainer's one-implementation rule)
1. **Room unread clock = MeshMonitor receipt time** (`createdAt`/`receivedAt`), not sender time. Login backlog replay is de-duplicated server-side ("Duplicate room post", `meshcoreManager.ts` ~2873).
2. **Room mute lives in `mutedDMs`**, keyed by room pubkey. No schema change.
3. **Mark-all scope:** MeshCore channels, DMs and rooms each get a list-header "mark all read". Meshtastic ChannelsTab keeps its current button (swapped to the shared component, same behaviour).
4. **MeshCore composer is single-line** (`allowNewlines={false}`), as today.
5. **MeshCore adopts the shared composer look** (icon Send button, inline byte counter).

## 0. Findings
- **Channel mute already works on MeshCore** (#5487): `MeshCoreChannelsView` uses `useOptionalChannelMuteSettings()`; `MeshCorePage` passes `isChannelMuted` into `useMeshCoreUnread`. Mute lists are per-user, per-source rows behind `/api/push/preferences`; `SettingsProvider` is scoped to the source.
- **The server needs no change for DM/Room mute.** `MutedDM.nodeUuid` is a free string; the `POST /api/push/preferences` validation (`notificationRoutes.ts` ~478) only checks it's a string and is gated `requirePermission('messages','read',{sourceIdFrom:'body'})`.
- **There are 3 copies of the mute menu:** `ChannelsTab.tsx` ~812-878 (inline styles), `MessagesTab.tsx` ~1630-1670 (DM actions dropdown items), `MeshCoreChannelsView.tsx` ~1071-1128 (CSS module `.muteWrap/.muteButton/.muteMenu/.muteMenuItem`, `role="menu"`).
- **Unread state lives in two separate models.** Meshtastic uses per-message `read_messages` rows, server-computed `/unread-counts`, and `markMessagesAsRead` in MessagingContext. MeshCore uses per-conversation watermarks (`conversation_read_state`, `CONVERSATION_KINDS = ['meshcore_channel','meshcore_dm']`) via `meshcoreUnreadStore.ts`, computed client-side. The schema header forbids Meshtastic writing there. **The read model stays separate (deliberate); the CONTROLS and the mute state are shared.**
- **Rooms have no unread tracking.** `computeUnreadDmPeers` skips `room_post`; `getRoomStats` (`db/repositories/meshcore.ts` ~1941) returns sender-time `MAX(timestamp)` only.
- **Translation server path is Meshtastic-only.** `translationRoutes.ts` `loadReadableMessages` uses `messages.getMessagesByIdsInSource` + `resolveMessageReadAccess`.
  - **LATENT DATA-LOSS BUG:** `TranslationsRepository.orphanedLinksDeleteSql` (~291) deletes every `message_translations` row with `NOT EXISTS (SELECT 1 FROM messages …)`, so the hourly prune and every Meshtastic delete would wipe all MeshCore links. Fix before writing MeshCore links.
  - `message_translations.messageId` is TEXT / VARCHAR(64); MeshCore ids (~24 chars) fit, and PK `(sourceId, messageId, targetLang)` can't collide across protocols.
- **The translation client is protocol-agnostic** (`useViewTranslations`, `useStoredTranslations`, `useMessageTranslation`, `TranslatedMessage`, `TranslateModal`). `TranslateModal` hardcodes `LORA_PACKET_MAX_BYTES = 200`. `useViewTranslations` calls `useTranslationSettings()` without `sourceId`.
- **Composer.** `MessageComposeInput.tsx` (textarea, mention autocomplete, byte counter, `MessageEmojiButton`, `actions` slot, send) is bound to the `composeDraftStore` context, with a fixed 200-byte counter, no over-limit block, and `@!id` mentions. The MeshCore stream (`MeshCoreMessageStream.tsx` ~1037-1078) uses local useState, an `<input>`, `maxBytes` (130 channel / 120 scoped / 150 DM), blocks over-limit sends, inserts `@[Name] ` mentions, and does reply prefill + focus via `inputRef`.
- **The MeshCore permission predicate already exists:** `meshcoreChannelIdx(row)` (`socketEventGates.ts` ~216), `canAccessMeshcoreChannel(userId, idx, 'read', sourceId)` (`meshcoreRouteShared.ts` ~504), and `resolveMeshcoreKeyAccess` / `canSeeKeyedMessage` (`server/utils/meshcoreKeyAccess.ts`). DM/room routes gate on `messages:read` with `sourceIdFrom:'params.id'`.

## 1. Reuse inventory (shared piece first)
| Feature | Shared piece | Meshtastic | MeshCore | New / why |
|---|---|---|---|---|
| Mute state | `SettingsContext` mute API | `useNotificationMuteSettings` (unchanged) | `useOptionalMuteSettings()` (channel + DM fns); DMs keyed by canonical full pubkey, rooms by room pubkey, both in `mutedDMs` | Hook extended; `useOptionalChannelMuteSettings` kept as alias or 2 callers migrated |
| Mute UI | Extract MeshCoreChannelsView's menu → `src/components/notifications/MuteMenu.tsx` + `.module.css` | ChannelsTab (replaces inline copy), MessagesTab DM dropdown (`variant="items"`) | ChannelsView, DirectMessagesView, RoomsView | Removes 3 copies |
| Muted row indicator | `MutedIndicator` export from MuteMenu | optional adopt in MessagesTab row ~1429 | channel/DM/room rows | same file |
| Mark-all-read | `src/components/messages/MarkAllReadButton.tsx` (confirm above threshold 50, lifted from `DashboardSidebar.handleMarkAllDmsRead`) | MessagesTab sidebar (~1328), ChannelsTab button (~880) | DM, Rooms, Channels list headers | Reuses `messages.mark_all_read_button/_title`, `channels.mark_all_read_button/_title` |
| Unread data | Not merged (above) | unchanged | store gains room kind + batch mark | |
| Unread divider | `UnreadDivider` + `unreadAnchorMs` on `MeshCoreMessageStream` | n/a | RoomsView passes `unreadAnchorMs` | none |
| Inline translation | `useViewTranslations`, `TranslatedMessage`, `/api/translate` + `/stored`, `message_translations`, `translation_cache` | unchanged | `MeshCoreMessageStream` calls `useViewTranslations(sourceId, ids)` once | server protocol dispatch `translatableMessages.ts` |
| Outbound translate | `TranslateModal` | default 200 | composer `actions` slot, `maxBytes` prop | new prop |
| Composer + emoji | `MessageComposeInput` (+ `MessageEmojiButton`, `useMentionAutocomplete`, `formatByteCount`) | unchanged defaults | replaces `<input>` in `MeshCoreMessageStream` | new optional props |

## 2. Changes

### A. Room unread + batch mark-read (WP1)
- `src/db/schema/conversationReadState.ts`: `CONVERSATION_KINDS = ['meshcore_channel','meshcore_dm','meshcore_room'] as const`. No DDL/migration: `conversationKind` is TEXT / VARCHAR(32), the table is already in `BACKUP_TABLES`, and the repo's `isConversationKind` makes older builds skip unknown kinds.
- `src/db/repositories/conversationReadState.ts`: `setManyLastReadAsync(userId: number|null, sourceId: string, entries: Array<{kind: ConversationKind; conversationKey: string; lastReadAt: number}>): Promise<Record<ConversationKind, Record<string, number>>>`. It loops `setLastReadAsync` (monotonic/race semantics kept) with no raw SQL. Facade `setConversationReadStateManyAsync` in `src/services/database.ts`.
- `src/server/routes/readStateRoutes.ts`: new `POST /api/read-state/batch`:
  - middleware `optionalAuth(), requirePermission('messages','read',{ sourceIdFrom:'body', requireSourceId:true })`;
  - body `{ sourceId, entries: [{kind, conversationKey, lastReadAt}] }`, 1..500 entries (`MAX_BATCH_READ_STATE = 500`, else 400 `TOO_MANY_ENTRIES`), each validated like the single POST;
  - returns `ok(res, { state })`.
  - It exists to avoid `apiLimiter` trips from per-entry POSTs.
- `db/repositories/meshcore.ts` `getRoomStats` (**WP1 owns this function only**): add `latestReceivedAt: MAX(createdAt)`; return `{ roomPublicKey; count; latest; latestReceivedAt }`. `latest` stays sender time (ordering). Pass it through `meshcoreManager.getRoomStats` and `meshcoreMessagingRoutes.ts` `/messages/room-stats` (gate unchanged); update the client type of `fetchRoomStats` in `components/MeshCore/hooks/useMeshCore.ts` (~2327).
- `src/components/MeshCore/meshcoreUnreadStore.ts`:
  - `MeshCoreReadKind` adds `'meshcore_room'`; `roomLastReadKey(sourceId)` = `meshmonitor-meshcore-room-lastread-<sourceId>`.
  - `serverState` gains `rooms`; `hydrateReadState` reads `data.meshcore_room`; `pushToServer` routes to the right bucket; `subscribeUnreadChanged` matches the room prefix.
  - `loadRoomLastRead(sourceId)` / `markRoomRead(sourceId, roomKey, ts = Date.now())` mirror the DM functions.
  - `latestIncomingDmByPeer(params): Map<string, number>` is factored out of `computeUnreadDmPeers`, which now uses it.
  - `computeUnreadRooms({ messages, roomStats, rooms, selfKey, roomLastRead, activeRoomKey, isMuted? }): Set<string>`. Per room, latest = max(server `latestReceivedAt`, live-pool `room_post` receipt times via `meshcoreReceiptTimeMs`), matched prefix-aware like `buildRoomFilter`. It excludes own posts (`peerKeysMatch(m.fromPublicKey, selfKey)`), reactions and filtered rows. A room is unread when latest > lastRead, it isn't the active room, and it isn't muted.
  - `markManyRead(sourceId, entries: Array<{kind: MeshCoreReadKind; key: string; ts: number}>)`: monotonic per key, one `persist` per kind, one `notifyChanged`; mirrors via `transport.saveMany` if present, else per-entry `save`.
  - `ReadStateTransport` gains optional `saveMany(sourceId, entries)`.
- `hooks/useReadStateSync.ts`: `saveMany` → `apiService.post('/api/read-state/batch', { sourceId, entries })`.
- `hooks/useMeshCoreUnread.ts`:
  - Params add `isDMMuted?: (key: string) => boolean`.
  - Poll `/api/sources/:id/meshcore/messages/room-stats` at the same 15 s cadence and `enabled` gate as channel-counts. Rooms are contacts with `advType === 3`; reuse the rooms view predicate.
  - Return `{ channels, dms, rooms }`: `dms` now excludes muted peers (Meshtastic parity); `rooms` = `computeUnreadRooms(...).size > 0`, excluding muted rooms. Also export `unreadRooms` and `roomLatest`.

### B. Shared mute / mark-all UI + MeshCore views (WP2, after WP1)
- `src/contexts/SettingsContext.tsx`: `useOptionalMuteSettings()` → `{ isChannelMuted, muteChannel, unmuteChannel, isDMMuted, muteDM, unmuteDM } | null`. Keep `useOptionalChannelMuteSettings` as a re-export, or migrate its 2 callers.
- `src/components/notifications/MuteMenu.tsx` + `MuteMenu.module.css` (moved rules from `MeshCoreChannelsView.module.css` 59-140; tokens only):
  ```ts
  export const MUTE_DURATIONS = { hour: 3_600_000, week: 604_800_000 } as const;
  export interface MuteMenuProps {
    muted: boolean;
    onMute: (muteUntil: number | null) => void | Promise<void>;
    onUnmute: () => void | Promise<void>;
    variant?: 'button' | 'items';   // 'button' = bell + popover; 'items' = menuitems for an existing dropdown
    onDone?: () => void;            // fired after any choice
    label?: string;                 // default t('notifications.mute_channel')
    iconSize?: number;
  }
  export const MutedIndicator: React.FC<{ size?: number }>;
  ```
  Item order: unmute (when muted), indefinite, 1 h, 1 week. Keep i18n keys (`notifications.unmute`, `mute_indefinite`, `mute_1h`, `mute_1w`, `mute_channel`, `mute_channel_active`, `muted`) and the `role="menu"`/`menuitem`/`aria-expanded` semantics that `MeshCoreChannelsView.mute.test.tsx` relies on.
- `src/components/messages/MarkAllReadButton.tsx`: props `{ onMarkAll; label; title?; unreadCount?; confirmThreshold? = 50; confirmMessage?; disabled?; className? }`; `window.confirm` when `unreadCount >= confirmThreshold`.
- **Consumers:**
  - `ChannelsTab.tsx`: `<MuteMenu variant="button">` replaces 812-878. `MarkAllReadButton` replaces ~880, keeping `className="btn btn-secondary"`. The mobile overflow item is unchanged.
  - `MessagesTab.tsx`: `<MuteMenu variant="items" onDone={() => setShowActionsMenu(false)}>` replaces ~1630-1670. Sidebar mark-all (~1328) → `MarkAllReadButton className="mark-all-read-btn"`.
  - `MeshCoreChannelsView.tsx`: MuteMenu + `MutedIndicator`. List-header `MarkAllReadButton` (label `channels.mark_all_read_button`, title new key `meshcore.channels.mark_all_read_title`) → `markManyRead` over unread channels with `ts = effectiveLatest[idx]`, then refresh local `lastRead`. Muted channels are included.
  - `MeshCoreDirectMessagesView.tsx`:
    - `canMute = !!mute && authStatus.authenticated`.
    - MuteMenu in `.meshcore-conversation-toolbar`, keyed by `canonicalizePeerKey(selected, contacts)`. Render the toolbar when `canMute` even without `canSend`.
    - `MutedIndicator` on muted rows, with no unread dot.
    - Header `MarkAllReadButton` (`messages.mark_all_read_button`) → `markManyRead` over `latestIncomingDmByPeer` for unread peers.
  - `MeshCoreRoomsView.tsx`:
    - Row unread dot (reuse `.meshcore-dm-unread-dot`) from `computeUnreadRooms` / `loadRoomLastRead`; `MutedIndicator` on muted rows.
    - Pin `entryRoomLastRead` on selection and pass `unreadAnchorMs`.
    - Mark read on entry and when the open room's newest receipt time grows (copy the DM effect ~526-533) via `markRoomRead(sourceId, room.publicKey, latest || Date.now())`.
    - MuteMenu in the room header; header `MarkAllReadButton` (new key `meshcore.rooms.mark_all_read`).
  - `MeshCorePage.tsx`: use `useOptionalMuteSettings`, pass `isDMMuted` into `useMeshCoreUnread`, pass `unread={{ channels, dms, rooms }}` to `MeshCoreSubToolbar`.

### C. Translation for MeshCore (WP3 server; client in WP4)
- `src/db/repositories/translations.ts` **(fix first)**. Orphan = message in neither table:
  ```sql
  … NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = l.messageId AND m.sourceId = l.sourceId)
    AND NOT EXISTS (SELECT 1 FROM meshcore_messages mc WHERE mc.id = l.messageId AND mc.sourceId = l.sourceId)
  ```
  Use `this.col()` quoting for all 3 backends. Update the file header and the `TRANSLATION_CACHE_SPEC.md` scope line (MeshCore now in scope).
- `db/repositories/meshcore.ts` (**WP3 owns all but `getRoomStats`**):
  - `getMessagesByIdsInSource(sourceId: string, ids: string[]): Promise<DbMeshCoreMessage[]>`: throws without sourceId; `inArray` chunked ≤ 200.
  - `private sweepTranslationLinks(sourceId)`: copy `MessagesRepository` 50-78 (lazy `TranslationsRepository`, best-effort, logged). Call it after `deleteMessageForSource`, `deleteMessagesByIds`, `deleteChannelMessagesForSource`, `deleteAllMessagesForSource`, `deleteMessagesOlderThan`, `deleteAllMessages` (ALL_SOURCES) and any retention cleanup. Grep `delete(meshcoreMessages)`.
- New `src/server/utils/meshcoreChannelIdx.ts`: move `meshcoreChannelIdx` from `socketEventGates.ts` and re-export it there.
- New `src/server/services/translation/translatableMessages.ts`:
  ```ts
  export interface TranslatableMessageScope {
    canReadAny: boolean;   // gate for /stored → 403
    loadReadable(ids: string[]): Promise<Array<{ id: string; text: string }>>;  // hidden/missing/reaction rows dropped
  }
  export async function resolveTranslatableMessageScope(user: User | null | undefined, sourceId: string): Promise<TranslatableMessageScope>;
  ```
  - Resolve via `databaseService.sources.getSource(sourceId)`; an unknown source gets `canReadAny:false`.
  - **Meshtastic** (not MeshCore): current `resolveMessageReadAccess` + `messages.getMessagesByIdsInSource` + `canReadChannel(Number(msg.channel))`, moved verbatim.
  - **MeshCore** (`isAnyMeshCoreSourceType`):
    - `canReadAny` = admin OR `messages:read` on the source OR any `channel_0..N:read` (`channelResourceFor`).
    - `loadReadable`: `meshcore.getMessagesByIdsInSource` → drop `reactionEmoji` rows → `meshcoreChannelIdx(row)`. A channel row needs `user.isAdmin || canAccessMeshcoreChannel(user.id, idx, 'read', sourceId)` AND `canSeeKeyedMessage(await resolveMeshcoreKeyAccess(user), row)` (resolve key access once per call). A null idx (DM, room post, legacy null-recipient) needs `hasPermission(user,'messages','read',sourceId)`.
    - This is the same predicate as `/messages`, `/messages/channel/:idx` and `MESHCORE_MESSAGE_GATE`.
- `src/server/routes/translationRoutes.ts`:
  - `POST /`: `resolveTranslatableMessageScope(req.user, sourceId).loadReadable([messageId])`, then translate `row.text`. Still ignores client `text`, still 404s with no provider call, middleware unchanged (`requireAuth(), requirePermission('messages','read'), translateLimiter`).
  - `GET /stored`: `scope.canReadAny` → 403, then `scope.loadReadable(stored ids)`.
  - Update the `MAX_MESSAGE_ID_LEN` comment.

### D. Shared composer + MeshCore translation UI (WP4)
- `hooks/useViewTranslations.ts`: `useTranslationSettings(sourceId)`.
- `components/translation/TranslateModal.tsx`: `maxBytes?: number` (default `LORA_PACKET_MAX_BYTES`), used for `isTranslatedOverLimit` and the counter.
- `components/MessageComposeInput.tsx`: new optional props; defaults keep Meshtastic identical.
  ```ts
  draftStore?: ComposeDraftStore;           // default: ComposeDraftContext store
  maxBytes?: number;                        // counter budget, default 200
  blockSendOverLimit?: boolean;             // default false
  buildMentionInsertion?: (c: MentionCandidate) => string;  // default hook's `@!id`
  sending?: boolean;                        // disables textarea + send, aria-busy
  allowNewlines?: boolean;                  // default true; false = Shift+Enter no newline, pasted newlines → spaces
  ```
  Add `useComposeDraftFrom(store?)` in `contexts/composeDraftStore.ts`, or inline `useSyncExternalStore(store.subscribe, store.get)`. Pass the same setter to `MessageEmojiButton` and `useMentionAutocomplete`.
- `MeshCoreMessageStream.tsx`:
  - Draft store: `const [draftStore] = useState(() => createComposeDraftStore())`, per stream instance and not cleared on `conversationKey` change. `inputRef` becomes `useRef<HTMLTextAreaElement>(null)`.
  - Composer: `<div className="meshcore-send-bar message-input-container" title={disabled ? disabledReason : undefined}><MessageComposeInput listId="meshcore-mention-list" textareaRef={inputRef} draftStore={draftStore} mentionCandidates={mentionCandidates} buildMentionInsertion={c => `@[${c.longName}] `} homoglyphEnabled={false} maxBytes={maxBytes} blockSendOverLimit sending={sending} allowNewlines={false} placeholder={t('meshcore.type_message')} disabled={disabled} disabledTitle={disabledReason} onSend={handleSend} sendAriaLabel={t('meshcore.send','Send')} actions={translateButton} /></div>`.
  - Sending: `handleSend` reads `draftStore.get()`, checks `getUtf8ByteLength` against the limit, and clears on success. `handleReply` uses `draftStore.set` plus the existing focus/caret logic. Remove the stream's own `useMentionAutocomplete`, byte counter and `<input>`.
  - Translations: `translatableIds` = messages with `text`, no `reactionEmoji`, not `reactionPending`, and `parseSpip(text) == null`, oldest first. Use `useViewTranslations(sourceId, translatableIds)`. Per row: a Translate button (`UiIcon name="translate"`, `messages.translate`) when `canTranslate && translatable`, and `<TranslatedMessage …/>` after `LinkPreview` (like `ChannelMessageRow` 165-170).
  - Composer `actions` slot: a translate button → `TranslateModal` with `initialText={draftStore.get()}`, `onApply={draftStore.set}`, `maxBytes={maxBytes}` and the default languages from settings.
  - Layout in `MeshCoreMessageStream.module.css` / `.meshcore-send-bar` (tokens only). Limits unchanged (DM 150, channel 130, scoped 120, rooms as today).

## 3. Test plan
- **WP1:**
  - `conversationReadState.test.ts`: `meshcore_room` round trip, `setManyLastReadAsync` monotonic, empty map includes `meshcore_room`.
  - `readStateRoutes.test.ts` (createRouteTestApp): batch happy path; 403 on another source's grant; 400 for bad kind, missing key, >500 entries, missing sourceId; anonymous user with `messages:read` can write.
  - Per-source test: a batch on A is not visible on B.
  - `meshcoreUnreadStore*.test.ts`: room load/mark, hydration, `markManyRead` (`saveMany` once, falls back to `save`, one change event), `computeUnreadRooms` (own post, reaction, muted, active, prefix key, server vs live latest).
  - `useMeshCoreUnread.test.tsx`: rooms dot; muted DM and muted room light no dot.
  - meshcore repo multi-backend test for `latestReceivedAt`.
- **WP2:**
  - `MuteMenu.test.tsx`: both variants, durations (fake timers), unmute only when muted, `onDone`.
  - `MarkAllReadButton.test.tsx`: confirm threshold.
  - Keep green: `ChannelsTab.unreadDropdownBell`, `MessagesTab.unreadDropdown`, `MeshCoreChannelsView.mute`.
  - New: `MeshCoreDirectMessagesView.mute.test.tsx`, `MeshCoreRoomsView.unread.test.tsx`, a ChannelsView mark-all case, and a MeshCorePage rooms-dot case.
- **WP3:**
  - `translations.multiBackend.test.ts`: the sweep keeps a link to a `meshcore_messages` row and removes it once the row is deleted (3 backends).
  - `translations.perSource.test.ts`: same MeshCore id on two sources stays isolated.
  - `translatableMessages.test.ts`.
  - `translationRoutes.meshcore.test.ts` (createRouteTestApp, seeded `meshcore_messages` + `sources` type `meshcore`, mocked provider):
    - translates STORED text, ignoring client text;
    - 404 with no provider call for: channel row without channel/messages read, keyed row without key access, DM without `messages:read`, reaction row, unknown id;
    - channel-only reader can translate that channel's row;
    - `/stored` omits invisible ids;
    - anonymous user with read access gets stored translations;
    - provider never called on `/stored`.
  - Delete-path sweep test (`deleteMessagesByIds`, `deleteAllMessagesForSource`).
- **WP4:**
  - `MessageComposeInput.test.tsx`: `maxBytes` counter, `blockSendOverLimit`, `buildMentionInsertion`, `draftStore` isolation, `allowNewlines={false}`, `sending`; Meshtastic defaults unchanged.
  - `TranslateModal.test.tsx`: `maxBytes`.
  - `MeshCoreMessageStream.test.tsx`: emoji at caret, DM counter `/150`, over-limit blocked, `@[Name] ` autocomplete, reply prefill + focus, receive-only title, Translate button only with `canTranslate`, stored translation renders.
  - Update tests querying the old `<input>` / "Send" text (query role `combobox` / aria-label "Send").
- **Before PR:** full suite with PG + MySQL containers up, `lint:ci`, and a browser check of the 3 MeshCore views plus ChannelsTab/MessagesTab mute and mark-all.

## 4. Work packages
- **WP1 Read-state foundation** (no deps). Files:
  - schema/repo `conversationReadState`, `services/database.ts` (facade line), `readStateRoutes.ts`;
  - `meshcore.ts` **`getRoomStats` only**, `meshcoreManager.getRoomStats` passthrough, room-stats route;
  - `meshcoreUnreadStore.ts`, `useReadStateSync.ts`, `useMeshCoreUnread.ts`, and the `fetchRoomStats` type in `useMeshCore.ts`.
- **WP3 Translation server** (parallel with WP1). Files: `translations.ts`, `meshcore.ts` (new getter + delete sweeps; NOT `getRoomStats`), `meshcoreChannelIdx.ts` (new), `socketEventGates.ts` (import swap), `translatableMessages.ts` (new), `translationRoutes.ts`, `TRANSLATION_CACHE_SPEC.md`.
- **WP4 Shared composer + MeshCore translation UI** (parallel). Files: `MessageComposeInput.tsx`, `composeDraftStore.ts`, `TranslateModal.tsx`, `useViewTranslations.ts`, `MeshCoreMessageStream.tsx` + css, and the stream/view tests that query the composer.
- **WP2 Shared MuteMenu / MarkAllReadButton + MeshCore wiring** (after WP1). Files: `SettingsContext.tsx`, `MuteMenu` (new), `MarkAllReadButton` (new), `ChannelsTab.tsx`, `MessagesTab.tsx`, `MeshCoreChannelsView` + css, `MeshCoreDirectMessagesView`, `MeshCoreRoomsView` (+ css), `MeshCorePage`, `MeshCoreSubToolbar` (test only).
- **Overlap:**
  - `meshcore.ts`: WP1 (`getRoomStats`) and WP3 (other functions) edit different functions, but not at the same moment; re-read before editing.
  - `en.json`: additive; re-read before editing.
  - `MeshCoreMessageStream.tsx`: WP4 only.
  - `ChannelsTab`/`MessagesTab`: WP2 only.
- **Order:** Wave 1 WP1 ∥ WP3 ∥ WP4 → Wave 2 WP2.

## Notes
- MeshCore has no DM/room push yet (#6253, P11). In this phase, DM/Room mute affects unread dots only; P11 reuses the same `mutedDMs`.
- `POST /api/translate` keeps `requirePermission('messages','read')` without `sourceIdFrom` (free-text mode has no source); the per-source check runs inside `resolveTranslatableMessageScope`, same as Meshtastic today.
