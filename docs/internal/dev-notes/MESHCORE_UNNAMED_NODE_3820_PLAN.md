# MeshCore "Unnamed/Unknown" discovered repeater — #3820 (reopen of #3756)

**Status:** Root-cause analysis + implementation plan. No product code changed.
**Author:** meshtastic-expert agent, 2026-06-27.
**Firmware evidence:** `ripplebiz/MeshCore` master (cloned 2026-06-27 to /tmp/MeshCore).
**Library evidence:** `@liamcottle/meshcore.js` (vendored in `node_modules`).

---

## TL;DR

The name **is** delivered over the air and the companion device **does** store it —
MeshMonitor just never re-reads it. The active-discovery flow pre-creates the
device contact with an empty name, which converts the repeater's later
name-bearing advert from a "new contact" push (carries the name) into an
"existing contact" push (pubkey only). MeshMonitor only re-reads the device
contact list (`refreshContacts` → `get_contacts`) for *brand-new* contacts, so
the now-stored name is never pulled in. Admin login fixes it only because
opening the repeater panel / refreshing triggers `POST /contacts/refresh`, which
reads the device record that already has the name.

**Recommended fix (Option A):** in the `contact_advertised` handler, fire
`schedulePathRefresh()` for an *already-known* contact that still lacks a
name/type — not only for brand-new contacts. This is local (USB/TCP to the
companion), costs **zero airtime**, is debounced, and is guaranteed to succeed
(see "Why the refresh always wins" below).

---

## The repro (from the issue)

1. Remove the repeater from the node list.
2. Settings → Device → Refresh; node confirmed gone.
3. Settings → Discover Nodes → "Discover Repeaters" → "1 contacts returned (1 new)".
4. Node re-added but name = "Unknown".
5. Repeater sends a **zero-hop advert** → name still "Unknown".
6. Admin login to the repeater → name immediately correct.

---

## Firmware-verified root cause

### Step 1 — Discovery pre-creates a *nameless* device contact

The active-discovery response (`NODE_DISCOVER_RESP`, CTL type `0x90`, delivered
inside push `0x8E`) carries only `[type][SNR][tag][pubkey]` — **no name, no
position**. Confirmed in `meshcoreNativeBackend.ts:625-698` and memory
`reference_meshcore_node_discovery_protocol`.

To make the node message-able, the native backend immediately registers it on
the device with an **empty name**:

- `src/server/meshcoreNativeBackend.ts:688`
  ```ts
  c.addOrUpdateContact(publicKeyBytes, nodeType, 0, 0xff, new Uint8Array(64), '', 0, 0, 0)
  //                                                              name='' ^^   lastAdvert=0 ^
  ```

This issues firmware `CMD_ADD_UPDATE_CONTACT` (9). The firmware stores the frame
verbatim, including `name=""` and `last_advert_timestamp=0`:

- `examples/companion_radio/MyMesh.cpp:1267-1287` (handler) →
  `updateContactFromFrame` `examples/companion_radio/MyMesh.cpp:189-212`
  (line 199 copies the 32-byte name, line 201 copies `last_advert_timestamp`
  straight from the frame).

So after discovery the device has a contact whose `name=""` and
`last_advert_timestamp=0`.

The MeshMonitor `node_discovered` handler mirrors this into the contact map and
the `meshcore_nodes` table with no name (`src/server/meshcoreManager.ts:1271-1300`),
which surfaces as **"Unknown"** via `getAllNodes()` (`name: n.name || 'Unknown'`,
`src/server/meshcoreManager.ts:4255`). It also schedules a refresh
(`if (isNew) this.schedulePathRefresh(publicKey)`, line 1299) — but this refresh
**races ahead of the repeater's advert** and reads the still-empty device record
(`refreshContacts` reads `c.adv_name`/`c.name`, `src/server/meshcoreManager.ts:2136-2149`).

### Step 2 — The zero-hop advert DOES carry the name and DOES update the device

A configured repeater's self-advert always includes its name:

- `examples/simple_repeater/MyMesh.cpp:382-387` `createSelfAdvert()` →
  `_cli.buildAdvertData(ADV_TYPE_REPEATER, …)`
- `src/helpers/AdvertDataHelpers.cpp:19-25` sets `ADV_NAME_MASK (0x80)` and
  appends the name whenever `_name && *_name != 0`.

When the companion receives it, `BaseChatMesh::onAdvertRecv`
(`src/helpers/BaseChatMesh.cpp:113-187`):

- **line 115:** drops *any* advert without a name (`!parser.hasName()` → return).
  So every advert that is processed at all carries a name. (A repeater with no
  configured name would be silently dropped here and never reach the app — but
  then admin login wouldn't show a name either, so that's not this reporter.)
