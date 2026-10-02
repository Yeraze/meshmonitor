# Translation cache (#5520) — spec

Follow-up to #5480 (inline message translation). Plugs into the
`ITranslationCache` seam (`src/server/services/translation/translationCache.ts`,
currently `NoOpTranslationCache`). Goal: a message translated once is reused,
including by anonymous viewers, without another provider call. Maintainer
decisions are recorded on #5520.

Scope: the Meshtastic `messages` table (the views that have translation today:
`ChannelsTab`, `MessagesTab`). MeshCore messages are out of scope.

## Two tables (migration 188, all three backends)

`translation_cache` — the shared text cache (server-internal, global)
- `cacheKey` PK: sha256 of `normalize(text) + '\0' + targetLang (+ '\0' + sourceLang if given)`.
  `normalize` = trim, collapse internal whitespace, Unicode NFC. Case is kept.
- `targetLang`, `sourceLang` (nullable), `translatedText`, `detectedSourceLanguage`,
  `provider`, `createdAt`, `lastUsedAt` (ms), `hitCount`, `messageRefCount`.
- **The source text is not stored**, only its hash. A DB reader cannot recover
  message text from the cache, and lookup is by hash only.
- Global by design: no `sourceId`. Clients can never query it by text (see Rules).

`message_translations` — per-source link from a message to a cache entry
- PK `(sourceId, messageId, targetLang)`; column `cacheKey` → `translation_cache`.
- `createdAt`. Per-source per CLAUDE.md (`withSourceScope`, `*.perSource.test.ts`).
- Delete with the message: hook every path that deletes `messages` rows
  (retention purge, per-channel / per-node / bulk delete, source delete) or use
  an FK cascade where all three backends support it. Find every delete path.

## Expiry (maintainer decisions)

- Unpinned cache entries expire **30 days after last use** (`lastUsedAt`,
  refreshed on every hit), plus a **size cap of 10,000 rows**, pruning the
  least recently used first.
- **Pinned = referenced by ≥ 2 distinct messages** (`messageRefCount >= 2`,
  e.g. "Hi", "Welcome", "Good morning"). Pinned entries never expire and are
  exempt from the size cap.
- **Never prune an entry while any `message_translations` row references it**,
  so a viewer can always see a stored translation for a message that still
  exists. Prune only rows with `messageRefCount = 0` that are past the TTL or over the cap.
- `messageRefCount` is maintained when links are added and removed.
- Pruning runs on a slow schedule (e.g. hourly) and at startup. It is DB-only,
  with no mesh traffic.

## Write path (authenticated translate)

- `POST /api/translate` gains optional `{ sourceId, messageId }`. When present:
  1. Load the message from the DB, scoped by `sourceId`, through the same
     visibility check the message-list endpoints apply for this user (channel
     read permission / DM visibility / virtual channel `canRead`). Not visible
     or not found → 404, with no provider call.
  2. **Translate the stored message text, not any client-supplied text** (this
     closes off cache poisoning: a user claiming message 123 says something
     else). Ignore or reject a mismatching `text`.
  3. Cache lookup by hash. On a hit, refresh `lastUsedAt` and bump `hitCount`.
     On a miss, call the provider and insert.
  4. Upsert the `message_translations` link and maintain `messageRefCount`.
- Without `{sourceId, messageId}` (the composer, or free text): text cache only,
  never linked. **Outbound composer drafts must not create links.**
- `testConfig()` never reads or writes the cache (already true after #5480).
- Skipped results (non-conversational) and provider errors are not cached.

## Read path (any viewer, including anonymous)

- `GET /api/translate/stored?sourceId=…&lang=…&messageIds=a,b,c`
  (cap ~200 ids per call), with optionalAuth.
  - Returns `{ [messageId]: { translatedText, detectedSourceLanguage, provider } }`
    for linked messages the viewer can read, using the **same visibility check**
    as above, applied per message. Ids that aren't visible are silently omitted
    (no existence oracle).
  - **Never calls a provider.** Reads only. Gate it on translation being
    enabled, and on the viewer having message read access on that source
    (anonymous users go through the anonymous permission set like any other read).
  - Apply a reasonable read limiter (reuse an existing one).
- No route ever accepts text to look up in the cache.

## UI

- `useMessageTranslation` / `TranslatedMessage`: send `{sourceId, messageId}`
  with translate calls made from a message (not from the composer).
- For every viewer (anonymous included), fetch stored translations for the
  visible messages in the user's preferred target language (existing
  localStorage preference, else browser language), batched per view, and show
  them with the existing translated-message UI. A message with a stored
  translation shows it without a click. Keep it collapsible if the current UI
  pattern supports that, and keep the original text visible.
