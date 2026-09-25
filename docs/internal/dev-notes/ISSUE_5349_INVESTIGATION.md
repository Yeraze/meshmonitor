# Issue #5349 investigation: MeshCore "prefix collision" symptoms

Worktree: `/home/yeraze/Development/mm-5349` (branch `fix/5349-meshcore-prefix-collision`, base `acaf9962`).
Firmware source: local MeshCore checkout `/home/yeraze/Development/MeshCore` at `a3a1aa5e`
(reporter's firmware version unknown). meshcore.js: `node_modules/@liamcottle/meshcore.js`
(pinned `github:Yeraze/meshcore.js#bd710fcc`, package version 1.13.0).

## Bottom line

The issue's causal story is mostly wrong. `resolveContactByPrefix` does return the first
`startsWith` match, but almost every caller hands it a 6-byte (12 hex) or longer prefix, so
a shared first byte (`57`) or shared two bytes (`5708`) cannot collide there. **None of the
three symptoms runs through the resolver.**

| Symptom | Real cause | Resolver? | Confidence |
|---|---|---|---|
| 1. Repeater never shows as repeater | The companion firmware drops adverts whose timestamp is `<=` the stored one (replay guard), so the device's stored `type` freezes. MeshMonitor then copies the device's type back over everything on each `refreshContacts()`. A second, UI-only path turns an unknown type into `0` (explained below). | No | Firmware drop and MeshMonitor copy-back CONFIRMED in code. That this is what hit the reporter is a HYPOTHESIS. |
| 2. Instant login fail, no RF | The firmware looks up `CMD_SEND_LOGIN` by the **full 32-byte key**. A contact that is not in the companion's contact table gets `ERR_CODE_NOT_FOUND` back at once. MeshMonitor shows contacts the device does not hold (`NewAdvert` 0x8A pushes, evicted contacts) and never checks first. The error is also swallowed: no log line, generic 401. | No | Mechanism CONFIRMED in code. That the reporter's repeaters were missing from the table is a HYPOTHESIS. |
| 3. Nodes list shows 6 / 7 / 13 | On the frontend, `recomputeNodes()` replaces the DB-backed `nodes` list (from `/snapshot`) with "local node + in-memory contacts" on every contact or local-node push. Nodes stored only in the DB vanish until the page reloads. | No | CONFIRMED |

The resolver still has a real flaw (it silently picks one contact out of several). Only one
caller gives it a prefix short enough for that to matter: the "heard repeaters" naming at
`meshcoreManager.ts:2339`, which passes 1 to 3 byte path hashes. That call mislabels names.
It does not affect `advType`, login, or list membership. Fix it anyway (see the plan below),
but the fix will not resolve the reported symptoms.

---

## 1. `resolveContactByPrefix`: every call site and the prefix length it gets

The resolver, `src/server/meshcoreManager.ts:5688-5696` (CONFIRMED):
```ts
resolveContactByPrefix(prefix: string): MeshCoreContact | undefined {
  if (!prefix) return undefined;
  const exact = this.contacts.get(prefix);
  if (exact) return exact;
  for (const c of this.contacts.values()) {
    if (c.publicKey.startsWith(prefix)) return c;
  }
  return undefined;
}
```

| Site | Input | Length (hex) | Where the length comes from | Realistic collision? |
|---|---|---|---|---|
| mgr:1771 | `data.pubkey_prefix` (contact_message) | 12 | nativeBackend:732 `bytesToHex(msg.pubKeyPrefix)`; meshcore.js connection.js:779 `readBytes(6)` | No |
| mgr:1874 | `room_pubkey_prefix` | 12 | nativeBackend:718, same 6-byte ContactMsgRecv field | No |
| mgr:1876 | `author_pubkey_prefix` | **8** | nativeBackend:711-714: first 4 bytes of the SignedPlain text | Unlikely but possible (4 bytes) |
| mgr:2047 | path_discovery_response `pubkey_prefix` | 12 | nativeBackend:805 `frame.slice(offset, offset + 6)` | No |
| **mgr:2339** | `match.pathHops` hash (channel echo "heard by") | **2 / 4 / 6** | 1-3 byte route hash width from the packed path_len | **Yes.** With 1-byte hashes, every `57xx…` repeater collides. |
| mgr:5228 | `n.publicKeyPrefix` (binary get_neighbours) | 16 | nativeBackend:2361 calls `c.getNeighbours(..., 8)`; connection.js:2551 `readBytes(pubKeyPrefixLength)` | No |
| mgr:5742 | CLI `neighbors` `entry.pubkeyPrefix` | 8 | `utils/parseMeshcoreNeighbors.ts:30` requires `^[0-9a-f]{8}$` | Unlikely (4 bytes) |
| mgr:7328 | auto-pathfinding neighbours | 16 | same getNeighbours path | No |
| mgr:7785 | `message.fromPublicKey` (automation env) | 12 (DM) | `fromPublicKey: data.pubkey_prefix` at mgr:1784 | No |
| mgr:7954 | same (auto-responder DM target) | 12 | same | No |
| mgr:8216 | same (auto-ack ignore list) | 12 | same | No |
| mgr:8254 | same (auto-ack sender name) | 12 | same | No |
| mgr:8289 | same (auto-ack DM target) | 12 | same | No |
| contactsRoutes:735 | neighbours route `n.publicKeyPrefix` | 16 | getNeighbours | No |
| contactsRoutes:1527 | `normalizedKey`, validated `^[0-9a-f]{64}$` at :1524 | 64 | exact hit | No |
| routeShared:341 | CLI neighbours text, validated `^[0-9a-f]{8}$` at :335 | 8 | CLI format | Unlikely |

The issue lists `:1974` as "CLI reply matching". That line does not call the resolver. It reads
`this.pendingCliReplies.get(prefix)`, keyed by `normalizedKey.substring(0, 12)`
(`meshcoreManager.ts:5861`), so it is 6-byte matching and safe.

The other first-match resolvers found in this investigation:
- `meshcoreNativeBackend.ts:2565-2580` `resolvePublicKey()`: a 64-hex key bypasses it. Any shorter
  key takes the first `fullHex.startsWith(normalized)` match over the device contact list. Every
  current route validates 64 hex, so this is latent.
- Frontend, all fed 12-hex DM prefixes: `MeshCoreDirectMessagesView.tsx:157` (`canonicalize`),
  `MeshCoreMessageStream.tsx:159,171`, `MeshCoreMessageRouteModal.tsx:104`,
  `meshcoreUnreadStore.ts:253`. Low risk.

### Protocol facts used (source of each)
- ContactMsgRecv, LoginSuccess, StatusResponse and TelemetryResponse all carry a **6-byte**
  pubkey prefix. VERIFIED in meshcore.js `connection.js:473, 491, 507, 779`.
- `sendCommandSendLogin` writes the **full 32-byte** key. VERIFIED at `connection.js:231-236`.
  `sendTextMessage` sends the first 6 bytes (`connection.js:53`).
- meshcore.js `login()` matches LoginSuccess on 6 bytes (`connection.js:1634, 1658`). It rejects
  with no argument on **any** `Err` frame that arrives before `Sent`: `onErr = () => {...reject()}`,
  registered with `this.once(ResponseCodes.Err, onErr)`. VERIFIED.
- Firmware `CMD_SEND_LOGIN` looks up the full 32-byte key and answers `ERR_CODE_NOT_FOUND` if the
  contact is missing. VERIFIED in `MeshCore/examples/companion_radio/MyMesh.cpp:1514-1535`, using
  `BaseChatMesh::lookupContactByPubKey`, a `memcmp` over `prefix_len` at `BaseChatMesh.cpp:831-837`.
- Firmware push codes: `PUSH_CODE_CONTACT_DELETED 0x8F` and `PUSH_CODE_CONTACTS_FULL 0x90`
  (`MyMesh.cpp:127-128`). `ERR_CODE_NOT_FOUND = 2` and `ERR_CODE_TABLE_FULL = 3` (`:131-132`).

---

## 2. Symptom 1: the repeater never shows as a repeater

### What sets advType (all CONFIRMED)
Every write is keyed by the **full** public key. None uses a prefix:
- `contact_advertised` / `contact_added`, `meshcoreManager.ts:1902-1925`:
  `const publicKey: string = data.public_key; ... advType: data.adv_type ?? existing.advType`.
  - `contact_advertised` comes from firmware push 0x80 and carries **only the 32-byte pubkey**
    (`meshcoreNativeBackend.ts:782-786`), so `adv_type` is undefined and advType is unchanged.
  - `contact_added` comes from 0x8A NewAdvert and carries the full advert, `adv_type: a.type`
    (`nativeBackend:777-779, 1040-1048`).
- `node_discovered`, mgr:2091: full key from the 0x8E frame. The issue calls mgr:2091 and :2152
  "contact-info update / new-contact insert". **That is wrong.** Both lines are the node-discovery
  handler, and :2152 is only the discovery-session tally.
- `refreshContacts()`, mgr:3239-3270: `this.contacts.clear()` and then `advType: c.adv_type`,
  taken from the device's stored `ct.type` (nativeBackend:1306). This **overwrites** anything
  learned from adverts. `persistContact` then writes it to `meshcore_nodes` (mgr:2507
  `advType: contact.advType ?? null`).

Result: **the companion device's stored contact type is the source of truth.** MeshMonitor
re-applies it on every refresh: on connect (mgr:1319-1320), on the debounced path refresh, and
elsewhere.

### Why the device's type can freeze (firmware, CONFIRMED in source)
`MeshCore/src/helpers/BaseChatMesh.cpp:120-129`:
```cpp
for (int i = 0; i < num_contacts; i++) {
  if (id.matches(contacts[i].id)) {
    from = &contacts[i];
    if (timestamp <= from->last_advert_timestamp) {  // check for replay attacks!!
      ...
      return;
```
The type update at `:178` (`from->type = parser.getType();`) sits **after** that guard. Say the
device stored an advert whose timestamp, on the sender's clock, is later than what the repeater
now sends. That happens when a node was a companion with phone-synced time and got reflashed as
a repeater whose RTC restarts near the build date, or when a repeater's clock was once ahead.
From then on, every advert is dropped silently until the repeater's clock passes the stored
value. Name, position and type all stay frozen. No 0x80 push reaches MeshMonitor, and the next
`refreshContacts()` writes the stale type again. That matches "no matter how many times it
re-advertises". Tying it to this reporter is a HYPOTHESIS.

The report also claims that login works only on repeaters with a unique first byte. Nothing in
the code links first-byte uniqueness to any of these three mechanisms, so treat that as
coincidence until shown otherwise.

How to check on the reporter's mesh: compare the device contact's `lastAdvert` (from
`get_contacts`) with the repeater's advert timestamps in the raw packet feed. A stored
`lastAdvert` greater than or equal to the live advert timestamps confirms it. Removing the
contact from the companion and re-adding it clears the frozen record.

### A second, UI-only path that shows the wrong type (CONFIRMED)
`useMeshCore.ts:533-541` `contactToNode`: `advType: c.advType ?? 0`. `recomputeNodes()`
(`:545-575`) rebuilds `nodes` from contacts only. So a contact whose in-memory `advType` is still
undefined (for example, just after a pubkey-only 0x80 advert and before the debounced refresh)
gets type 0/Unknown. The DB's correct `advType` is never read. Then `MeshCoreNodesView.tsx:108`
keeps that `0`, because `existing.advType ?? c.advType` does not fall back on a non-nullish `0`.

---

## 3. Symptom 2: "Log in" fails instantly with no RF

End to end (CONFIRMED):
1. The UI mounts the console only for `advType === 2 || 3`
   (`MeshCoreContactDetailPanel.tsx:1184-1189`). `publicKey` is the full contact key
   (`MeshCoreDirectMessagesView.tsx:556-557`).
2. Route `POST /admin/login` requires 64 hex (`meshcoreAdminRoutes.ts:60`) and calls
   `loginToNode` (`:76`). Any falsy result becomes `401 'Login failed'` (`:77-82`).
3. `loginToNodeWithOutcome` (mgr:5403-5448) calls `sendBridgeCommand('login', { public_key })`
   inside `sendWithDefaultScope`.
4. The native backend's `case 'login'` (nativeBackend:2018-2058): `resolvePublicKey` sees 64 hex
   and converts it straight to bytes. **It does not check that the device holds the contact.**
   It then races `c.login()` against the 0x86 `awaitLoginRejection` watcher (6-byte match).
5. meshcore.js sends `CMD_SEND_LOGIN` with the full 32-byte key.
6. The firmware's `lookupContactByPubKey(pub_key, PUB_KEY_SIZE)` fails, `writeErrFrame(ERR_CODE_NOT_FOUND)`
   answers at once, and **nothing is sent over the air.** Other Err causes: `MSG_SEND_FAILED` gives
   `ERR_CODE_TABLE_FULL` (packet pool). A stray Err from another command in flight on the same
   connection has the same effect, because of meshcore.js's uncorrelated `once(Err)`.
7. meshcore.js `onErr` calls `reject()` with **no argument**. `sendCommand` turns that into
   `{ success: false, error: "undefined" }`. The manager returns `outcome: 'no_reply'` and
   **logs nothing** on that branch (mgr:5438-5443). The route returns the generic 401.

Why MeshMonitor offers login on contacts the device does not hold (CONFIRMED):
- Firmware sends **0x8A NewAdvert only when it did NOT store the contact**: in manual-add mode
  for that type, past the auto-add hop limit, or with the table full and no overwrite
  (`BaseChatMesh.cpp:142-167`; `MyMesh.cpp:350-358`). MeshMonitor treats it exactly like a stored
  contact (`nativeBackend:773-779`, mgr:1902). The contact enters `this.contacts` and gets pushed
  to the UI with `advType: 2`, so the Log-in button appears for a key the companion does not have.
- With overwrite-oldest on, the firmware evicts contacts and pushes **0x8F CONTACT_DELETED**
  (`MyMesh.cpp:334-341`). MeshMonitor ignores 0x8F and 0x90:
  ```
  $ rtk proxy grep -rn -E "0x8F|ContactDeleted|contact_deleted|CONTACTS_FULL|ContactsFull" src/server/ --include=*.ts | grep -v "\.test\."
  (no output, exit=1)
  ```
  The frontend's `contactsRef` keeps evicted contacts until the page reloads.
- A busy mesh with many neighbours fills the default `MAX_CONTACTS 100` table
  (`MyMesh.h:59`), which makes both cases likely for this reporter (HYPOTHESIS).

The issue says there is a "pending-request map keyed by prefix" for login. There is none in
MeshMonitor: `grep -rn "pendingLogin\|loginPending\|pendingLogins" src/server` returns nothing.
Login correlation lives inside meshcore.js (6 bytes) and in `awaitLoginRejection` (6 bytes).

---

## 4. Symptom 3: Nodes list alternates between 6, 7 and 13 entries (CONFIRMED)

- `/snapshot` returns two different sets (`meshcoreDeviceRoutes.ts:164-165`):
  `contacts = manager.getContacts()` (the in-memory map, which after `refreshContacts()` equals
  **the device contact table**, since `this.contacts.clear()` runs at mgr:3240) and
  `nodes = await manager.getAllNodes()` (**DB rows** merged with in-memory contacts,
  mgr:6600-6650).
- `loadSnapshot` sets `nodes` to the full DB-backed list (`useMeshCore.ts:619`). That is the
  "13".
- `onContactUpdated` (`useMeshCore.ts:694-702`), `onLocalNodeUpdated` (`:725-730`) and the
  refresh and remove actions (`:954`, `:1473`) all call `recomputeNodes()`. It **replaces**
  `nodes` with `localNode + contactsRef` (`:545-575`). Every node known only from the DB drops
  out. That is the "6", then "7" as one more contact push arrives. Reloading the page runs
  `loadSnapshot` again and brings back all 13, which matches "refreshing repopulates".
- `setMeshCoreNodes(mapContactsToNodes(...))` (`:622`, `:700`) feeds the map context from
  contacts only as well.
- Side effect: `recomputeNodes` also drops the DB `lastHeard`, `advType` and battery fields in
  favour of contact fields. `lastSeen` after a refresh comes from the device's `lastAdvert`, which
  is the **sender's** clock (mgr:3253-3268). That value can push rows past the age filter in
  `MeshCoreNodesView.tsx:321-326`, so the filtered count keeps moving.

No step here keys anything by prefix. `mergeNodesAndContacts` (`MeshCoreNodesView.tsx:70-122`)
keys by full `publicKey`.

---

## 5. Fix plan

### A. Symptom 3 (frontend, small, highest value)
- `recomputeNodes` must **merge into** `prev`, not rebuild from contacts. Start from
  `new Map(prev.map(n => [n.publicKey, n]))`, lay each contact over its entry, and keep DB-only
  fields and DB-only rows. Honour removals explicitly (the `:1473` remove path already filters
  `contacts` and should filter `nodes` the same way).
- In `contactToNode`, leave `advType` undefined and fall back to the previous node's `advType`
  instead of `?? 0`.
- Prefer merging `setMeshCoreNodes` from the merged node list too.
- **Test** (`useMeshCore.recomputeNodes.test.ts`, pattern from `useMeshCore.isLocal.test.ts`):
  send a snapshot with 13 nodes and 6 contacts, emit one `meshcore:contact:updated` and one
  `meshcore:localNode:updated`, and assert `nodes.length` stays 13. A second case: a contact push
  with `advType` undefined for a node the DB lists as repeater keeps `advType === 2`.

### B. Symptom 2 (backend: fail fast with a clear message, stop offering impossible logins)
- In the native backend `login`, `get_status` and `send_cli` paths (and any other command the
  firmware looks up by full key), check membership before sending: `getContacts()` contains the
  key (or `CMD_GET_CONTACT_BY_KEY` 30). If missing, throw a distinct error such as
  `MESHCORE_CONTACT_NOT_ON_DEVICE`.
- Capture the firmware `errCode` during `login`: listen for `ResponseCodes.Err` (meshcore.js
  emits `{errCode}` at `connection.js` `onErrResponse`) alongside `c.login()`, or check on the
  raw frame. Map 2 to NOT_ON_DEVICE and 3 to TABLE_FULL.
- In `loginToNodeWithOutcome`, log the failure reason and return it. In the route, return
  `fail(res, 409, 'CONTACT_NOT_ON_DEVICE', 'This contact is not in the companion's contact table (table full or manual-add mode). Add it to the device first.')`
  instead of a generic 401.
- Track device membership: tag contacts from 0x8A `contact_added` as `onDevice: false` (the
  firmware only sends 0x8A for **unstored** contacts). Handle 0x8F CONTACT_DELETED (mark
  `onDevice: false` and push an update) and 0x90 CONTACTS_FULL (warn once, show a UI banner). In
  the detail panel, disable "Log in" for `onDevice === false` with a tooltip. An "Add to device"
  action (`AddUpdateContact`) costs no airtime but can evict another contact when the table is
  full. **Ask the user** whether to offer it and whether to protect favourites.
- **Tests:** a native-backend unit test where the mocked `getContacts` lacks the key: the login
  command rejects with NOT_ON_DEVICE and `c.login` is never called. A mocked Err frame with
  errCode 2 maps to the distinct error. A route test with `createRouteTestApp` asserts
  `409 CONTACT_NOT_ON_DEVICE`. A manager test asserts that 0x8A marks `onDevice:false` and a
  0x8F event marks an existing contact off-device.

### C. Symptom 1 (make the frozen type visible, avoid regressing a correct type)
- In `refreshContacts()`, keep refresh authoritative for membership. When the device's
  `lastAdvert` is not newer than what MeshMonitor has seen for that key, and MeshMonitor has a
  more recent advert-derived `advType` (from a 0x8A or a 0x8E discovery), keep the newer
  `advType` instead of overwriting it with the device's stale value. This needs a per-contact
  `advTypeSeenAt` next to `lastAdvert`. MeshMonitor has no independent advert timestamp for
  0x80-only contacts, so this helps only when a 0x8A or 0x8E carried the type.
- Detection and user remedy (preferred over guessing): when a raw OTA advert (0x88 LogRxData)
  decodes to a key the device holds, with `advert.timestamp <= device.lastAdvert`, log a warning
  and flag the contact "device ignoring adverts (replay guard). Remove and re-add the contact to
  refresh." Removal plus re-add clears the stored timestamp. This needs advert decoding on the
  companion path. Check whether `@michaelhart/meshcore-decoder` (already a dependency) exposes the
  advert timestamp and type. **This part is a HYPOTHESIS.** Confirm the reporter's case (stored
  `lastAdvert` against the live advert timestamps) before building it.
