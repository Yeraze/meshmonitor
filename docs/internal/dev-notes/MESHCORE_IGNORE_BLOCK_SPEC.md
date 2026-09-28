# MeshCore Ignore / Block (#5408) — spec

MeshCore firmware has no block or mute, so the whole policy lives in
MeshMonitor. Two kinds of entry, both **per-source**, both with two modes.

## Decisions (from the maintainer, 2026-09-28)

| Question | Decision |
|---|---|
| Does a node entry filter channel messages? | **Yes**, by matching the channel sender name to the node's advert name (case-insensitive). Spoofable and collision-prone; the UI says so. |
| Scope | **Per-source** for both node entries and text rules. |
| Blocked-message visibility | **Hit counter + last-hit time** per entry. No content kept. |
| Rule fields | **Selectable per rule**: sender name, body, or both (default both). |

## Modes

- **Ignore** — the message is stored. It fires no notification, automation,
  auto-ack or auto-responder, and does not count as unread. The channel/DM view
  collapses a run of consecutive ignored messages into one
  `N ignored messages` row; clicking it expands them. Removing the entry makes
  them render normally again, so the ignored state is **computed at read time
  from the current lists, never stored on the message row**.
- **Block** — the message is discarded on receipt: not stored, not emitted, no
  automation, no auto-ack/auto-responder. Only the entry's hit counter moves.
- **Both** — an ignored or blocked node is hidden from the MeshCore node list,
  the Node Details view and the map. Adverts still update its `meshcore_nodes`
  row (so un-ignoring shows current data); only display is suppressed.

Block wins over ignore when a message matches entries of both modes.

## Data (migration 182, all three backends)

`meshcore_ignored_nodes` — PK `(sourceId, publicKey)`
- `sourceId`, `publicKey` (64-hex), `name` (advert-name snapshot at ignore
  time, refreshed when a newer name is seen; used for channel matching and so
  the Settings list stays readable after the node row is pruned — the #1796
  lesson: this table is the authority, independent of `meshcore_nodes`)
- `mode` `'ignore' | 'block'`, `createdAt` (ms), `createdBy` (user id, nullable)
- `hitCount` (int, default 0), `lastHitAt` (ms, nullable)

`meshcore_message_filters` — PK `id`
- `id`, `sourceId`, `mode` `'ignore' | 'block'`
- `matchType` `'exact' | 'wildcard' | 'regex'`, `pattern`, `caseSensitive`
  (bool, default false), `fields` `'name' | 'body' | 'both'` (default `'both'`)
- `enabled` (bool, default true), `createdAt`, `createdBy`,
  `hitCount`, `lastHitAt`

Every query scopes by `sourceId`. Add a `*.perSource.test.ts`.

## Matching (server; one shared module)

`src/server/services/meshcoreMessageFilter.ts` exposes
`classifyMeshCoreMessage(sourceId, { fromPublicKey, fromName, text, kind })`
→ `{ action: 'allow' | 'ignore' | 'block', entryKind, entryId }`.

- **Node entry, DM / room post:** match by public key. DMs carry a 6-byte
  prefix; resolve to the full key the same way ingest already does, and also
  accept a prefix match against the stored key.
- **Node entry, channel message:** match `fromName` (parsed from `"Name: body"`)
  to the entry's `name` or the contact's current advert name,
  case-insensitive, trimmed.
- **Text rule:** `exact` = whole-field equality; `wildcard` = `*` any run,
  `?` one char, everything else literal, anchored at both ends; `regex` =
  compiled with `compileUserRegex` (RE2, `src/utils/safeRegex.ts`) — reject
  patterns RE2 refuses **at save time** with a 400. Cap pattern length (256).
  Checked against the chosen field(s).
- Rules and node entries are cached in memory per source (like
  `ignoredNodes.isIgnoredCached`) and the cache is invalidated on every write.
  Compile each rule once, not per message.
- Hit counts: increment in memory and flush to the DB in a batch at most every
  30 s and on shutdown. Losing a few counts on a crash is acceptable.

## Where it plugs in

- Ingest: `meshcoreManager.handleBridgeEvent` — `contact_message`,
  `channel_message`, `room_message`, before `addMessage` — and the MeshCore MQTT
  manager's message path (`meshcoreMqttManager.ts`). Block → return early.
  Ignore → store, but skip `emitMeshCoreMessage`-driven notifications,
  automation events, auto-ack and auto-responder. The socket event still goes
  out, flagged `filtered: 'ignore'`, so an open view can collapse it.
- Read: message list endpoints annotate each message with
  `filtered: 'ignore'` when it currently matches an ignore entry. Unread counts
  exclude ignored messages.
- Node list / map / Node Details: exclude nodes with an entry (server-side where
  the list is built, or client-side from the entry list — pick one place and
  cover all three views).

## API (under the existing MeshCore routes, per-source)

- `GET/POST/DELETE /api/sources/:id/meshcore/ignored-nodes[/:publicKey]`
- `GET/POST/PUT/DELETE /api/sources/:id/meshcore/message-filters[/:id]`
- Read needs MeshCore read permission on the source; writes need MeshCore
  write. Use `ok()` / `fail()`. Route tests use `createRouteTestApp()`.

## UI

- Node Details (`MeshCoreContactDetailPanel`): **Ignore** and **Block**
  buttons (confirm for Block), or **Remove from ignore/block list** when the
  node already has an entry.
- Settings, MeshCore source: two sections — the node list (name, key prefix,
  mode, hits, last hit, delete) and the text rules (add/edit/delete, enable
  toggle, match type, fields, case, mode, hits, last hit). Show the RE2 error
  inline on save. Note beside channel matching that names can be spoofed.
- Channel and DM streams (`MeshCoreMessageStream`): collapse consecutive
  `filtered: 'ignore'` messages into an `N ignored messages` row that expands on
  click. Icons via `UiIcon`; styles in a CSS module.

## Mesh impact

Sends no packets. It *reduces* traffic: ignored/blocked messages no longer
trigger auto-ack or auto-responder replies. No timer re-arms on save; the only
timer is the hit-count flush, which touches only the DB.
