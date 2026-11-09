# MeshCore Parity P9 — Repeater settings & danger zone (#6255)

Part of the parity epic (`MESHCORE_PARITY_EPIC.md`). Base: `main` with P1–P8a. Paths relative to `src/`. Firmware refs:
`meshcore-dev/MeshCore` @ `81dbae59` (main = repeater-v1.18.0), per tag repeater-v1.7.0…v1.18.0. `CLI` =
`src/helpers/CommonCLI.cpp`, `RP` = `src/helpers/CommonRadioPrefs.cpp`, `RM` = `examples/simple_repeater/MyMesh.cpp`,
`Rmain` = `examples/simple_repeater/main.cpp`.

## Maintainer decisions (binding)
1. (Epic) `advert.interval` 60–240 min and `flood.advert.interval` 6–168 h, enforced on the server AND in the input, with a
   warning next to each input.
2. (2026-11-08) **Off (0)** allowed for each interval as an explicit Off toggle; flood-off warns "nodes beyond direct range
   won't learn this repeater until they hear it directly".
3. **Power-off and private-key restore**: `requireAdmin` + typed device name, for BOTH protocols (Companion key restore
   tightens from `configuration:write`). Restore = one confirm that runs `set prv.key` then reboots; the identity tracker
   pins the expected key (`expectChange(sourceId, {expectedKey, reason:'key_restore'})`) so no own-key alert. Export stays
   `configuration:write`.
4. **Forwarding knobs**: firmware ranges, no tighter clamp — af 0–9 (warn < 1: >50% duty, EU sub-band rules), flood.max 0–64
   (warn ≤ 2), rxdelay 0–20, txdelay / direct.txdelay 0–2; repeat on/off warns that nodes relying on it lose coverage.
5. Key backup = Companion pattern (hidden until Reveal, then copy) via the shared component; no file download.
6. Guest password never sent to the browser (set/unset only); admin password write-only 1–15 B; empty guest = guest login off.
7. Add `\bset\s+prv\.key\b` to the console + remote-admin danger guard (both copies + tests); `password` not added.
8. Local Room Server sources out of scope; Companion also gets power-off (protocol ≥ 14 via `run_cli`).
9. Fix the existing debug-log leak of repeater secrets in this PR.

## Mesh impact
Advert ≈ 111–143 B (~125 B typical): header/path 2 + pubkey 32 + ts 4 + sig 64 + app data (flags 1, lat/lon 8, name ≤ 32).
Airtime @125 B (preamble 32 sym at SF≤8, 16 above; `RadioLibWrappers.h:56`): 62.5k/SF7/CR5 ≈ 470 ms; 250k/SF10/CR5
(build default `RM:7-16`) ≈ 650 ms; 250k/SF11 ≈ 1.17 s; 62.5k/SF8/CR8 ≈ 1.23 s. UI computes from the repeater's radio (S3).
| Setting | Airtime |
|---|---|
| advert.interval (zero-hop, `RM:1303-1305`) | 1 tx/interval, not forwarded. 60 min → 24/day ≈ 11–30 s/day; 240 → 6/day ≈ 3–7 s/day. Firmware default on new installs 2 min (`RM:904`) and the firmware sets it to 0 on the first save of any setting (`CLI:160-168`). |
| flood.advert.interval | Repeated by every repeater hearing it up to `flood.max.advert` hops (default 8 on fw 1.16+, `RM:908`). ≈ (R+1) tx; R=50: 6 h → ~204 tx/day ≈ 1.6–4 min/day; 168 h → ~7/day ≈ 3–9 s/day. Default 47 h (`RM:905`). |
| repeat off | this repeater's forwarding airtime → 0; dependents lose coverage. |
| flood.max (0–64, default 64) | hop cap on forwarded floods. |
| af (default 1.0) | TX duty cap 1/(1+af) (`Dispatcher.cpp:26`). No packets of its own. |
| rxdelay / txdelay | timing only; rxdelay reduces duplicate forwards; same packet count. |
| reboot | offline seconds; one zero-hop advert 16 s after boot (`Rmain:117-119`). |
| poweroff | off the mesh until physically power-cycled. |
| key restore | after reboot peers see a new node; saved remote-admin creds for the old key stop working. |