- **line 121-130:** finds the existing contact (created in Step 1).
- **line 124 (replay guard):** `if (timestamp <= from->last_advert_timestamp) return;`
  Because discovery stored `last_advert_timestamp = 0`, the advert's timestamp
  (> 0) **passes** — the advert is *not* dropped as a replay.
- **line 177:** `StrHelper::strncpy(from->name, parser.getName(), …)` — **the
  device contact now has the correct name.**
- **line 186:** `onDiscoveredContact(*from, is_new=false, …)`.

### Step 3 — The "existing contact" push carries only the pubkey

`onDiscoveredContact` chooses the push code by **new vs. existing**, not by
auto/manual mode:

- `examples/companion_radio/MyMesh.cpp:350-358`
  ```cpp
  if (is_new) writeContactRespFrame(PUSH_CODE_NEW_ADVERT, contact); // 0x8A — full record incl. name
  else { out_frame[0] = PUSH_CODE_ADVERT;                           // 0x80 — pubkey ONLY
         memcpy(&out_frame[1], contact.id.pub_key, PUB_KEY_SIZE); … }
  ```

Because the discovery-pre-created contact is **already existing**, the advert
yields `PUSH_CODE_ADVERT (0x80)` with only the pubkey — even though the device
just stored the name internally.

meshcore.js maps these:
- `0x80` → `PushCodes.Advert` → `onAdvertPush` emits `{publicKey}` only
  (`connection.js:98,399-400,429-432`).
- `0x8A` → `PushCodes.NewAdvert` → `onNewAdvertPush` emits the full record
  **including `advName`** (`connection.js:108,419-420,517-530`).

Native backend wiring (`src/server/meshcoreNativeBackend.ts`):
- `PushCodes.NewAdvert` → `contact_added` with full name
  (`advertToContactData`, lines 567-568, 783-792).
- `PushCodes.Advert` → `contact_advertised` with **only** `public_key`
  (lines 572-576).

### Step 4 — MeshMonitor never re-reads the device record for a *known* contact

`contact_advertised` / `contact_added` handler
(`src/server/meshcoreManager.ts:1136-1179`):

```ts
const wasKnown = this.contacts.has(publicKey);          // TRUE for the discovered repeater
…
advName: data.adv_name || existing.advName,             // both undefined/'' → stays empty
…
if (!wasKnown) {                                         // FALSE → block skipped
  void this.notifyNewNodeDiscovered(updated);
  if (!updated.advName || updated.advType === undefined) {
    this.schedulePathRefresh(publicKey);                // ← the device-record re-read lives HERE,
  }                                                      //   gated on !wasKnown, so it never runs
}
```

For the discovered repeater, `wasKnown === true`, `data.adv_name` is `undefined`
(the `0x80` push has no name), and the re-read (`schedulePathRefresh`) is nested
inside the `!wasKnown` branch. **Result: MeshMonitor's copy stays "Unknown"
forever, even though the device knows the name.**

### Step 5 — Why admin login "fixes" it

Admin login (`loginToNode`, `src/server/meshcoreManager.ts:3209-3232`) does **not**
itself touch the name. What surfaces the name is the **manual refresh** that the
repeater admin/detail flow triggers:

- `POST /api/meshcore/contacts/refresh` → `refreshContacts()`
  (`src/server/routes/meshcoreRoutes.ts:421-423`).

`refreshContacts` calls `get_contacts` and reads `c.adv_name`/`c.name`
(`src/server/meshcoreManager.ts:2114,2136-2149`) — which now returns the name
that the firmware stored back in Step 2. (Equivalently, the official MeshCore app
logging in / any reconnect at line 770 would do the same.) The fix is incidental
to "admin" — it's the `get_contacts` re-read that wins.

---

## Why the #3756 fix is real but insufficient here

#3756 (merged via #3785, `35bf1600`/`c3a66569`) changed
`advName: data.adv_name ?? existing.advName` → `data.adv_name || existing.advName`
(`src/server/meshcoreManager.ts:1148-1151`) so an empty `adv_name` can't
**overwrite a good name**. That protects a name MeshMonitor already has.

This reopen is the **fresh-discovery** case:
- There is **no existing name to preserve** (the node was removed first; the
  discovery contact starts nameless).
- The `0x80` advert push carries **no name at all** (`data.adv_name` is
  `undefined`), so `||` simply keeps the empty value.

#3756 prevents *losing* a name; it does nothing to *acquire* a name MeshMonitor
hasn't pulled yet. Acquiring it requires re-reading the device contact list,
which is exactly the trigger that's currently gated behind `!wasKnown`.

---

## Why the refresh always wins (the key feasibility fact)

