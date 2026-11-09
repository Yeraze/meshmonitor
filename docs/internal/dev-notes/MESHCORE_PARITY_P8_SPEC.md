# MeshCore Parity P8 — Companion extras (#6257)

Part of the parity epic (`MESHCORE_PARITY_EPIC.md`). Base: `main` with P1–P7a. Paths relative to `src/`. Firmware refs:
`meshcore-dev/MeshCore` `examples/companion_radio/MyMesh.cpp` @ main (v1.18.0, `FIRMWARE_VER_CODE 14`) and per-tag copies;
meshcore.js = `@liamcottle/meshcore.js` 1.13.0.

**Split (maintainer, 2026-11-08):** leak fix shipped separately (PR #6284 — device backups scoped to the backed-up
source's channels); **P8a** (this branch) = BLE PIN, multi-ACKs, factory reset, channel share/import (no migration);
**P8b** (follow-up) = protocol-aware device-config backups, per-source `backup_history`, migration 226.

## Maintainer decisions (2026-11-08, binding)
1. Split as above.
2. **multi_acks**: on/off only (0/1); server rejects >1; toggle shows the airtime warning ("each received DM sends one
   extra ACK along its return path — about one extra transmission per hop per DM").
3. **Factory reset**: `requireAdmin` + type the device name (public-key prefix if the name is empty); connected Companion
   with firmware ≥ 7 (companion-v1.7.3) only; allowed on WiFi/TCP sources with an extra "you may lose network access /
   WiFi credentials are wiped" warning.
4. **After reset**: delete the source's captured `meshcore_source_pki_keys` row; `meshcoreOwnIdentityTracker` expects the
   change (no own-key alert); write audit row `meshcore_factory_reset_identity_changed` instead.
5. (P8b) MeshCore config backups store channel secrets + BLE PIN in plaintext like Meshtastic PSKs, file mode 0600, out of
   system backups; never the private key or contacts. Legacy `backup_history` rows → the only Meshtastic source if exactly
   one, else admin-only. Per-source schedule settings; legacy globals seed the primary Meshtastic source; others off.
   Restore overwrites only the slots in the backup.
6. **Share** requires `configuration:write` on the source (URL reveals the secret); include `region_scope` when set.

## Mesh impact
- BLE PIN `CMD_SET_DEVICE_PIN` (37) → prefs, effective next boot (`MyMesh.cpp:1839-1851`, `main.cpp:188-204`). Local only.
- Factory reset `CMD_FACTORY_RESET` (51) formats FS + reboots (`MyMesh.cpp:1965-1977`). Local only.
- multi_acks: setting is local; EFFECT is airtime — `Mesh::routeDirectRecvAcks` sends `multi_acks` extra direct ACKs 300 ms
  apart per received ACK-wanting DM (`src/Mesh.cpp:379-391`), repeated by every return hop. Permanent until off. Capped at
  1 with a UI warning (decision 2).
- Channel import: one `set_channel` (serial-only). Share/QR: computation only.
- All new bridge commands go in `SERIAL_ONLY_BRIDGE_COMMANDS` (`server/constants/meshcoreTx.ts:33-50`).

## Firmware support (verified)
| Feature | Wire | Firmware | Gate (`localNode.firmwareVer`) | Evidence |
|---|---|---|---|---|
| Set BLE PIN | `[37][u32 LE pin]` → OK/ERR | all companion tags; current accepts only 0 or 100000–999999 (else `ERR_CODE_ILLEGAL_ARG`) | all; server validates `0 \| 100000–999999` | `MyMesh.cpp:45,1839-1851`; meshcore.js has no helper (`constants.js:60` todo) → raw frame |
| Read BLE PIN | DeviceInfo `[13][ver][maxC/2][maxCh][ble_pin u32]…` | v3+ | parsed already (`meshcoreCompanionCodec.ts:659,672`; `meshcoreManager.ts:11387`) but not kept on `localNode` | `MyMesh.cpp:1056-1065` |
| Factory reset | `[51]['r','e','s','e','t']`; serial disabled before format → OK frame may never arrive | companion-v1.7.3+ (code 7); absent v1.7.0–1.7.2 | `firmwareVer >= 7` | `MyMesh.cpp:54,1965-1977`; not in meshcore.js |
| multi_acks set | SetOtherParams 5th byte `[38][manual][telem][advLoc][multi_acks]` | companion-v1.7.4+ (v1.7.3 is also code 7 but ignores byte 5) | `firmwareVer >= 7` + SelfInfo readback (`multiAcks`); mismatch → 409 `MULTI_ACKS_UNSUPPORTED` | `MyMesh.cpp:1488-1503,1099`; meshcore.js parses `multiAcks` (`connection.js:732,750`) but `sendCommandSetOtherParams` writes 4 bytes (`:335-347`) |
| Channel URL | `meshcore://channel/add?name=<urlenc>&secret=<32 hex>[&region_scope=<urlenc>]` | MeshCore app (`region_scope` app v1.47.0+); firmware stores only 16-byte secrets | n/a | docs.meshcore.io/qr_codes ("Add Channel"); hashtag names may omit the secret → derived (`deriveHashtagSecretHex`) |

**Factory reset erases**: identity key pair (new public key — peers lose the node), all prefs (name, radio, TX power,
coords, telemetry modes, auto-add, multi_acks, path-hash mode, BLE PIN, WiFi SSID/password), all channels, contacts,
scope keys; radio returns to build defaults. MeshMonitor DB history is kept.

## Findings (evidence)
1. (Fixed in #6284) device backups read `getAllChannels(ALL_SOURCES)`.
2. (P8b) backup routes check per-source permission but `listBackups()/getBackup()/deleteBackup()` are global;
   `backup_history` has no `sourceId` (`db/schema/misc.ts:13-35`); purge counts globally.
3. (P8b) scheduler backs up only the primary Meshtastic source (`backupSchedulerService.ts:22-28,201-224`).
4. `requireDeviceSourcePermission` refuses non-Meshtastic (`utils/deviceSourcePermission.ts:24-31`); encode-url / import
   routes sit behind it (`channelRoutes.ts:1139`).
5. **Latent bug**: `set_other_params` (`meshcoreNativeBackend.ts:2788-2812`) via meshcore.js writes
   `manualAddContacts ? 1 : 0`, clobbering the per-type auto-add bits `set_auto_add_contacts` preserves (`:2814-2862`).
   All other-params writers go through `runOtherParamsOp` / `OTHER_PARAMS_COMMANDS` (`:403-420`, `:1500-1517`).
6. MeshCore channel writes use shared `PUT /api/channels/:idx` (`MeshCoreChannelsConfigSection.tsx:268`); `nextFreeIdx`
   ignores `maxChannels` and returns 255 when full (`:185-189`).
7. Meshtastic share: `ExportConfigModal` → server `encode-url` → `QrCodeCanvas` + copy; `ImportConfigModal` decode →
   preview → `/api/channels/import-config` → Meshtastic poll/reboot follow-up (`ImportConfigModal.tsx:63,92,130-161`);
   encode needs `configuration:write`, decode `configuration:read` (`channelRoutes.ts:1110,1139`).
8. Meshtastic factory reset: `requireAdmin`, local only, audited before send (`adminRoutes.ts:1595-1615`), typed-name
   `TypedConfirmDialog` + wipe list (`admin-commands/DeviceActionsSection.tsx:88-90,165-190`).
9. Meshtastic BLE PIN control inline in `admin-commands/DeviceConfigurationSection.tsx:985-1015`.
10. Factory reset triggers P7a: new identity → `observeOwnIdentity` → `notifyOwnKeyChanged`
    (`meshcoreManager.ts:8634-8650`); PKI row gets `keyMismatch` (`:9405-9525`).

## Not feasible / out of scope
32-byte channel secrets (firmware rejects); camera QR scanning (paste URL / scan with phone); Repeater config backup
(P9/P10); meshcore_mqtt sources (no device); contacts in backups; private key in backups (never); confirming reset
completion (success = frame sent + disconnect/reconnect).

## Shared pieces (P8a)
| ID | Piece | Used by |
|---|---|---|
| S1 | `utils/meshcoreChannelUrl.ts` isomorphic encode/decode/validate (hashtag-derive when secret missing; lowercase hex; reject all-zero / bad hex / wrong scheme) | server adapter, modals |
| S2 | Protocol dispatch in `channelRoutes.ts` `encode-url` / `decode-url` / `import-config`: Meshtastic → `channelUrlService`; MeshCore → S1, single channel, import into lowest free slot `1..maxChannels-1` (dedupe on equal secret → report existing slot; full → 409 `NO_FREE_CHANNEL_SLOT`) | both |
| S3 | `requireDeviceSourcePermission(…, { accept: 'meshtastic' \| 'config-capable' })` + `getDeviceSourceTarget` → `{ protocol, manager }`; `config-capable` = Meshtastic TCP or connected MeshCore Companion; default stays `meshtastic` (existing ~30 routes unchanged) | encode-url, import-config (P8b: backups) |
| S4 | `ExportConfigModal` / `ImportConfigModal` `protocol` prop: MeshCore mode single-select, no LoRa option, no Meshtastic poll/reboot follow-up | ConfigurationTab, AdminCommandsTab, MeshCoreChannelsConfigSection |
| S5 | `shared/config/BluetoothPinField.tsx` modes via props (`random|fixed|none`), `fixedRange` prop | admin DeviceConfigurationSection (unchanged), MeshCore device settings (`default(0)|fixed`, 100000–999999) |
| S6 | `shared/config/FactoryResetWipeList.tsx` list from props (reuse `device_actions.reset_wipes_*` keys) | DeviceActionsSection, MeshCore DangerZone |
| MC-only | multi-ACKs toggle (no Meshtastic equivalent) | |

## Design (P8a)
**Backend**: new backend cases (all `SERIAL_ONLY_BRIDGE_COMMANDS`; `set_multi_acks` also `OTHER_PARAMS_COMMANDS`):
`set_device_pin` raw `[37, pin LE]` → OK/ERR (ERR → `ILLEGAL_ARG`); `factory_reset` raw `[51,'r','e','s','e','t']`,
resolve on OK, on disconnect, or after 3 s silence; ERR → fail; `set_multi_acks` read-modify-write against fresh SelfInfo
via new private `writeOtherParamsFrame({manual, telemPacked, advLoc, multiAcks?})`, then re-read and verify. Refactor
`set_auto_add_contacts` and `set_other_params` onto `writeOtherParamsFrame` (fixes finding 5 — preserve the raw
`manual_add_contacts` byte). Manager: `setBlePin(pin)`, `getBlePin()` (via `deviceQuery`), `setMultiAcks(n)`,
`factoryReset()` — Companion-only, firmware-gated, errors `FIRMWARE_UNSUPPORTED` / `SOURCE_NOT_CONNECTED`; keep
`localNode.multiAcks` from SelfInfo (beside `advLocPolicy`, `meshcoreManager.ts:5822`). After reset sent: delete PKI row,
`meshcoreOwnIdentityTracker.expectChange(sourceId)` (next change accepted silently + audit row; decision 4).

**Routes** (`meshcoreConfigRoutes.ts`, `ok()/fail()`, `meshcoreDeviceLimiter`, audited; classify in
`meshcoreRoutes.scope.test.ts`):
| Route | Permission | Body / rule |
|---|---|---|
| `GET /config/ble-pin` | `configuration:write` (pairing credential) | |
| `POST /config/ble-pin` | `configuration:write` | `{pin}` 0 or 100000–999999 |
| `POST /config/multi-acks` | `configuration:write` | `{value}` 0..1 |
| `POST /config/factory-reset` | `requireAdmin()` | `{confirm:true}` else 400 `DANGER_CONFIRM_REQUIRED`; audit BEFORE send |

**Channel share**: each channel card in `MeshCoreChannelsConfigSection` gets "Share" → `ExportConfigModal
protocol="meshcore"` preselected; server builds URL (S2) incl. `region_scope` when scoped. Header "Import from URL" →
`ImportConfigModal protocol="meshcore"` with preview (name, masked secret, scope, target slot). Slot 0 never a target;
server + UI use `maxChannels`; fix finding 6's 255 fallback.

**Factory-reset UX**: DangerZone button in `MeshCoreConfigurationView`, admin-only, connected Companion with firmware ≥ 7
(else disabled with reason tooltip) → `TypedConfirmDialog` (`confirmWord` = device name or pk prefix) +
`FactoryResetWipeList` (settings, channels, contacts, network/WiFi, identity); TCP warning; "back up first" → private-key
export link (P8a) / backups (P8b).

**BLE PIN / multi-ACKs UI**: in `MeshCoreDeviceSettingSections*` via S5 (note "applies after reboot; Bluetooth builds
only") and a multi-ACK toggle with the decision-2 warning.

## Work packages (P8a) — WP1 → WP2; WP3 ∥ (WP1, WP2); WP4 last
Every WP: typecheck, lint ratchet, `.js` server imports, no raw SQL, `ok()/fail()`, CSS modules + `var(--color-*)`,
`UiIcon`, flat en.json, route tests via `createRouteTestApp`.
- **WP1 Companion commands (server)**: `server/meshcoreNativeBackend.ts`, `server/constants/meshcoreTx.ts`,
  `server/meshcoreManager.ts`, `server/routes/meshcoreConfigRoutes.ts`, `server/services/meshcoreOwnIdentityTracker.ts`
  (`expectChange`), repo delete for PKI row. Tests: frame bytes for 37/51/38 incl. byte 5 and preserved high bits of
  `manual_add_contacts` (extend `meshcoreNativeBackend.otherParamsSerialization.test.ts`); reset resolves on
  disconnect/timeout, fails on ERR; multi-acks readback mismatch → 409; firmware gate ver 6 vs 7; routes: 403 non-admin
  reset, 400 no confirm, 400 bad PIN (123, 1234567), 409 disconnected/repeater, audit written before send; tracker
  suppresses alert after `expectChange`; scope-guard classification.
- **WP2 Companion UI**: new `shared/config/BluetoothPinField.tsx` (+ module.css), `admin-commands/DeviceConfigurationSection.tsx`,
  `MeshCore/MeshCoreDeviceSettingSections*`, new `shared/config/FactoryResetWipeList.tsx`,
  `admin-commands/DeviceActionsSection.tsx`, `MeshCore/MeshCoreConfigurationView.tsx`, `MeshCore/hooks/useMeshCore.ts`,
  en.json. Tests: Meshtastic Bluetooth PIN unchanged; MeshCore PIN validation + notes; multi-ACK warning; reset gating
  (admin, firmware, connected); typed confirm required; DeviceActionsSection renders the same list.
- **WP3 Channel share/import**: new `utils/meshcoreChannelUrl.ts` (+ test), `server/routes/channelRoutes.ts`,
  `server/utils/deviceSourcePermission.ts` (S3), `components/configuration/{Export,Import}ConfigModal.tsx`,
  `MeshCore/MeshCoreChannelsConfigSection.tsx`, `services/api.ts`, en.json. Tests: round-trip, URL-encoded `#` names,
  missing-secret hashtag derive, reject bad hex / all-zero / wrong scheme; encode for MeshCore needs `configuration:write`
  on THAT source (403 for another source's grant); import picks lowest free slot ≥ 1 below `maxChannels`; full → 409;
  same secret reports existing slot; S3 default still refuses MeshCore on Meshtastic-only routes; Meshtastic modal
  regression.
- **WP4 Docs + epic**: `docs/features/meshcore.md` (PIN, multi-ACKs + airtime, reset + what it erases, share URL format
  citing docs.meshcore.io/qr_codes), epic log; open the P8b follow-up issue.

## Browser / API check (P8a)
Throwaway volume, RF lockdown; seed one Meshtastic TCP + one MeshCore Companion source (both disconnected), user A with
`configuration:write` on the Meshtastic source only, plus admin. No radio → device commands can't run; firmware behaviour
covered by WP1 frame/gate tests. API: `decode-url` on a `meshcore://` URL returns fields; `encode-url` / `import-config`
on the MeshCore source → 403 user A, 409 `SOURCE_NOT_CONNECTED` admin; BLE PIN / multi-ACKs / reset → 409 disconnected;
reset as user A → 403; reset without confirm → 400. Browser: Admin Commands Bluetooth PIN unchanged via shared field;
DeviceActionsSection reset dialog unchanged; Meshtastic Export/Import modals unchanged; MeshCore config view while
disconnected shows no console errors in light + dark.