**All P9 commands are local serial CLI — zero RF.** One structured save = one HTTP request = one `meshcoreDeviceLimiter` hit.
**Timers:** firmware `set advert.interval` / `set flood.advert.interval` restart that timer from now (`CLI:509`→`RM:1046-1052`,
`CLI:499`→`RM:1054-1060`) without an immediate advert → repeated saves only delay adverts (no burst). Rule: `set` only
changed keys. No MeshMonitor timer is touched; reboot reconnect via `linkRecoveryReconnect` skips the on-start announce.

## Firmware / CLI support (verified)
Serial reply = `"  -> " + reply` (`Rmain:162`); values start `"> "`; buffers 160 B (`Rmain:25,152`).
| Setting | Verb | Firmware range / reply | Gate | Evidence |
|---|---|---|---|---|
| lat / lon | `get/set lat`, `get/set lon` | no range check; `OK` | all | `CLI:542-549,720-723` |
| advert.interval | `get/set advert.interval <min>` | minutes; 0 off else 60–240; stored as min/2 (odd floored) | all | `CLI:503-512,707-708,160` |
| flood.advert.interval | `get/set flood.advert.interval <h>` | hours; 0 off else 3–168 | max 48 h before 1.12.0 | `CLI:493-502` |
| flood.max | `get/set flood.max` | 0–64 (`Error, max 64`) | all | `CLI:568-576,728-729` |
| repeat | `get repeat` / `set repeat on|off` | `OK - repeat is now ON/OFF`; get `> on/off` | all | `CLI:538-541,718-719` |
| af | `get/set af` | 0–9 (`ERROR: af must be 0-9`) | firmware validates from 1.18.0 | `RP:65-79` |
| rxdelay | `get/set rxdelay` | 0–20 | validated from 1.16.0 | `RP:148-161` |
| txdelay / direct.txdelay | `get/set txdelay`, `get/set direct.txdelay` | 0–2 | validated from 1.16.0 | `RP:201-229` |
| admin password | `password <new>` (NOT `set`) | ≤ 15 B; **reply echoes it** (`password now: …`); no get | all | `CLI:267-272` |
| guest password | `get/set guest.password` | ≤ 15 B; empty = guest off; **get returns plaintext** | all | `CLI:513-516,709-710` |
| allow.read.only | `get/set allow.read.only on|off` | `OK` | all | `CLI:489-492,703-704` |
| clock | `clock` / `time <epoch>` | forward only `(ERR: clock cannot go backwards)` | all | `CLI:224-238` |
| reboot | `reboot` | no reply | all | `CLI:196-197` |
| poweroff | `poweroff` / `shutdown` | no reply | ≥ 1.15.0 | `CLI:194-195` |
| get prv.key | `get prv.key` | 128 hex, serial-only | ≥ 1.8.0 | `CLI:711-715` |
| set prv.key | `set prv.key <128hex>` | flash, applies after reboot; 1.12+ `OK, reboot to apply! New pubkey: <64hex>` / `Error, bad key`; earlier `OK` / `Error, invalid key` | persisted ≥ 1.9.0 | `CLI:517-529` |
| tz.offset | — | Companion only (`companion_radio/MyMesh.cpp:2194-2203`) → replaced by Sync clock | n/a | |
`ver` already parsed into `localNode.ver` (`meshcoreManager.ts:11480`); unparseable → treat as latest, rely on reply + readback.

## Findings
1. Repeater `setCoords` returns false (`server/meshcoreManager.ts:10988-10991`); Location section still renders → silent fail
   (`components/MeshCore/MeshCoreConfigurationView.tsx:352-428`). Advert-location checkbox has no repeater CLI (non-GPS).
2. `rebootDevice` (`:9426-9430`), `exportPrivateKey` (`:9547-9551`), `importPrivateKey` (`:9574-9578`), `syncDeviceTime`
   (`:9080-9084`) refuse non-Companion; view hides danger zone (`COMPANION_ONLY_DEVICES`, `MeshCoreConfigurationView.tsx:34,248`).