`BaseChatMesh::onAdvertRecv` **drops every nameless advert at line 115** before
it can emit any push. Therefore **every** `contact_advertised` (`0x80`) event
corresponds to an advert that (a) had a name and (b) was just written into the
device's contact record at line 177. So whenever MeshMonitor sees
`contact_advertised` for a contact it still has no name for, a `get_contacts`
re-read is **guaranteed** to return the name. There is no "refresh too early"
race in the advert path (unlike the post-discovery refresh, which fires before
any advert has arrived).

---

## Implementation options

### Option A — Re-read the device record on advert for any still-nameless contact (RECOMMENDED)

Move/duplicate the `schedulePathRefresh` trigger out of the `!wasKnown` branch so
it also fires for already-known contacts missing a name or type.

**Touch point:** `src/server/meshcoreManager.ts:1167-1177`
```ts
if (!wasKnown) {
  void this.notifyNewNodeDiscovered(updated);
}
// The firmware updates its stored contact name from every valid advert
// (BaseChatMesh.cpp:177) but a PUSH_CODE_ADVERT (0x80) for an *existing*
// contact carries only the pubkey. Pull get_contacts whenever we're still
// missing the name/type so the device-stored name lands in MeshMonitor.
// (Nameless adverts are dropped firmware-side at BaseChatMesh.cpp:115, so a
// contact_advertised event always means the device just stored a real name —
// the refresh is guaranteed to find it.)
if (!updated.advName || updated.advType === undefined) {
  this.schedulePathRefresh(publicKey);
}
```

- **Firmware feasibility:** Confirmed — device already holds the name; refresh
  reads it. Guaranteed success per "Why the refresh always wins".
- **Airtime / zero-hop:** **Zero OTA.** `refreshContacts` is a local
  `get_contacts` over USB/TCP to the attached companion. Debounced via
  `schedulePathRefresh` (`PATH_REFRESH_DEBOUNCE_MS`), so a burst of adverts
  collapses to one read. `refreshContacts` has an empty-result guard so it never
  wipes the list (`src/server/meshcoreManager.ts:2115-2122`).
- **Risk:** Low. Worst case: a contact whose name the firmware genuinely never
  stores (shouldn't happen, since nameless adverts are dropped before producing
  a push) would schedule a harmless local refresh per advert. Adverts are
  infrequent and coalesced. Optionally cap with a per-pubkey "stop after N
  attempts" guard, but likely unnecessary.
- **Tests:** Add a `meshcoreManager` unit test: seed a known nameless contact,
  emit `contact_advertised` with `{public_key}` only, assert `schedulePathRefresh`
  / `refreshContacts` is invoked. Mirror the existing #3756 test that asserts an
  empty `adv_name` doesn't clobber a known name (keep both green).

### Option B — Don't pre-create a nameless device contact during discovery

Defer `addOrUpdateContact` until a name is known, or add with a sentinel and
reconcile later.

- **Rejected:** The node must be on the device contact list to be message-able
  and to learn a path; deferring breaks discovery's purpose. And immediately
  after discovery the device record is nameless regardless — the name only
  exists after the repeater's next advert, which is exactly when Option A acts.
  Pre-creation is also what makes the contact "existing," but removing it would
  regress message-ability for a marginal benefit Option A already delivers.

### Option C — Proactively pull the name via admin/CLI or a direct request

After discovery, log in (guest/admin) and read the repeater's name from its
status/version reply (the repeater returns `node_name` in its status frame —
`examples/simple_repeater/MyMesh.cpp:179,376`), or issue a single-contact fetch.

- **Rejected as primary:** Costs OTA (login + status round-trip, flood when no
  path), needs credentials for password-protected repeaters, and is strictly
  worse than Option A which is free and reliable. Keep as a *manual* "fetch name"
  affordance only if desired.

### Option D — Single-contact fetch instead of full refresh (future optimization)

Firmware supports `CMD_GET_CONTACT_BY_KEY` (`examples/companion_radio/MyMesh.cpp:1310-1316`,
returns `RESP_CODE_CONTACT` with the full record incl. name), but meshcore.js
does **not** expose it yet (noted in `src/server/meshcoreManager.ts:1223-1224`).
A raw-frame implementation would re-read just the one contact instead of the
whole list. **Defer** — Option A's debounced full refresh is simpler and the
list is small; revisit if refresh churn ever matters.

### Optional polish (independent of A) — clearer placeholder

While the name is briefly unknown, show the pubkey prefix (e.g. `Repeater
a1b2c3…`) instead of "Unknown" in `getAllNodes()` / the node list, so a
discovered repeater reads as "name pending" rather than broken. Low risk,
purely cosmetic; can ship with or after Option A.

