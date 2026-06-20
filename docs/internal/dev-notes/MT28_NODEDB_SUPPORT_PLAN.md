# Meshtastic 2.8 NodeDB Warm-Tier — MeshMonitor Support Plan

**Tracking issue:** Yeraze/meshmonitor#3548
**Firmware PR:** meshtastic/firmware#10705 (labeled `2.8`, `develop`-only, no release yet)
**Date:** 2026-06-20
**Status:** IMPLEMENTED on branch `feat/client-notification-surfacing`. Item 3 (code), Item 2
(defensive SNR test), and Items 1 & 4 (docs/UX) all done. Remaining: live-build `from == 0`
verification (needs 2.8 hardware).

---

## TL;DR — the reframe

Issue #3548 reads like four code changes. After investigating firmware PR #10705 against
how MeshMonitor actually ingests data, **only one of the four needs code.** The PR is almost
entirely an *on-disk* (`deviceonly.proto`) and *internal-RAM* restructuring. The over-the-air
wire format (`mesh.proto`: `NodeInfo`, `User`, `Data`, `MeshPacket`) is **unchanged**.

MeshMonitor consumes `FromRadio` over TCP via the device's PhoneAPI. It never reads the device's
raw `nodes.proto` flash file, and it keeps its own persistent per-source node DB. So the warm-tier
restructuring is mostly invisible to us.

| # | Issue item | Wire-visible to MeshMonitor? | Verdict | Effort |
|---|------------|------------------------------|---------|--------|
| 1 | nRF52 hot-store cap 150 → 120 | **No** | Docs/FAQ only | XS |
| 2 | `snr_q4` in `NodeInfoLite` | **No** (on-disk `deviceonly.proto` only; OTA `NodeInfo.snr` stays `float`) | No-op + defensive test | XS |
| 3 | `set_favorite()` can refuse at cap | **Indirectly yes** — `FromRadio.ClientNotification` (field 16) | **Real feature work** | M |
| 4 | Blocked/ignored persist through eviction | **No** | Docs/UX; already aligned | XS |

The headline deliverable is **#3: parse and surface `FromRadio.ClientNotification`** — which
MeshMonitor currently decodes-then-drops. That work is also independently useful (it surfaces
*all* device warnings, not just favorite/ignore refusals, on *all* firmware versions).

---

## Evidence basis

- Firmware PR #10705 authoritative review (meshtastic-expert): the 3-tier store (hot full
  `NodeInfoLite` / satellite maps / 40-byte `WarmNodeStore` `{num,last_heard,public_key}`),
  `MAX_NUM_NODES` nRF52 150→120, `snr_q4 = dB×4 sint32 #19` in `deviceonly.proto`, and the
  `setProtectedFlag` cap (`numProtectedNodes() < MAX_NUM_NODES - 2`).
- `snr_q4` lives **only** in `deviceonly.proto` on the protobufs *develop* branch. The OTA
  `mesh.proto NodeInfo` keeps `float snr = 4`, no `snr_q4`. The protobufs submodule pointer was
  **not** bumped by the PR (it hand-edited the generated `.pb.h`); commit `36251667` is an
  unrelated "Publish KMP snapshots" merge and does **not** contain `snr_q4`.
- MeshMonitor uses **dynamic `protobuf.js`** decoding against `protobufs/meshtastic/*.proto`
  (no generated code). SNR ingest: `protobufService.ts:517` (`rx_snr` from `MeshPacket`) and
  `meshtasticManager.ts:7677` (`snr` from OTA `NodeInfo`). Stored as `real`/`double` floats.
- MeshMonitor keeps a **persistent per-source node DB** and de-dupes counts by `nodeNum`
  (`nodes.ts:getDistinctNodeCount/getDistinctActiveNodeCount`). It does not prune its node table
  to match the device's hot store.
- Favorite/ignore admin sends are **fire-and-forget, optimistic-UI** (`sendAdminCommand`,
  no ACK wait): `meshtasticManager.ts:12198` (favorite), `:12274` (ignored), `:13055`
  (`sendAdminCommand`). Routes: `server.ts:1446` (favorite), `:1700` (ignored).