3. Repeater `setRadio` / `setTxPower` ignore the reply (`:10908-10915`, `:10948-10955`) — `Error…` counts as success.
4. Reply terminators only `-> >`, `OK`, `Error`, `Unknown command` (`:5641`); `??:`, `unknown config:`, `ERROR:`, `(ERR:`,
   lowercase `ok`/`error` wait out the 5 s timeout.
5. **Secrets in debug logs**: `handleSerialData` logs every RX line (`:4826`), `runRepeaterCommand` every response line
   (`:5635`) — typed-command echo (`set prv.key <hex>`, `password x`), `get prv.key`, `password now: x` all unredacted. Only TX
   is redacted (`:5658`). Affects the console today.
6. **Danger guard misses `set prv.key`** (`DANGER_COMMAND_PATTERN` in `server/routes/meshcoreRoutes.ts` + `CliConsoleBody.tsx`).
7. Companion `importPrivateKey` never calls `meshcoreOwnIdentityTracker.expectChange` (only factory reset does, `:11205`);
   `expectChange` has no expected key, in-memory, 30-min TTL (`services/meshcoreOwnIdentityTracker.ts:33,130`); audit name is
   reset-specific (`meshcore_factory_reset_identity_changed`, `:8645`).
8. Permissions: local `/config/*` incl. reboot + key export/import `configuration:write` (`meshcoreConfigRoutes.ts:300-405`);
   `/cli` `configuration:write`; remote `/admin/cli` `remote_admin:write`; factory reset `requireAdmin`.
9. Companion key export: on screen + copy (`MeshCoreConfigurationView.tsx` ~878-980).
10. No LoRa airtime utility in `src/`.

## Not feasible / out of scope
`tz.offset` on Repeater (→ Sync clock); reading the admin password; Repeater factory reset (`erase`); advert-location
policy on non-GPS builds; moving the clock backwards (console `clkreboot`); local Room Server sources; remote structured
settings (P10, reusing S1/S2/S4); storing repeater prv key in `meshcore_source_pki_keys`.

## Shared pieces — local ↔ remote via one transport adapter (feasible; P10 adds the remote transport)
| ID | Piece | Used by |
|---|---|---|
| S1 | `utils/meshcoreRepeaterSettings.ts` (isomorphic): the ONE schema — key, get/set verb, type (on/off, int, float, string, secret), MeshMonitor ∩ firmware range, unit, version gate, `localOnly`, airtime class, Off-allowed; `parseCliReply(reply)` (strip optional `->` then `> `; classify ok/error/unknown/value); `formatSet`. Inputs take min/max from it; server validates from it. | server, form, P10 |
| S2 | `server/services/meshcoreRepeaterSettingsService.ts`: `interface RepeaterCliTransport { run(cmd, {secret}): Promise<string>; mode: 'local'|'remote' }`; `readRepeaterSettings(t, gates)`, `writeRepeaterSettings(t, current, patch)` — validate → diff → set changed keys only → full re-read → per-key `{ok, value, error}`; readback mismatch = key error. | local (P9), remote (P10) |
| S3 | `utils/loraAirtime.ts` `estimateLoraAirtimeMs(bytes, {sf, bw, cr})` (MeshCore preamble rule). | warnings |
| S4 | `components/MeshCore/RepeaterSettingsForm.tsx` (+ module.css): props `values, capabilities, radio, canWrite, disabled, onSave(patch) → results`; built on `ConfigSection`, `NumberInput`, `PasswordField`, `useDiscardGuard`. | config view (P9), remote admin (P10) |
| S5 | Extract `MeshCoreDeviceManagement` with `capabilities` `{reboot, powerOff, keyExport, keyImport, factoryReset}` + reasons; reuse `DangerZone`, `TypedConfirmDialog`, `device_actions.shutdown.*` copy; Companion layout unchanged. | Companion, Repeater |
| S6 | Manager Repeater branches in existing `setCoords`, `rebootDevice`, `exportPrivateKey`, `importPrivateKey`, `syncDeviceTime` + new `powerOff()`; existing routes reused. | routes |