- **Tests:** a manager test where a 0x8E node_discovered sets `advType:2`, then a `get_contacts`
  returns the same key with `type:1` and a stale `last_advert`. Assert which one wins per the
  chosen policy. A frontend test for the `?? 0` fix (see A).

### D. Resolver hardening (correctness; does not fix the symptoms)
- Change `resolveContactByPrefix(prefix)` to return `undefined` when **more than one** contact
  matches (the exact full-key hit still wins). Add `resolveContactsByPrefix(prefix): MeshCoreContact[]`
  for callers that want every candidate.
- Per call site:
  - **mgr:2339** (1-3 byte hop hash, the only realistic collision): take the candidates and set
    `repeaterName` only when exactly one repeater or room-server candidate exists. Filter
    candidates to `advType` 2/3, because hops are repeaters. Otherwise store `null`, or
    `"A / B"` if the UI wants it. Keep storing the raw hash.
  - mgr:1876 (4-byte author), mgr:5742 and routeShared:341 (4-byte CLI neighbours): on
    ambiguity return undefined. Callers already fall back to the prefix string or skip.
  - mgr:1771, 1874, 2047, 5228, 7328, 7785, 7954, 8216, 8254, 8289, contactsRoutes:735 and 1527
    (6 or more bytes): no behaviour change, the new ambiguity rule is harmless. mgr:8289 and 7954
    (DM replies) are the ones where picking the wrong contact would **send to the wrong node**,
    so returning undefined on ambiguity is the right failure. They already log and skip.
