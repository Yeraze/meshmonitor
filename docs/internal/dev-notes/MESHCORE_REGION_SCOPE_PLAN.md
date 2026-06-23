# MeshCore Region / Scope Support — Implementation Plan

Tracking issue: **#3667** ([FEAT] MeshCore: Region/Scope Support)

> Status: **Phase 1 merged** (PR #3669, migration 100). **Phase 2 in progress** —
> scoping all originated flood traffic (adverts, logins, telemetry/CLI requests)
> via the shared `sendWithDefaultScope` helper on the per-source send mutex.
> Phase 3 (region discovery) not started.

## 1. Background — how scopes/regions work in MeshCore

A **region** == a **scope**: a named geographic forwarding tag (e.g. `muenchen`,
`sample-city`). It is *not* encryption and *not* a channel — it controls which
repeaters relay a flood packet.

- **Wire encoding.** A scope's transport key = `SHA-256("#" + regionName)`, first
  **16 bytes**. Those 16 bytes ride in the packet header as two 16-bit "transport
  codes". The route-type nibble selects scoped vs. legacy:
  - `ROUTE_TYPE_FLOOD (0x01)` / `ROUTE_TYPE_DIRECT (0x02)` → no transport codes →
    **null / wildcard `*` region** (legacy, unscoped).
  - `ROUTE_TYPE_TRANSPORT_FLOOD (0x00)` / `ROUTE_TYPE_TRANSPORT_DIRECT (0x03)` →
    carries transport codes → **scoped**.
  (See `node_modules/@liamcottle/meshcore.js/src/packet.js:14-17,56-66`.)
- **Forwarding.** A repeater relays a scoped flood packet only if its transport
  code matches a region configured *and* flood-allowed on that repeater. Every
  repeater implicitly allows the wildcard `*`, so unscoped traffic propagates
  everywhere by default — **unless** an admin runs `region denyf *`.
- **The Germany problem (the issue).** Many DE repeaters run `region denyf *`,
  rejecting un-scoped flood traffic. MeshMonitor sends everything unscoped today,
  so those repeaters drop it. The companion app avoids this by scoping its
  outbound packets.

### Default scope vs. per-channel scope

| Layer | Scopes | Firmware | App |
|---|---|---|---|
| Per-channel scope | messages on that channel | v1.12.0+ | v1.38.0+ |
| Default scope | everything else the node originates (adverts, DMs, logins, telemetry/stats requests when path unknown, ACKs) | v1.15.0+ | v1.43.0+ |

Resolution rule: **channel scope overrides default scope**; if neither is set the
packet is null/`*` (unscoped). Recommended user setting: a *large* region (e.g.
your city) that contains you and your DM peers, so outbound + returning ACKs are
both in scope.

## 2. The load-bearing constraint

**The companion protocol exposes only ONE device-global flood scope** — command
`CMD_SET_FLOOD_SCOPE = 54` (`meshcore.js` `Constants.CommandCodes.SetFloodScope`).
Frame: `[54][0x00 reserved — must be 0][16-byte transport key]`; empty key clears
it (`connection.js:264-270`). The JS wrapper is `connection.setFloodScope(key)` /
`connection.clearFloodScope()` (`connection.js:1940`, `2052`).

There is **no per-channel scope command**. `SetChannel (32)` carries only
index + name + secret — `get_channels`/`set_channel` round-trips have nowhere to
put a scope. Therefore:

- **Per-channel scope is MeshMonitor-owned state**, not synced from the device.
  We store it in our DB and *apply* it by calling `setFloodScope` immediately
  before each send.
- Because the device flood scope is **global + stateful**, the
  `set-scope → send` pair must be **serialized per source** (a send mutex) so two
  concurrent sends with different scopes can't interleave and ship under the wrong
  scope.

### Transport-key derivation caveat

`TransportKeyUtil.getHashtagRegionKey(name)` returns the **full 32-byte** SHA-256
hash, but `setFloodScope` wants **16 bytes**. We must slice `[0..16]`. We own a
fork (`Yeraze/meshcore.js#feat/meshmonitor-helpers`) so we can either slice in
the backend or add a correct 16-byte helper to the fork. Prefer slicing in the
backend to avoid a fork bump on the critical path.

Region name normalization: strip a leading `#` from user input for display, but
hash with the `#` prepended (matches `getHashtagRegionKey`). Names: alphanumeric +
hyphen.

## 3. Current state (what exists today)

- **No scope concept anywhere.** Channel/DM send path:
  - `meshcoreManager.sendMessage(text, toPublicKey?, channelIdx?)`
    — `src/server/meshcoreManager.ts:1937`
  - → `sendBridgeCommand('send_message', { text, to, channel_idx })` — `:1950`
  - → native backend `case 'send_message'` — `src/server/meshcoreNativeBackend.ts:1004`
    — DM: `c.sendTextMessage(fullKey, text)` `:1014`; channel:
    `c.sendChannelTextMessage(channelIdx, text)` `:1033`.
- **Channels** stored in the shared `channels` table (`src/db/schema/channels.ts`),
  MeshCore rows use `psk` for the 16-byte secret (base64); Meshtastic-only columns
  nulled. Synced device→DB by `syncChannelsFromDevice()` —
  `meshcoreManager.ts:1405`; never DB→device for scope (device has no scope field).
- **meshcore.js fork already ships `setFloodScope`/`clearFloodScope`** — confirmed
  in `node_modules`. No new wrapper method strictly required.

## 4. Data model changes

### 4.1 Migration (recipe in CLAUDE.md → "Migration recipe")

New migration `097_meshcore_channel_scope` (next number after 096):

- Add nullable `scope TEXT` column to the `channels` table (all 3 backends;
  idempotent). `NULL` = inherit default / unscoped; non-null = region name
  (stored without `#`).
- Register in `src/db/migrations.ts`; bump count + last-name in
  `src/db/migrations.test.ts` (96 → 97).

Default scope is a **setting**, not a column (see §6), so no separate table.

### 4.2 Schema

`src/db/schema/channels.ts` — add `scope` to all three table defs
(`channelsSqlite` ~L23, `channelsPostgres` ~L40, `channelsMysql` ~L55) and let the
inferred types (`:70-75`) pick it up:
- SQLite: `scope: text('scope')`
- Postgres: `scope: pgText('scope')`
- MySQL: `scope: myVarchar('scope', { length: 64 })`

### 4.3 Repository

`src/db/repositories/channels.ts` — `upsertChannel` must accept + persist `scope`.
Because scope is **not** reported by the device, `syncChannelsFromDevice()` must
**preserve** the existing `scope` on upsert (read-modify-write or a partial update
that omits `scope`) — otherwise every device re-sync would wipe the user's scope.
This is the single most important correctness point in the data layer.

## 5. Backend send path

### 5.1 Scope resolution helper (manager)

Add `resolveScopeForSend({ channelIdx?, toPublicKey? }): string | null` to
`MeshCoreManager`:
- channel send → channel row's `scope` ?? default-scope setting ?? `null`.
- DM / advert / request → default-scope setting ?? `null`.

### 5.2 Apply scope before send (serialized)

In `sendMessage` (`meshcoreManager.ts:1937`), wrap the send in a per-source async
mutex:
1. `const region = this.resolveScopeForSend(...)`.
2. If `region !== this.activeFloodScope`: send a new bridge command
   `set_flood_scope` with `{ region }` (or `{ region: null }` to clear), then
   cache `this.activeFloodScope = region`.
3. Perform the existing `send_message`.

Track `activeFloodScope` on the manager and reset it to `undefined` (unknown) on
connect, so the first send always re-asserts. Keep the optimization (skip
`set_flood_scope` when unchanged) to avoid an extra round-trip per message.

> Decision: **set-and-leave**, not set-then-restore. We leave the device on the
> last-used scope and only change it when the next send needs a different one.
> Simpler and fewer round-trips than restoring the default after every send. The
> mutex guarantees correctness regardless.

### 5.3 New bridge command

`src/server/meshcoreNativeBackend.ts` — add `case 'set_flood_scope'`:
```ts
case 'set_flood_scope': {
  const region = params.region as string | null | undefined;
  if (!region) {
    await c.clearFloodScope();
    return { ok: true };
  }
  const name = region.startsWith('#') ? region : `#${region}`;
  const full = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name)),
  );
  await c.setFloodScope(full.slice(0, 16)); // 16-byte transport key
  return { ok: true };
}
```
(Derivation mirrors `TransportKeyUtil`, sliced to 16. Reuse existing hashing
helpers in the backend if present.)

### 5.4 Other originated traffic (phase 2)

DMs already flow through `sendMessage` so they inherit default scope for free.
Adverts (`sendAdvert` `:1994`), telemetry/stats requests, and auto-ack/announce
paths also originate flood packets and should assert the default scope under the
same mutex. Land messages first (the issue's core), then extend.

## 6. Settings — default scope

- Add `meshcoreDefaultScope` to `VALID_SETTINGS_KEYS`
  (`src/server/constants/settings.ts` ~L204, MeshCore block) **and** to the
  per-source settings list (~L341) — scope is per-source (per node).
- Wire through `SettingsContext` / server load if surfaced in the generic
  settings UI, or store/read directly via `settings.getSettingForSource` in the
  manager (the auto-ack/announce features already use `getSettingForSource`, e.g.
  `meshcoreRoutes.ts:2564`). Reading directly in the manager avoids the
  `SettingsTab.tsx` dependency-array dance.

## 7. Routes / API

`src/server/routes/meshcoreRoutes.ts`:
- Extend the channel config endpoints to read/write `scope` (the channel-create/
  edit path that calls `manager.setChannel`). Add `scope` to the request body and
  persist it to the DB row (device write stays name+secret only).
- `GET /api/meshcore/default-scope` + `PUT` (or fold into existing settings
  endpoints) for the per-source default scope.
- (Phase 2) `GET /api/meshcore/regions/discover` — see §9.

## 8. Frontend UI

- **Per-channel scope:** add a "Region / Scope" text field to
  `src/components/MeshCore/MeshCoreChannelsConfigSection.tsx` (and reflect in
  `MeshCoreChannelsView.tsx`). Empty = inherit default. Update the companion test
  files (`*.test.tsx`).
- **Default scope:** add a field to `MeshCoreSettingsView.tsx` (or the MeshCore
  configuration view) bound to `meshcoreDefaultScope`. Include the firmware
  guidance inline ("use a large region containing you and your contacts").
- Validation: alphanumeric + hyphen; strip leading `#`.