## Design
**Manager**: public `runRepeaterCli(cmd, {timeout, secret})` over `sendRepeaterCommand`; `secret` (or `extractCliSecret` / a
secret `get`) sets `repeaterSecretInFlight` → the `:4826` / `:5635` logs print `[redacted]` (finding 5, console too). Add
terminators `??:`, `unknown config`, `ERR` (covers `ERROR:` and `(ERR:`), and `^\s*->\s*(ok|error)$` (finding 4). Strip
control chars from values (no CR/LF injection). Reboot / powerOff on Repeater: 1.5 s timeout; empty reply or teardown
rejection = "sent". Repeater `importPrivateKey`: `set prv.key` → parse new pubkey (1.12+) → `expectChange(sourceId,
{expectedKey, reason:'key_restore'})` → reboot. Companion `importPrivateKey` also calls `expectChange` (finding 7).
Generalise the tracker: optional pinned key (only that key is expected) + reason; audit row
`meshcore_identity_changed_expected` with `{reason}`; factory reset passes `reason:'factory_reset'`. `syncDeviceTime` on
Repeater: `time <epoch>`; backwards → `CLOCK_AHEAD` with hint. `setCoords` on Repeater: `set lat`/`set lon` + readback.
Fix finding 3 for name / radio / TX power via S1 `parseCliReply`. Companion `powerOff` via `run_cli poweroff` (protocol ≥ 14).

**Routes** (`ok()/fail()`, `meshcoreDeviceLimiter`, audited with redacted commands, classified in
`meshcoreRoutes.scope.test.ts`; validate the body BEFORE the connection check):
| Route | Permission | Rule |
|---|---|---|
| `GET /config/repeater-settings` | `configuration:read` | `{values, capabilities, firmware}`; guest password only as `guestPasswordSet:boolean`; admin password never; 409 `SOURCE_NOT_CONNECTED` / `NOT_REPEATER` |
| `PATCH /config/repeater-settings` | `configuration:write` | partial body; 400 `VALIDATION` with `field`: advert 0 or 60–240 (odd floored to even), flood 0 or 6–168 (cap 48 below fw 1.12), flood.max 0–64, af 0–9, rxdelay 0–20, delays 0–2, admin password 1–15 B, guest 0–15 B, no control chars; 409 if a write is in progress; per-key results; audit lists changed keys, secrets as `"[changed]"` |
| `POST /config/reboot` (existing) | unchanged | + Repeater branch |
| `POST /config/power-off` (new) | `requireAdmin` | `{confirm:true}` else 400 `DANGER_CONFIRM_REQUIRED`; Repeater fw ≥ 1.15 / Companion protocol ≥ 14 else 409 `FIRMWARE_UNSUPPORTED`; audit before send |
| `GET /config/private-key` (existing) | `configuration:write` | + Repeater (fw ≥ 1.8) |
| `POST /config/private-key` (existing) | **`requireAdmin`** (decision 3, both protocols) | `{privateKey: 128 hex, confirm:true}`; Repeater fw ≥ 1.9; restore → reboot |
| `POST /config/sync-time`, `/config/coords` (existing) | unchanged | + Repeater branch |
Danger guard (both copies + both tests): add `\bset\s+prv\.key\b`.

