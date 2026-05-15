# MeshCore Channels — Plan

**Status:** Draft. No implementation yet.
**Goal:** Detect, display, and CRUD-manage the channels on a MeshCore-source node, the way we already do for Meshtastic sources.

---

## TL;DR

MeshCore channels are dramatically simpler than Meshtastic channels: just `{ channelIdx, name, secret }`. The meshcore.js library already has `getChannel` / `setChannel` / `deleteChannel` wire commands wired up. The existing `channels` DB table is Meshtastic-biased but its core columns (`id`, `name`, `psk`, `sourceId`) align well enough that we can reuse it, leaving the Meshtastic-only fields (`role`, `uplinkEnabled`, `downlinkEnabled`, `positionPrecision`) null for MeshCore rows.

The work splits naturally into three PR-sized phases:

1. **Backend sync** — read channels from the device on connect, mirror to DB.
2. **Display** — replace the hardcoded "Public" channel in `MeshCoreChannelsView` with the real per-source list.
3. **Configuration UI** — add MeshCore-aware create/edit/delete affordances to `ChannelsConfigSection`.

Estimated effort: **~4–6 person-days total** (1 day phase 1, 1 day phase 2, 2–3 days phase 3).

---

## 1. What a MeshCore channel actually is

From `@liamcottle/meshcore.js` v1.13 (`src/connection/connection.js:605-622`):

```
ChannelInfo (response to GetChannel)
  channelIdx : uint8
  name       : C-string, 32 bytes fixed (≤31 chars + NUL)
  secret     : 16 bytes, AES-128 key
```

That is the entire model. No role, no uplink/downlink, no position precision, no hash, no salt, no frequency override.

Behavioural notes:
- **Identity is the index.** `SendChannelTxtMsg`, `ChannelMsgRecv`, `SetChannel`, `DeleteChannel` all key off `channelIdx`. Hashes are an internal-firmware concern (`packet.js:24-25`) and don't surface to the host.
- **Channel-count is device-dependent.** There is no `maxChannels` field in `AppStart` or `DeviceQuery`. `getChannels()` enumerates by calling `GetChannel(0)`, `GetChannel(1)`, … until the firmware returns an error. The 8-slot cap that `channels.ts::cleanupInvalidChannels` enforces today is a Meshtastic assumption.
- **No push events.** There is no `ChannelAdded` / `ChannelUpdated`. Channel state is pull-only — we re-read on connect and after every write we issue.
- **No well-known default PSK** like Meshtastic's `AQ==`. Whatever the device firmware ships with at idx 0 is what we'll discover on first sync.
- **The host link is unencrypted** — secrets travel in cleartext between MeshMonitor and the locally-attached MeshCore Companion. Mesh-side encryption is firmware-internal.

meshcore.js methods we'll call (all on `Connection`):
- `getChannel(channelIdx)` — single read, returns `{channelIdx, name, secret}`
- `getChannels()` — enumerates until error, returns `Channel[]`
- `setChannel(channelIdx, name, secret)` — write (creates if absent, updates if present)
- `deleteChannel(channelIdx)` — issues `SetChannel` with an empty-name marker (see library impl)
- `sendChannelTextMessage(channelIdx, text)` — already used by `meshcoreManager.sendMessage`

---

## 2. What MeshMonitor has today