- Ignored nodes are already a **persistent per-source MeshMonitor concept** (`ignored_nodes`
  table, repo `ignoredNodes.ts`) and are **re-applied** when a node reappears (issue #2601) —
  this is exactly the "block survives eviction" posture item #4 asks for.
- `FromRadio.clientNotification` (`mesh.proto:2290`, field 16) is currently **only logged**
  (`meshtasticProtobufService.ts:719`) and falls through the dispatch chain to the generic
  `type: 'fromRadio'` catch-all (`meshtasticProtobufService.ts` ~line 796 →
  `meshtasticManager.ts:3935`, which just logs "Generic FromRadio message"). **No handler.**
- Frontend toast surface already exists: `useToast`/`ToastProvider` (`ToastContainer.tsx`).
- Realtime backend→frontend push exists: `dataEventEmitter` (`meshtasticManager.ts:22`).

---

## Item 1 — nRF52 hot-store cap 150 → 120

**Reality.** `MAX_NUM_NODES` bounds the device's *internal* DB only; it is not on the wire.
MeshMonitor accumulates nodes in its own per-source table and does not delete a node when the
device evicts it to the warm tier. So MeshMonitor's "total nodes seen" is **more stable** than
the device's — if anything, post-2.8 a user's MeshMonitor count will *exceed* what the device
itself reports, because we remember nodes the device has compacted.

The only mechanical effect: during a full NodeDB resync the device dumps fewer full
`NodeInfo` records (others are warm/compact and not sent as NodeInfo). MeshMonitor's existing
rows are untouched; no count drop on our side.

**Action.** Documentation only.
- [ ] FAQ / docs note when we publish "2.8 support": "On nRF52 hardware running 2.8+, your
      Meshtastic node keeps full detail for ~120 nodes (down from 150); older nodes are kept
      as compact records on the device. MeshMonitor retains its own history, so your node
      counts are unaffected — they may even be higher than what the device's app shows."
- [ ] (Optional) Tooltip near the dashboard node-count card linking to the FAQ.

No code change.

---

## Item 2 — `snr_q4` in `NodeInfoLite`

**Reality.** `snr_q4` is in `deviceonly.proto` (`NodeInfoLite`, on-disk), `sint32`, `dB×4`
(despite the "Q4" name it is ×4, not ×16). The PhoneAPI converts `NodeInfoLite`→`NodeInfo`
before sending over the wire, and OTA `NodeInfo` keeps `float snr = 4`. MeshMonitor reads only
OTA `NodeInfo.snr` and `MeshPacket.rx_snr`, both floats. We never decode `NodeInfoLite` and never
read the device flash.

**Action.** No-op for ingest. Defensive only:
- [ ] When the protobufs submodule eventually bumps to include `snr_q4`, confirm the
      `protobuf.js` loader still loads `deviceonly.proto` cleanly (added fields are backward
      compatible; this should be a non-event).
- [ ] (Optional, cheap) Add a regression test asserting `NodeInfo.snr` continues to decode as a
      float from an OTA `FromRadio.nodeInfo` fixture, so a future protobuf bump can't silently
      regress SNR ingest. Guards `meshtasticManager.ts:7677`.
- [ ] Explicitly **do not** implement any `snr_q4 → snr` conversion in the TCP path. Record this
      decision so it isn't "helpfully" re-added later. (See expert memory
      `reference_nodedb_warmstore_pr10705.md`: the ×4-not-×16 trap.)

---

## Item 3 — `set_favorite()` / `set_ignored()` can refuse at the protected-node cap  ← the real work

### Firmware behavior (2.8)

`NodeDB::setProtectedFlag` now returns `false` when the protected set (favorite + ignored +
verified) would exceed `MAX_NUM_NODES - 2`. On refusal, **and only when the admin request is
local (`mp.from == 0`)**, the firmware emits a `meshtastic_ClientNotification`:

```
level    = WARNING
message  = "Can't <favorite|ignore|verify> 0x%08x: protected-node limit (%d) reached"
```

delivered to the client as `FromRadio.clientNotification` (field 16). There is **no** admin
ACK/NAK that distinguishes success from refusal — the routing ACK is unchanged. The
`ClientNotification` is the only signal.

### Current MeshMonitor gaps