**UI**: `MeshCoreConfigurationView` — Repeater + connected → `RepeaterSettingsForm` with groups: Location (existing section,
now working), Adverts & forwarding (intervals with Off toggle, flood.max, repeat, af, rxdelay, txdelay, direct.txdelay),
Access (admin / guest password write-only "leave blank to keep", allow.read.only). Clock row + "Sync clock". Inline warnings
via S3 on intervals, af, flood.max, repeat (e.g. "Each flood advert is ~125 B (≈1.2 s on air with this radio) and is
repeated by every repeater that hears it, up to 8 hops. At 6 h on a mesh with 50 repeaters that is ~200 transmissions a
day."). A current value outside MeshMonitor's range (e.g. 2 min, or 3 h set from the console) is shown as-is with a note
and left untouched unless edited. Hide advert-location checkbox on Repeater. Danger zone on Repeater with capabilities
from GET; power-off and restore use typed device name. After an admin-password change: hint that saved remote-admin
credentials for this repeater are now stale.

## Work packages — WP1 → WP2 → WP3 (WP3 may start after WP1 against a mocked API); WP4 last
Every WP: typecheck, lint ratchet, `.js` server imports, no raw SQL, `ok()/fail()`, CSS modules with only DEFINED
`var(--color-*)` tokens (run `src/styles/semanticTokens.test.ts`), `UiIcon`, flat en.json, route tests via `createRouteTestApp`.
- **WP1 Shared core**: `utils/meshcoreRepeaterSettings.ts`, `utils/loraAirtime.ts`,
  `server/services/meshcoreRepeaterSettingsService.ts`; in `server/meshcoreManager.ts`: `runRepeaterCli`, terminators,
  secret-aware logging. Fixture `server/utils/__fixtures__/repeaterCliReplies.ts` with recorded firmware strings
  (`  -> > 60`, `  -> > on`, `  -> OK`, `  -> OK - repeat is now OFF`, `  -> Error: interval range is 3-168 hours`,
  `  -> Error: interval range is 3-48 hours`, `  -> ERROR: af must be 0-9`, `  -> Error, max 64`, `  -> ??: foo`,
  `  -> unknown config: foo`, `  -> OK, reboot to apply! New pubkey: <64hex>`, `  -> Error, bad key`,
  `  -> password now: x`, `  -> (ERR: clock cannot go backwards)`, plus remote-form variants without `->`). Tests: classify
  every fixture; version gates (1.11 → flood max 48; 1.14 → no poweroff; 1.8 → export but not import); odd advert minutes
  floored; diff sends only changed keys; readback mismatch → key error; terminators end `??:` within the idle gap, not 5 s;
  logger spy shows no secret in any log; airtime matches reference values ±2%.
- **WP2 Manager branches + routes**: `server/meshcoreManager.ts`, `server/services/meshcoreOwnIdentityTracker.ts`,
  `server/routes/meshcoreConfigRoutes.ts`, `server/routes/meshcoreRoutes.ts` (guard), `components/MeshCore/CliConsoleBody.tsx`
  (guard), scope test. Tests: 403 PATCH read-only; 400s (advert 59/241, 61→60, flood 5/169 and 49 on 1.11, floodMax 65,
  af 9.1, rxdelay 21, txdelay 2.1, 16-byte password, CR/LF); Off (0) accepted for both intervals; 409 Companion /
  disconnected; audit has no secrets; power-off 403 non-admin, 400 no confirm, 409 fw 1.14; key restore 403 non-admin
  (both protocols), pins `expectChange`, non-pinned key still alerts, Companion import now calls it; guard matches
  `set prv.key ab…` both sides, `get prv.key` does not; coords + sync-time Repeater branches; name/radio/TX `Error` replies
  now fail.
- **WP3 UI**: new `RepeaterSettingsForm.tsx` (+ css), new `MeshCoreDeviceManagement.tsx` (extracted),
  `MeshCoreConfigurationView.tsx`, `hooks/useMeshCore.ts`, `services/api.ts`, en.json. Tests: min/max from S1; warnings
  with computed airtime; Off toggles; out-of-range current value shows the note and is not sent; secrets write-only, blank
  omitted; only changed fields PATCHed; Repeater danger capabilities + typed confirm for power-off / restore; existing
  Companion dangerZone / factoryReset tests unchanged.
- **WP4 Docs + epic**: `docs/features/meshcore.md` (Repeater settings, airtime table, firmware gates),
  `docs/internal/dev-notes/MESHCORE_REMOTE_ADMIN.md` (terminators, secret logging, guard change, transport adapter for P10),
  epic log.

## Browser / API check
Throwaway volume, RF lockdown; a MeshCore source configured as serial Repeater (disconnected — no radio), user A with
`configuration:read` only, admin. API: PATCH validation 400s (validation before connection check); user A 403 on PATCH /
power-off / restore; admin 409 `SOURCE_NOT_CONNECTED` on GET/PATCH/reboot/power-off/private-key; power-off without confirm
→ 400. Browser: disconnected Repeater view shows "connect to read settings" with no console errors (light + dark);
Companion config + danger zone visually unchanged. Real CLI round-trips / readback / restore → reboot → key change need
the maintainer's hardware check.