## 9. Region discovery (Phase 3 — flagged uncertain)

The issue asks to "discover regions from nearby repeaters." In the official app
this auto-detects regions from repeater adverts/config (firmware v1.12.0+). **The
exact companion-protocol mechanism is not yet confirmed** from the sources traced
(blogs + companion_protocol.md + meshcore.js). Before building this:
- Confirm whether region info arrives via the `Advert` push (`0x80`/`0x8A`), a
  binary request (`GetAccessList`/neighbours?), or a repeater CLI query
  (`region` / `region list`) over the existing remote-admin path
  (`MESHCORE_REMOTE_ADMIN.md`).
- MeshMonitor already has repeater CLI plumbing, so a `region` CLI query against a
  known repeater is the most tractable first cut even if app-style passive
  discovery is harder.

Treat discovery as a follow-up; manual scope entry (phases 1–2) already makes the
integration usable in `denyf *` meshes, which is the issue's blocking need.

## 10. Testing

- **Unit:** transport-key derivation = `sha256("#region")[:16]` (golden vectors);
  scope resolution (channel ?? default ?? null); name normalization.
- **`set_flood_scope` bridge command:** clear vs. set; 16-byte length.
- **Send serialization:** two queued sends with different scopes assert
  `set_flood_scope` in order before each `send_message` (mock the connection).