- Anonymous viewers get only stored translations: no Translate button.

## Rules (CLAUDE.md)

Raw SQL only in repositories/migrations; Drizzle schema for all three backends;
idempotent migration with the shared helpers; `.js` relative imports; ok()/fail()
with the ApiService envelope gotcha; route tests via `createRouteTestApp`;
`createReactI18nextMock` in component tests; new settings (if any) in
`VALID_SETTINGS_KEYS`. Any route that can exceed 30 s needs
`extendRequestTimeout` plus a pin-test entry (not expected here).

## Mesh impact

None: DB and provider HTTP only. Fewer provider calls than today.

## Tests

- Normalization and hashing.
- TTL / LRU / pin / reference-protection pruning, including the
  "pinned never pruned" and "referenced never pruned" cases.
- Write path:
  - uses the stored message text and ignores the client's;
  - 404 for a message that isn't visible, with no provider call;
  - a hit bumps `lastUsedAt` and `hitCount`;
  - composer translations don't link.
- Read path:
  - omits messages the viewer can't see;
  - anonymous viewers with read access get stored translations;
  - never calls the provider.
- Link cleanup on message delete / purge.
- `*.perSource.test.ts` for `message_translations`.
- Migration on SQLite + PG + MySQL, with the containers running.
- Component tests for showing stored translations to anonymous viewers.

## Implementation notes (as built)

- **Cache key encoding.** The key is sha256 of the JSON-encoded tuple
  `[normalize(text), targetLang, sourceLang|null]`, not a `'\0'` join: mesh
  text can contain NUL, and a plain join lets `"a\0en"→es` collide with
  `"a"→en from es`, so one message could poison another's entry. Language
  codes are lowercased; `auto`/empty source language keys as `null`.
- **Free text skips the cache in both directions.** Only message-linked
  translations (`{sourceId, messageId}`) read or write `translation_cache`.
  A free-text read would let any translator probe, via `cached`/timing,
  whether a phrase was ever translated (the issue's "never queryable"
  rule), and a free-text write would put composer drafts in a shared table.
  `/api/v1/translate` (free text only) also skips it.
- **Pinning is sticky** (`translation_cache.pinnedAt`, ms, nullable). It is
  set the first time an entry reaches `messageRefCount >= 2` (in
  `linkMessage`, and by the prune's reconcile for links added any other way)
  and is never cleared: not by a recount, the orphan sweep or a purge. So a
  reused phrase keeps its translation after its messages are purged.
  `messageRefCount` stays the live link count.
- **Prune rules.** TTL deletes only rows that are unpinned AND unreferenced
  and idle for 30 days. The 10,000 cap counts only unpinned, unreferenced
  rows and evicts the least recently used of them. Pinned and referenced rows
  are never deleted and do not count toward the cap.
- **Link cleanup.** No FK (SQLite would need the composite parent key; MySQL
  needs exact column types). Every `MessagesRepository` delete path
  (`deleteMessage`, `purgeChannelMessages`, `purgeDirectMessages`,
  `purgeMessagesFromNode`, `cleanupOldMessages[ForSource|Sqlite]`,
  `deleteAllMessages[Sqlite]`) sweeps orphaned links and recounts
  `messageRefCount`. Paths that bypass the repository (FK cascade from a node
  delete, node-identity merges, restore) are swept by the hourly prune, and
  the read path only serves links whose message row still exists.
- **Read limiter.** `/stored` sits behind the global `apiLimiter` on `/api`;
  a second limiter would double-count.
- **Viewer language.** Stored translations are fetched, and new ones
  requested, in the same language: saved inbound preference, else the first
  supported browser language, else the server default.
- **Not backed up.** Neither table is in `BACKUP_TABLES`; the cache rebuilds
  on demand, and links whose messages are not restored are swept hourly.