---

## Recommendation

Ship **Option A**. It is a ~6-line change at a single site
(`src/server/meshcoreManager.ts:1167-1177`), costs zero airtime, is debounced and
guaranteed-correct given the firmware's drop-nameless-adverts behavior, and
directly closes the fresh-discovery gap that #3756 left open. Optionally add the
clearer-placeholder polish. Keep Option D on the backlog as an efficiency
refinement.

---

## Assumptions to confirm on a live node

1. **Firmware parity:** Analysis is against `ripplebiz/MeshCore` master. Confirm
   the reporter's repeater + companion run firmware with the same
   `onAdvertRecv` replay/name logic and the new-vs-existing push split (true for
   recent releases; verify if the device is old).
2. **`last_advert_timestamp = 0` survives discovery add:** We pass `lastAdvert=0`
   and the firmware copies it verbatim (`updateContactFromFrame:201`). Confirm on
   hardware that the post-discovery `get_contacts` shows `last_advert ≈ 0` for the
   new contact (so the next advert isn't replay-dropped). If a future
   native-backend change passes a non-zero `lastAdvert`, the replay guard could
   start dropping the name-bearing advert — watch for that.
3. **Admin-login trigger:** We attribute the "admin login fixes it" observation
   to `POST /contacts/refresh` (or a reconnect) firing `get_contacts`. Confirm by
   watching whether merely opening the repeater panel / hitting refresh — without
   logging in — also fixes the name (it should).
4. **Live capture (optional):** With the dev container's MeshCore node, run
   "Discover Repeaters" against the nearby zero-hop repeater, then watch
   `meshcore_packet_log` / logs for the subsequent `0x80` advert push and confirm
   a `get_contacts` after it returns the name. (Login is rate-limited; read the
   SQLite `meshcore_nodes` row directly rather than re-authing.)

---

## Source index

**MeshMonitor**
- `src/server/meshcoreNativeBackend.ts:625-698` — discovery `0x8E` parse + nameless `addOrUpdateContact` (688)
- `src/server/meshcoreNativeBackend.ts:567-576,783-792` — NewAdvert→contact_added (with name) vs Advert→contact_advertised (pubkey only)
- `src/server/meshcoreManager.ts:1136-1179` — advert handler; #3756 `||` (1151); gated `schedulePathRefresh` (1174) — **fix site**
- `src/server/meshcoreManager.ts:1271-1300` — `node_discovered` handler; post-discovery refresh race (1299)
- `src/server/meshcoreManager.ts:2108-2166` — `refreshContacts` (`get_contacts`, empty-guard)
- `src/server/meshcoreManager.ts:3209-3232` — `loginToNode` (does not set name)
- `src/server/meshcoreManager.ts:4255` — `name: n.name || 'Unknown'`
- `src/server/routes/meshcoreRoutes.ts:421-423` — `POST /contacts/refresh`

**meshcore.js (`node_modules/@liamcottle/meshcore.js/src/`)**
- `advert.js:12-15,99-103` — `ADV_NAME_MASK 0x80`, name optional in app_data
- `connection.js:98,108` — `PushCodes.Advert=0x80`, `NewAdvert=0x8A`
- `connection.js:429-432` — `onAdvertPush` emits `{publicKey}` only
- `connection.js:517-530` — `onNewAdvertPush` emits full record incl. `advName`
- `connection.js:551-564` — `onContactResponse` (`get_contacts` row incl. `advName`)
- `connection.js:104-112,1349-1372` — `CMD_ADD_UPDATE_CONTACT` (name CString)

**MeshCore firmware (`ripplebiz/MeshCore` master)**
- `src/helpers/BaseChatMesh.cpp:113-187` — `onAdvertRecv`: drop-if-nameless (115), replay guard (124), store name (177), push (186)
- `examples/companion_radio/MyMesh.cpp:350-358` — `onDiscoveredContact`: NEW→`0x8A` (full), EXISTING→`0x80` (pubkey only)
- `examples/companion_radio/MyMesh.cpp:189-212,1267-1287` — `CMD_ADD_UPDATE_CONTACT` / `updateContactFromFrame` (name@199, last_advert_timestamp@201)
- `examples/companion_radio/MyMesh.cpp:1310-1316` — `CMD_GET_CONTACT_BY_KEY` (Option D)
- `examples/simple_repeater/MyMesh.cpp:382-387` — `createSelfAdvert` (always includes name)
- `examples/simple_repeater/MyMesh.cpp:179,376` — repeater status/version reply carries `node_name` (Option C)
- `src/helpers/AdvertDataHelpers.cpp:19-25` — `ADV_NAME_MASK` set when name non-empty
