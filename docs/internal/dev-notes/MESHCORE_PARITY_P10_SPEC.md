# MeshCore Parity P10 — Remote structured config (#6256)

Part of the parity epic (`MESHCORE_PARITY_EPIC.md`). Base: `main` incl. P9 (#6255). Paths relative to `src/`. Firmware
`meshcore-dev/MeshCore` @ `81dbae59` (repeater/room-server v1.18.0), tags back to v1.7.0. `CLI` = `src/helpers/CommonCLI.cpp`,
`RP` = `src/helpers/CommonRadioPrefs.cpp`, `RM` = `examples/simple_repeater/MyMesh.cpp`, `SM` = `examples/simple_room_server/MyMesh.cpp`.

## Maintainer decisions (2026-11-09, binding)
1. ONE implementation: a remote `RepeaterCliTransport` + the SAME `RepeaterSettingsForm`; Repeater vs Room Server and local
   vs remote differences come only from schema fields. P9 limits carry over (advert Off or 60–240 min; flood Off or 6–168 h,
   48 h before fw 1.12; af 0–9, flood.max 0–64, rxdelay 0–20, txdelay / direct.txdelay 0–2, with warnings).
2. **Reads are per group** (identity 5 keys, adverts 8, access 2), each with its own Read button showing its cost; no "Read
   all"; nothing reads on mount. **Unknown path**: allowed after an inline warning with the flood cost and a "Discover path" link.
3. **Caps**: one structured operation in flight per (source, target); per-source budget **40 remote settings commands / 10 min**
   (in memory); `meshcoreDeviceLimiter` still per HTTP request; **≥ 1 s gap** between commands; `recordMeshTx()` after each
   command so schedulers back off; do NOT wait the 60 s scheduler floor. Per-command timeout from `resolveCliTimeoutMs`
   (default 15 s); **stop at the first timeout**, remaining keys `NOT_SENT`; **zero automatic retries, no auto re-login**.
4. **Admin password** stays console-only (not in the form). **Radio read-only** remotely. **TX power writable** with the
   warning "lowering TX can cut this node off from you" (no typed confirm).
5. Read AND save need `remote_admin:write` (matches the console mount).
6. Room Server hides repeat, flood.max, rxdelay, txdelay, direct.txdelay.
7. Readback: only the sent keys, plus advertInterval when it was cached at 1–59 (firmware zeroes it on save).
8. Export uses only already-read values (no extra RF); secrets always excluded; name / lat / lon / radio only on opt-in.
   Import fills the draft; user reviews and Saves (writes only changed keys). Same export/import on the local form.
9. One redacted `meshcore_cli_history` row per remote `set` (origin 'user'); none for reads; one audit event per read and per save.
10. Session gate: require an active remembered admin session (`getAdminSession`, DB check, zero RF); never log in on its own.

## Mesh impact
One remote get/set = 1 encrypted DM out (CliData) + 1 DM reply; **no ACK for CliData** (`RM:716-731`; room `send_ack=false`
`SM:466-475`); repeater waits 600 ms before replying (`RM:59`); a repeated sender timestamp gets no reply (`is_retry`,
`RM:735-739`, `SM:467-469`). Sizes: `get <key>` ≈ 38 B, `> value` ≈ 22 B, `set flood.advert.interval 168` ≈ 54 B, `OK` ≈ 22 B.
| Radio | read 1 key, direct | set + OK | 15 keys direct | 15 keys, 3 hops |
|---|---|---|---|---|
| 62.5k/SF7/CR5 | 0.36 s | 0.44 s | 5.3 s | 22.5 s |
| 250k/SF10/CR5 (default) | 0.47 s | 0.58 s | 7.1 s | 30.8 s |
| 250k/SF11/CR5 | 0.86 s | 1.08 s | 13.0 s | 56.8 s |
| 62.5k/SF8/CR8 | 0.83 s | 1.08 s | 12.5 s | 54.0 s |
Known path: × (h+1) per packet. **Unknown path floods both ways**: ≈ (R+1) tx each; R = 50 → **18–45 s mesh airtime per key**,
15 keys ≈ 4.5–11 min. **No batching**: one command per DM (`CLI:183-290`), reply ≤ ~160 B (`RM:733`); no config dump request.
Timers: remote `set advert.interval` / `flood.advert.interval` restart the timer without an advert (`CLI:499-512`) → no burst;
`set name` sends no advert; `set tx` immediate (`RP:141-146`); `set radio` needs reboot (`RP:39-57`); firmware zeroes
advert.interval < 60 on the first save of any setting (`CLI:162-167`). MeshMonitor arms no timer, no auto refresh, nothing
persisted that could re-trigger on restart.

## Findings
1. [P9] write path too chatty for remote: `server/services/meshcoreRepeaterSettingsService.ts` full pre-read when guestPassword
   is patched and full re-read after every write; route also pre-reads (`server/routes/meshcoreConfigRoutes.ts`) — up to ~36 RF
   round trips remotely → S2.
2. [P9] `readAll` iterates every readable key; no `localOnly` / device type / group awareness.
3. [P9] form not schema-driven where P10 needs it: fixed `DRAFT_KEYS`, admin password unconditional, no name/tx/radio, parent
   fetches on mount (`MeshCoreConfigurationView.tsx`).
4. [P9] schema lacks name / tx / radio, device type and group; `adminPassword` `localOnly` though firmware accepts `password`
   remotely (policy → decision 4).
5. Remote CLI `meshcoreManager.ts` `sendCliCommand` (~10559-10660): per-target-prefix serialisation, default 15 s, no retry, no
   `recordMeshTx`. `/admin/cli`: `remote_admin:write` + `meshcoreDeviceLimiter` + `requireMeshcoreTx` + 230 B cap + danger guard
   (`server/routes/meshcoreAdminRoutes.ts:201-327`); `resolveCliTimeoutMs` 1–60 s (`meshcoreRouteShared.ts`); limiter 10/min/IP.
6. Shared mesh-TX floor `lastMeshTxAt` (60 s) honoured only by schedulers.
7. Remote console mounted only with `remote_admin:write`, Companion source, advType 2/3 (`MeshCoreDirectMessagesView.tsx:140`,
   `MeshCoreContactDetailPanel.tsx:1754-1768`); stats + ACL under `loggedIn` (`MeshCoreRemoteConsole.tsx:503-530`).
8. Remembered admin sessions in DB: `getAdminSession` (~9972).
9. Hop count known client-side: `contact.pathLen` (`pathKnown` ≥ 0); local radio (`localNode.radioSf/Bw/Cr`) equals target's.
10. Danger guard `meshcoreRouteShared.ts` (P9 added `set prv.key`); structured routes build commands from the schema — assert anyway.
11. CLI history redactor masks `password`, `set guest.password`, secret gets (`server/utils/meshcoreCliRedact.ts`).

## Firmware: Repeater vs Room Server (both CommonCLI; `SM:989` → `_cli.handleCommand`)
name (≤31 B, `Error, bad chars`) ✓/✓; radio get ✓, set → reboot (read-only remotely, decision 4); freq serial-only; tx ✓/✓ no
range check; lat/lon ✓/✓; advert intervals ✓/✓ (`SM:810-818`); flood.max / delays ✓ repeater, no effect on room; repeat ✓
repeater, room v1.18 `ERR - repeat now deprecated` (`SM:986-987`); af ✓/✓; guest.password ✓/✓; allow.read.only ✓/✓ (`SM:350`);
admin `password` remote-capable but excluded (decision 4); get prv.key serial-only; set prv.key out of scope; `ver` for gates.

## Not feasible / out of scope
Batching; remote get prv.key / set freq / erase / log / stats-* / get acl; reading the admin password; remote key restore,
power-off or reboot from the form (console quick actions stay); room `set repeat on` (v1.18); remote radio changes; background
sync; local Room Server sources.

## Design
**S1 schema** (extend `utils/meshcoreRepeaterSettings.ts`, isomorphic): `group: 'identity'|'adverts'|'access'`,
`deviceTypes: ('repeater'|'room')[]`, `remote: 'rw'|'ro'|'none'` (keep `localOnly` as a derived alias for P9 tests); new keys
`name` (1–31 B, no control chars), `txPower` (`get/set tx`, soft range 1–30 dBm with warning), `radio` (compound, ro remotely);
helpers `settingsFor({mode, deviceType, gates, groups})`, `parseRadioValue('869.618,62.5,8,8')`.
**S2 service** (local unchanged): `readRepeaterSettings(t, gates, {keys?})`; `writeRepeaterSettings(..., {readback:'all'|'sent'})`
— remote `'sent'`: no pre-read (supplied guest password always sent), readback only sent keys + advertInterval when cached 1–59;
remote stops at first TRANSPORT/timeout, rest `NOT_SENT`, no retry.
**S7 remote transport** (new `server/services/meshcoreRemoteRepeaterTransport.ts`):
`createRemoteRepeaterTransport(manager, publicKey, {timeoutMs, signal, minGapMs})` → `{mode:'remote', run}`: throw if aborted
(route aborts on request close / Cancel); assert not `DANGER_COMMAND_PATTERN` and ≤ 230 B; wait `minGapMs` (1000) since last
reply; `manager.sendCliCommand(publicKey, cmd, {timeoutMs})` (reuses per-prefix lock); `manager.recordMeshTx()`; return bare reply.
**Routes** (new `server/routes/meshcoreRemoteSettingsRoutes.ts`, mounted after adminRoutes in `meshcoreRoutes.ts`):
`extendRequestTimeout(120s)`, `meshcoreDeviceLimiter`, `requireAuth()`, `requirePermission('remote_admin','write',
{sourceIdFrom:'params.id'})`, `requireMeshcoreTx()`; `ok()/fail()`; validate body BEFORE connection/session checks. Errors: 409
`SOURCE_NOT_CONNECTED`; 400 non-Companion local; 404 `CONTACT_NOT_FOUND` / 409 `NOT_REMOTE_ADMIN_TARGET` (advType ∉ {2,3});
`CONTACT_NOT_ON_DEVICE`; 409 `ADMIN_SESSION_REQUIRED` (zero RF); 409 `REMOTE_SETTINGS_BUSY`; 429 `REMOTE_SETTINGS_BUDGET`.
- `POST /admin/settings/:publicKey/read` `{groups:[…]}` → keys from `settingsFor` (+ `ver` once per (source,target), cached in
  memory) → `{values, guestPasswordSet, errors, firmware, deviceType, gates, sent, stoppedAt?}`; audit `meshcore_remote_settings_read`.
- `PATCH /admin/settings/:publicKey` partial patch; validate with `remote === 'rw'` + device type → 400 `VALIDATION` with `field`;
  `current = {}`; service `readback:'sent'`; per-key results; audit `meshcore_remote_settings_update` (secrets "[changed]");
  one redacted cli_history row per set.
Classify both in `meshcoreRoutes.scope.test.ts` (remote_admin).
**UI** (same `RepeaterSettingsForm`): props `mode:'local'|'remote'`, `deviceType`, `hiddenKeys?` (local passes name, radio,
txPower, lat, lon — owned by existing sections), `onReadGroup?`, `loadedGroups`, `pathHops: number|null`, cost helpers. Remote:
groups start "Not read" with a Read button + cost line ("Reads 8 values: 16 packets, ≈ 7.5 s on air over 1 hop (your radio)");
flood warning when path unknown; Save disabled for unread groups; per-key results incl. `NOT_SENT`. Mount: `MeshCoreRemoteConsole`
under `loggedIn`, collapsed "Settings" `ConfigSection` between stats and console; actions `readRemoteSettings`,
`saveRemoteSettings` in `hooks/useMeshCore.ts` / `services/api.ts`. `MeshCoreConfigurationView` passes `mode="local"` (unchanged).
CSS module, defined tokens only, `UiIcon`, flat keys `meshcore.repeater.remote_*`.
**Export / import** (new isomorphic `utils/meshcoreRepeaterSettingsExport.ts`): `buildExport(values, meta)` →
`{schema:'meshmonitor.meshcore.repeater-settings', v:1, deviceType, firmware, exportedAt, values}` (already-read values only,
no secrets); `parseImport(json, {deviceType, gates})` validates via `validateRepeaterPatch`, drops unsupported keys with a note,
excludes name/lat/lon/radio unless "include identity"; fills the draft only.

## Work packages — WP1 → WP2 → WP3 (WP3 may start after WP1 against a mocked API); WP4 last
Every WP: typecheck, lint ratchet, `.js` server imports, no raw SQL, `ok()/fail()`, CSS modules with defined tokens only (run
`src/styles/semanticTokens.test.ts`), `UiIcon`, flat en.json, route tests via `createRouteTestApp`.
- **WP1 schema + service + export**: `utils/meshcoreRepeaterSettings.ts`, `server/services/meshcoreRepeaterSettingsService.ts`,
  new `utils/meshcoreRepeaterSettingsExport.ts`, fixture `server/utils/__fixtures__/repeaterCliReplies.ts` (+ remote replies
  without `->`: `> 60`, `> on`, `OK`, `OK - repeat is now OFF`, `> 869.618,62.5,8,8`, `> 22`, `Error, bad chars`,
  `ERR - repeat now deprecated`, `unknown config: foo`, empty). Tests: `settingsFor` matrix (remote/local × repeater/room); room
  hides forwarding keys; adminPassword not offered remotely; `readback:'sent'` re-reads only sent (+ advertInterval if cached
  1–59); remote no pre-read for guest password; stop at first timeout, rest `NOT_SENT`, exactly N transport calls; local results
  equal P9 (existing tests unchanged); export excludes secrets; import drops unsupported + identity keys by default.
- **WP2 remote transport + routes**: new `server/services/meshcoreRemoteRepeaterTransport.ts`, new
  `server/routes/meshcoreRemoteSettingsRoutes.ts`, `server/routes/meshcoreRoutes.ts` (mount), scope test. Transport tests (fake
  manager, recorded replies): abort stops sends; min gap (fake timers); `recordMeshTx` per command; danger / > 230 B throws
  without sending; reuses per-prefix serialisation. Routes: 403 without `remote_admin:write`; 400 validation before connection
  (advert 59, flood 169, floodMax 65, name 32 B, CR/LF, remote adminPassword, room repeat); 409 `SOURCE_NOT_CONNECTED`,
  `NOT_REMOTE_ADMIN_TARGET`, `ADMIN_SESSION_REQUIRED` (no `sendCliCommand`), `REMOTE_SETTINGS_BUSY`; 429 budget (40 / 10 min);
  read sends only requested groups (+ `ver` once); PATCH sends only patch keys + readback; audit / cli history hold no secrets;
  receive-only source 409 `TX_DISABLED`.
- **WP3 UI**: `components/MeshCore/RepeaterSettingsForm.tsx` (+ css), `MeshCoreRemoteConsole.tsx`, `MeshCoreConfigurationView.tsx`
  (`mode="local"`, `hiddenKeys`), `hooks/useMeshCore.ts`, `services/api.ts`, en.json. Tests: no read on mount in remote mode (zero
  API calls); per-group read calls API with exactly that group; cost line uses local radio + hop count; flood warning when
  `pathLen` null; admin password absent remotely, forwarding knobs absent on room; radio read-only; TX power warning; only changed
  keys PATCHed; `NOT_SENT` + readback errors render; export disabled before a read, import fills draft without saving; local P9
  form / config-view tests unchanged.
- **WP4 docs + epic**: `docs/features/meshcore.md` (remote settings, airtime table, flood warning, Room Server differences),
  `docs/internal/dev-notes/MESHCORE_REMOTE_ADMIN.md` (remote transport, no batching, no CliData ACK, `is_retry` silence, budget
  and gap), epic log.

## Browser / API check (no radio)
Throwaway volume, RF lockdown, MeshCore Companion source (disconnected), user A `remote_admin:read` only, admin. API: A → 403 on
read and PATCH; admin → 400 `VALIDATION` on a bad PATCH while disconnected, then 409 `SOURCE_NOT_CONNECTED` on a valid body;
receive-only → 409 `TX_DISABLED`. Browser: remote console Settings shows disabled Read buttons with cost text, no console errors
(light + dark); local Repeater (P9) and Companion config unchanged. Hardware (maintainer): real round trips, per-key timing,
readback, room rejecting repeat, guest password change, advert.interval zeroing drift.