| Surface | File | State |
|---|---|---|
| MeshCore source manager | `src/server/meshcoreManager.ts` | **No channel CRUD methods.** Consumes `channel_message` push events (line 477) with a `channel_idx` field; synthesizes a fake `channel-${idx}` pubkey to scope incoming messages. |
| meshcore.js wrapper | `src/server/meshcoreNativeBackend.ts` | Wires `ResponseCodes.ChannelMsgRecv` → `channel_message` event (line 197-204). No channel-CRUD method exposure yet. |
| Channels DB schema | `src/db/schema/channels.ts` | Has `id`, `name`, `psk`, `role`, `uplinkEnabled`, `downlinkEnabled`, `positionPrecision`, `sourceId`. `UNIQUE(sourceId, id)` per migration 023. |
| Channels repository | `src/db/repositories/channels.ts` | Generic CRUD methods. `cleanupInvalidChannels()` (line 228) hard-rejects `id < 0` or `id > 7`. |
| Configuration UI | `src/components/configuration/ChannelsConfigSection.tsx` | Renders all Meshtastic-specific fields unconditionally. No "add" button — it edits fixed slots only. No source-type awareness. |
| MeshCore display | `src/components/MeshCore/MeshCoreChannelsView.tsx` | Hardcoded single `PUBLIC_CHANNEL` (line 23). Filters messages by the synthesized pubkey. No DB read. |
| Routes | `src/server/routes/v1/channels.ts` | Generic REST CRUD. Backend write path is Meshtastic-only (sends admin messages); no MeshCore branch. |

Concrete gaps:
1. `meshcoreManager` doesn't expose `getChannels` / `setChannel` / `deleteChannel`.
2. Nothing syncs MeshCore channels into the DB.
3. `MeshCoreChannelsView` ignores the DB entirely.
4. `ChannelsConfigSection` renders Meshtastic-only fields for any source.
5. The channels route's write path can't talk to MeshCore.
6. The 8-slot cap in `cleanupInvalidChannels()` is wrong for MeshCore.

---

## 3. Architectural decisions

### D1. Reuse the existing `channels` table

**Decision:** reuse, don't create a new `meshcoreChannels` table.

The shared fields (`id`, `name`, `psk`, `sourceId`) line up perfectly. The Meshtastic-only fields (`role`, `uplinkEnabled`, `downlinkEnabled`, `positionPrecision`) just stay `NULL` for MeshCore rows. The repository's `cleanupInvalidChannels()` needs softening (see D4) but no schema migration is required.

Storage format for `secret`: the column is already typed for base64-encoded PSK. A MeshCore 16-byte secret base64-encodes to a 24-char string — no schema change. We coerce hex ↔ base64 at the API boundary.

### D2. Channel CRUD method placement

Add methods to `MeshCoreManager` (mirroring its existing style of thin TS wrappers around the native backend):

```ts
class MeshCoreManager {
  async listChannels(): Promise<MeshCoreChannel[]> { … }
  async setChannel(idx: number, name: string, secret: Uint8Array): Promise<void> { … }
  async deleteChannel(idx: number): Promise<void> { … }
  private async syncChannelsFromDevice(): Promise<void> { … }  // calls listChannels + upserts to DB
}
```

`syncChannelsFromDevice()` runs:
- Once on connect, right after `refreshLocalNode()` / `refreshContacts()` in the existing connect sequence.
- After every successful `setChannel` / `deleteChannel` (re-read to confirm; the device is authoritative).
- On demand via a "Refresh from device" button in the configuration UI.

### D3. UI strategy — fork or unify?

**Decision:** unify, with source-type-conditional rendering inside `ChannelsConfigSection`.