1. `clientNotification` is decoded but **dropped** (no dispatch case, no handler).
2. Favorite/ignore HTTP routes are fire-and-forget + optimistic UI. On a cap refusal, MeshMonitor's
   local DB ends up showing `isFavorite/isIgnored = true` while the device set nothing → silent
   divergence (exactly the failure mode the issue calls out).

### Design

Push-based, decoupled from the HTTP request (the POST returns long before any notification
arrives). Generic enough to surface every device warning, with special-case reconciliation for
the favorite/ignore-cap message.

**Backend**
- [ ] **Dispatch:** add a `clientNotification` branch in `meshtasticProtobufService.ts`
      `parseIncomingData` (before the catch-all) → `{ type: 'clientNotification', data:
      fromRadio.clientNotification }`.
- [ ] **Handler:** add `case 'clientNotification'` to the `switch (parsed.type)` in
      `meshtasticManager.ts:3934`. It should:
  - Log at info/warn by `level`.
  - Push to the frontend via `dataEventEmitter` (new `emitClientNotification({ sourceId, level,
    message })`), so the UI can toast it. This alone fixes the "silent failure" complaint.
  - **Reconcile optimistic state:** if `message` matches
    `/Can't (favorite|ignore) 0x([0-9a-f]{8}): protected-node limit/i`, parse the verb + node
    hex, and revert the corresponding local flag for `(nodeNum, sourceId)`:
    - favorite → `databaseService.nodes.setNodeFavorite(nodeNum, false, sourceId)`
    - ignore → `setNodeIgnoredAsync(nodeNum, false, sourceId)` (also drop the `ignored_nodes`
      row so the #2601 re-apply logic doesn't immediately re-set it).
    - Re-broadcast the node update so the UI star/ignore icon snaps back to reality.

**Frontend**
- [ ] Subscribe to the new `clientNotification` event in the realtime client and call
      `showToast(message, 'warning')` (reuse `useToast`). Scope to the active source.
- [ ] Because reconciliation already reverts the DB + re-broadcasts the node, the optimistic
      star/ignore toggle corrects itself via the normal node-update path — no special-case UI
      revert needed beyond the toast.

**Scope / limitations (document these):**
- The warning fires **only for the local connected node** (`mp.from == 0`). Favoriting on a
  *remote-admin* node gets no notification and no ACK — silent on 2.8 just as today. Note this in
  the favorite/ignore UI help text; do not promise refusal detection for remote admin.
- `ClientNotification` (field 16) exists in **current** firmware too; the 2.8 change is only that
  favorite/ignore now *emits* one at the cap. So this handler is safe and useful on all firmware
  versions and needs no version gate.
- Verify our **local** admin-inject path resolves to `from == 0` so the device actually emits the
  warning (favorite/ignore to the connected node uses `sendAdminCommand` → local node; expected
  `from == 0`, but confirm during implementation against a live 2.8 dev build).

### Toast policy — REQUIRED, not optional (driven by 2.7.x behavior)

`ClientNotification` (field 16) is **not new in 2.8** — 2.7.x already emits several, which we
currently drop. The moment we surface them, every existing 2.7.x user starts seeing them. A few
fire repeatedly in normal operation, so a naive "toast everything" is a regression-by-noise. The
`ClientNotification` proto has **no subsystem field** — policy must key on `level` + message
substring, not `level` alone (`PhoneAPI::sendNotification` even hardcodes `level=WARNING`).

What 2.7.x emits (from the connected/local node about its *own* operation):

- **Recurring / noisy — must throttle or suppress:**
  - `"Duty cycle limit exceeded. You can send again in N mins"` (WARNING) — can fire *per send
    attempt* on duty-cycled regions (EU868/AU). Hits any automated-send user.
  - `"Sending position/telemetry and sleeping for Ns interval in a moment"` (INFO) — every
    broadcast cycle, but **only** on power-saving TRACKER/SENSOR roles (the AirQuality path emits
    it twice). Many MeshMonitor users run mains-powered always-on nodes and never see these.
  - `"TraceRoute can only be sent once every 30 seconds"` (WARNING) — app-spammable.
- **One-shot / important — surface:** duplicate-public-key compromise warning (WARNING, once per
  boot — security-relevant, the best reason to ship this), region-too-narrow fallback (ERROR),
  MQTT-config-save failures (WARNING/ERROR), admin/config-validation refusals (all strictly gated
  on a user/admin action).
- **Structured key-verification flow** (`payload_variant` 11–13): part of a handshake MeshMonitor
  doesn't implement — **skip the plain toast** (ignore notifications carrying a `payload_variant`).

Therefore implement, from day one:
- [ ] **Dedupe + rate-limit** by `message` text per source (e.g. suppress an identical message
      within a short window) so duty-cycle / power-save spam collapses to at most one toast.
- [ ] **Suppress the known-recurring INFO patterns** (`/sleeping for .* interval in a moment/`)
      and **throttle** the duty-cycle WARNING; do not toast `payload_variant`-bearing
      notifications. Everything else toasts.
- [ ] Scope/label each toast by **source** (multi-source users may get notifications from several
      connected nodes).
- [ ] Changelog note: "MeshMonitor now surfaces device notifications (duplicate-key warnings,
      config errors, etc.). These were always sent by the node; MeshMonitor previously ignored
      them." So the new toasts don't read as a bug.