- **Sync preserves scope:** `syncChannelsFromDevice()` must not clobber a channel's
  `scope` (regression test — this is the easy bug).
- **`*.perSource.test.ts`:** default scope + channel scope isolated per source.
- **Migration test:** count 96 → 97, idempotency across all three backends.
- Full Vitest suite green before PR (CLAUDE.md rule).

## 11. Phasing

1. **Phase 1 — channel + default scope on messages (the issue's core).**
   Migration, schema, repo (scope-preserving sync), `set_flood_scope` bridge
   command, serialized send-path scope application, settings key, channel UI +
   default-scope UI. Makes MeshMonitor usable in `denyf *` meshes.
2. **Phase 2 — scope all originated traffic** (adverts, telemetry/stats requests,
   auto-ack/announce) under the same mutex.
3. **Phase 3 — region discovery** from nearby repeaters (mechanism TBD, §9).

## 12. Open questions

- Confirm firmware/app version floor we target (default scope is v1.15.0+; older
  companions will `ERR_CODE_UNSUPPORTED_CMD` on `CMD_SET_FLOOD_SCOPE`). Handle that
  gracefully — detect once, warn in UI, fall back to unscoped.
- Does any auto-ack/announce path bypass `sendMessage`? If so it needs the mutex
  too (audit before Phase 2).
- Discovery transport (§9) — needs a protocol confirmation pass.
</content>