The existing component already renders a list-of-channels-with-edit-controls; the same shape works for MeshCore. We add a `sourceType` prop (or read it from `useSource()`), and conditionally:
- Hide `role`, `uplinkEnabled`, `downlinkEnabled`, `positionPrecision` for MeshCore.
- Show an "Add channel" button for MeshCore (Meshtastic has fixed slots and doesn't need it).
- Show a "regenerate secret" button for MeshCore (uses `crypto.getRandomValues(new Uint8Array(16))`).
- Display the secret in hex (matches the MeshCore CLI convention) with a "copy" button; round-trip through base64 only at the DB layer.

If the field-set divergence grows in future, we can fork to `<MeshCoreChannelsConfigSection>`. For now a single component keeps the configuration page coherent.

### D4. Soften `cleanupInvalidChannels`

Today it deletes any row with `id < 0` or `id > 7`. For MeshCore that's wrong — firmware builds vary. Two options:

- **D4a (minimal):** widen the cap to a generous fixed value (e.g. `id > 31`) and assume no MeshCore firmware exceeds it. Simple, but a guess.
- **D4b (proper):** scope the cleanup by source type — keep the 8-slot cap for Meshtastic sources, drop it entirely for MeshCore sources (or rely on the device's own rejection when we try to read past the end).

**Recommendation: D4b.** Requires reading `sources.sourceType` in the repo method, but it's the honest fix.

### D5. PSK / secret display format

- **Storage:** base64, same column as Meshtastic. Keeps the schema uniform.
- **API:** return as hex when source is MeshCore (matches MeshCore CLI / docs conventions), base64 when Meshtastic.
- **UI:** show hex for MeshCore with copy + regenerate buttons. Mask by default behind a "show" toggle, matching how Meshtastic PSK is shown.

### D6. No "default channel" auto-creation

Meshtastic has a well-known default PSK (`AQ==`) and channel 0 is conventionally "LongFast" with that key. MeshCore has no analog. We do NOT seed a default channel on a fresh MeshCore source — whatever the device firmware ships with at idx 0 is what we discover on first sync. If the device has zero channels configured, the UI shows an empty list with a prominent "Add channel" affordance.

---

## 4. Phased delivery

### Phase 1 — Backend sync (1 PR, ~1 day)

**Scope:**
- `meshcoreNativeBackend.ts`: expose `getChannels()`, `setChannel(idx, name, secret)`, `deleteChannel(idx)` pass-throughs to the meshcore.js `Connection` instance.
- `meshcoreManager.ts`: add `listChannels()`, `setChannel()`, `deleteChannel()`, `syncChannelsFromDevice()`.
- Hook `syncChannelsFromDevice()` into the manager's connect sequence (after contacts refresh).
- Repository: implement D4b — drop the 8-slot cap for MeshCore-source rows by reading `sources.sourceType` (or pass `sourceType` as an explicit arg to `cleanupInvalidChannels`).
- Tests:
  - Unit test for `MeshCoreManager.syncChannelsFromDevice` mocks the native backend's `getChannels()` and asserts the channels table gets the expected rows with the right `sourceId` and base64-encoded secrets.
  - Repository test asserting `cleanupInvalidChannels` no longer drops MeshCore rows with idx > 7.

**Out of scope:** UI changes, REST route changes.

**Acceptance:** start MeshMonitor with a MeshCore source attached, wait for connect, query `SELECT * FROM channels WHERE sourceId = '<meshcore-source>'` — rows reflect the device's channel list.

### Phase 2 — Display the real channel list (1 PR, ~1 day)

**Scope:**
- `MeshCoreChannelsView.tsx`: replace the hardcoded `PUBLIC_CHANNEL` constant with a query of the channels table scoped to the current source. Render each channel as a selectable tab/section. Filter messages by `channelIdx` (the manager already tags channel messages with `channel_idx`; ensure that flows into the messages table — check existing storage, may already be there).
- If channel-index tagging isn't already on messages: small extension to the manager's `channel_message` event handler to store `channelIdx` in `messages.channelIdx` (Meshtastic-side field) or a new column. **Check first**, don't assume.
- Tests: render component with 2-3 channel rows in DB, assert all tabs render and messages filter correctly.

**Out of scope:** writes.

**Acceptance:** in the MeshCore page, switch between the device's actual channels and see messages segregated by channel.

### Phase 3 — Configuration UI (1 PR, ~2-3 days)

**Scope:**
- `ChannelsConfigSection.tsx`: add `sourceType`-aware conditional rendering. Hide Meshtastic-only fields for MeshCore. Add "Add channel" and "Regenerate secret" buttons. Show secret as hex with copy/show toggle.
- `src/server/routes/v1/channels.ts`: route the write path by source type. Meshtastic: existing admin-message flow. MeshCore: call `meshcoreManager.setChannel(idx, name, secret)` then re-sync.
- DELETE route: similarly route by type.
- Validation: name ≤ 31 bytes, secret = exactly 16 bytes (32 hex chars).
- Tests:
  - Frontend: render with `sourceType='meshcore'`, assert hidden fields are absent, assert "Add channel" button is present.
  - Backend: integration test for `PUT /api/v1/channels/:id` against a MeshCore source — mocks `meshcoreManager.setChannel`, asserts it's called with right args, asserts DB is re-synced afterwards.
  - Permissions: assert `requirePermission('channels', 'write')` still gates the route per-source.

**Out of scope:** mass-import/export, bulk operations, channel-link sharing.

**Acceptance:** in the Configuration tab for a MeshCore source, the user can:
- See the existing channels.
- Click "Add channel", enter a name, click "Generate secret", save, and see the new channel appear in the list and on the MeshCore page.
- Edit an existing channel's name or regenerate its secret and save.
- Delete a channel.
All operations write to the device first, then mirror to DB.

---

## 5. Open questions for confirmation before phase 1

1. **D4a vs D4b for `cleanupInvalidChannels`.** I recommend D4b (source-type-aware). Acceptable to commit to that, or do you want the minimal D4a fix and we revisit later?
2. **Secret display in UI.** Hidden-by-default with a "show" toggle, hex format, copy + regenerate buttons — same as Meshtastic PSK except hex instead of base64. OK?
3. **Channel-message DB column.** Is the channel index already stored on `messages` rows for MeshCore-source messages, or do we need to extend that in phase 2? (Will verify before phase 2 starts.)
4. **First-sync behaviour for fresh sources.** No default channel auto-creation — let the device drive. If the device has zero channels, UI shows empty + "Add channel" affordance. Agree?
5. **Permission model.** Reuse the existing `channels` resource per-source permission, no new permission key. Agree?

---

## 6. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| `getChannels()` enumerate-until-error can be slow on devices with many channels | Low | Has a hard upper bound (firmware will error eventually). One-shot on connect, not on every poll. |
| User edits a channel from the MeshCore CLI / other client out-of-band; we don't see the change | Medium | "Refresh from device" button in UI; periodic re-sync (every N minutes?) as a follow-up if it matters. Phase 1 covers the connect-time sync. |
| Editing a channel name silently re-broadcasts the secret (since `setChannel` takes both) | Low | Documented; UI confirms "Save will resend the secret to the device" on edit. |
| Schema mismatch — Meshtastic-only columns getting non-null values for MeshCore rows | Low | Repository layer enforces nulls for MeshCore-source rows; covered by tests. |
| Channel index collision when adding a channel mid-edit (two users pressing "Add" at once) | Very low | Single-user product context; on conflict, the second write surfaces the device's rejection. |
| Backward compat — existing MeshCore-source installs have no channel rows | None | Phase 1 sync creates them on next connect. |

---

## 7. File pointers

| Concern | Path | Notes |
|---|---|---|
| MeshCore manager | `src/server/meshcoreManager.ts` | Where listChannels/setChannel/deleteChannel/syncChannelsFromDevice will live |
| Native backend wrapper | `src/server/meshcoreNativeBackend.ts:22-34` | Expose meshcore.js channel methods |
| meshcore.js channel impl | `~/.openclaw/workspace/meshcore.js/src/connection/connection.js:2077-2190` | Reference for what we're calling |
| Channels schema | `src/db/schema/channels.ts` | No migration needed |
| Channels repo | `src/db/repositories/channels.ts:228` | `cleanupInvalidChannels` needs softening |
| Channels route | `src/server/routes/v1/channels.ts` | Add source-type branch in write path |
| Configuration UI | `src/components/configuration/ChannelsConfigSection.tsx` | Add sourceType-conditional rendering, Add/Regenerate buttons |
| MeshCore display | `src/components/MeshCore/MeshCoreChannelsView.tsx:23` | Replace hardcoded `PUBLIC_CHANNEL` |
| Source-type lookup | `src/db/schema/sources.ts` | For `cleanupInvalidChannels` source-type check |