**Tests**
- [ ] Unit: `parseIncomingData` returns `type: 'clientNotification'` for a `FromRadio` carrying
      field 16.
- [ ] Unit: duty-cycle and "sleeping for N interval" messages dedupe/throttle to ≤1 toast within
      the window; `payload_variant`-bearing notifications produce no toast.
- [ ] Unit: handler parses the verb + node hex from the cap message and reverts the right flag
      for the right `(nodeNum, sourceId)`; non-matching warnings only toast (no DB write).
- [ ] Unit: a generic (non-cap) `ClientNotification` is surfaced as a toast and causes no node
      mutation.
- [ ] `*.perSource.test.ts`: a cap refusal for source A never touches source B's node row.

---

## Item 4 — blocked/ignored nodes persist through eviction

**Reality.** No wire change. The PR only changes how the *device* persists the block flag
(protects it from eviction, and `set_ignored_node` now `getOrCreateMeshNode` so a block-by-bare-ID
sticks). MeshMonitor already treats ignore as a **persistent per-source concept** in its own
`ignored_nodes` table and **re-applies** it when a node reappears (issue #2601). Our posture
already matches what the firmware now guarantees on-device; if anything the firmware caught up to us.

**Action.** Docs/UX only.
- [ ] In `IgnoredNodesSection` help text and/or the node ignore tooltip, clarify that a blocked
      node is *blocked, not deleted* — it may stop appearing in the device's full node list while
      still being retained (compact record on-device, persistent row in MeshMonitor). Removes the
      "did my block get forgotten?" confusion.
- [ ] No schema or sync change.

One thing to *watch* (not act on now): if remote-admin `set_ignored_node` of a never-heard node
becomes a common flow under 2.8, MeshMonitor has no row for a node it has never seen, so the UI
can't show it in the ignored list. Out of scope for #3548; note as a possible follow-up if users
report it.

---

## Recommended sequencing

1. **Item 3 backend** (dispatch + handler + reconciliation) — the only behavioral change.
2. **Item 3 frontend** (toast subscription) + tests.
3. **Items 1 & 4 docs** — bundle into the "2.8 support" doc/FAQ when #3 lands.
4. **Item 2** — add the defensive SNR decode test; otherwise close as no-op with the
   ×4-not-×16 decision recorded.

A single PR can carry all of it: one focused feature (ClientNotification surfacing +
favorite/ignore-cap reconciliation), a defensive test, and the docs. Gate nothing on firmware
2.8 — every change is backward compatible.

## Explicitly NOT doing

- No `snr_q4` decode in the TCP path (on-disk only; OTA SNR stays float).
- No protobufs submodule bump chasing `snr_q4` (not landed upstream; irrelevant to OTA).
- No change to node counting / pruning for the 150→120 cap (we keep our own history).
- No new ignored/favorite *schema* — the existing per-source tables already cover persistence.
- No reliance on an admin ACK/NAK for refusal detection — firmware provides none; the
  `ClientNotification` is the channel.