- `meshcoreNativeBackend.ts:2565` `resolvePublicKey`: collect every match and return `null` when
  there are two or more. Every current caller passes 64 hex.
- Frontend `canonicalize` / `fullKeyFor` / `nameForKey` / unread store / route modal: the same
  unique-match rule (a shared helper, `uniquePrefixMatch(list, key)`).
- **Tests** (`meshcoreManager.resolveContactByPrefix.test.ts`): seed contacts `5708aa…`,
  `5708bb…`, `5710cc…`.
  - `resolveContactByPrefix('5708aa…'(12))` returns the right contact.
  - `resolveContactByPrefix('57')` returns undefined (ambiguous).
  - `resolveContactByPrefix('5710')` returns the unique one.
  - A full key returns an exact hit.
  - A channel echo with a 1-byte path hash `57` records `repeaterName: null` when two
    repeaters share it, and the name when only one repeater has that byte (a chat node sharing
    it does not count).

### Mesh impact
A and D send nothing. B's pre-flight is a local serial read (`get_contacts`, no airtime) and
cuts useless login attempts. The optional "Add to device" is local too, but it can evict
contacts, so the user decides. C's detection is passive. None of this adds timers or TX.

### Priority
A, then B (error visibility plus the `onDevice` flag), then D, then C. Confirm C with the
reporter (compare the device contact's `lastAdvert` with live advert timestamps) before
building it.

---

## Resolution (branch `fix/5349-meshcore-prefix-collision`)

Implemented A, B, and D, plus an "Add to radio" action. C (the stale-type
warning) is out of scope.

- **A**: `recomputeNodes` merges contacts into the previous node list, so
  DB-only rows and fields survive. Pushes no longer turn a known type into 0.
- **B**: the native backend checks the target is in the device contact table
  before `login` / `get_status` / `send_cli`, and maps a firmware NOT_FOUND Err
  during login. Contacts carry `onDevice`. 0x8F and 0x90 are now handled. The
  routes answer `409 CONTACT_NOT_ON_DEVICE`, and the console disables login and
  the CLI for such nodes.
- **D**: `resolveContactByPrefix` returns undefined on ambiguity, and
  `resolveContactsByPrefix` returns every candidate. `nameForRelayHash` names a
  hop only when exactly one repeater or room server owns it. The backend
  `resolvePublicKey` and the frontend helpers (`uniquePrefixMatch`) use the
  same rule.
- **Add to radio**: `POST /contacts/:publicKey/add-to-device` (`nodes:write`).

### What the firmware does on a full table (verified in the MeshCore source)

`CMD_ADD_UPDATE_CONTACT` (companion `MyMesh.cpp:1267-1287`) adds a new contact
through `BaseChatMesh::addContact`, which calls
`allocateContactSlot(type == ADV_TYPE_NONE)` (`BaseChatMesh.cpp:70-96`):

- There is room: the contact takes the next slot.
- The table is full and "overwrite oldest" is on (`autoadd_config & 0x01`): the
  firmware evicts the contact with the oldest `lastmod` whose favourite bit
  (`flags & 0x01`) is clear and whose type is not NONE, then pushes 0x8F.
  **It never evicts a favourite.**
- The table is full and overwrite is off, or every contact is a favourite: it
  answers `ERR_CODE_TABLE_FULL` and nothing changes.
- An add with type NONE (transient) instead evicts the oldest type-NONE contact
  **with no favourite check**. We therefore never add with type 0.

### Policy

When the table is full, or its capacity cannot be read (DeviceInfo byte 2 x 2),
the route answers `409 CONTACT_TABLE_FULL_CONFIRM` and the UI confirms. With
`confirmFull`, the server does four things in order:

1. It re-asserts MeshMonitor favourites onto the device (`refreshContacts` →
   `reconcileDeviceFavorites`).
2. It verifies the favourite bits with a fresh `get_contacts` read.
3. It **blocks** (`409 FAVORITES_NOT_PROTECTED`) if any favourite the radio
   holds lacks the bit.
4. Otherwise it adds the contact. The firmware then evicts the oldest
   non-favourite or refuses (`409 CONTACT_TABLE_FULL`).

A MeshMonitor favourite is added with the favourite bit set.

No RF: every new bridge command (`has_contact`, `add_contact`) is a local
serial read or write and is listed in `SERIAL_ONLY_BRIDGE_COMMANDS`.
