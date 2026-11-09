# MeshCore Parity P8b: per-source, protocol-aware device-config backups (#6285)

## Maintainer decisions (2026-11-09, binding)
All recommended options: Q1 migration takes the NEXT FREE number at implementation time (not necessarily 226; other phases #6276/#6281 also add migrations). Q2 download and create need configuration:write on the source (both protocols); list and summary stay read. Q3 stop writing config.security.privateKey into new Meshtastic backups (old files untouched; documented). Q4 admins may restore an unowned legacy backup of the same protocol onto a connected source after an extra confirmation; non-admins only their own source; no cross-source restore of owned files. Q5 MeshCore radio restored verbatim and last, with a current -> backup warning in the confirm dialog; TX power clamped. Q6 fixed whitelist of MeshMonitor settings. Q7 source delete keeps files as admin-only orphans. Q8 slot 0 always skipped. Release notes: download/create now need configuration:write; files now 0600; Meshtastic backups no longer include the private key.


This spec builds on `MESHCORE_PARITY_P8_SPEC.md` decision 5 and the leak fix in #6284. Base is origin/main 4402509fe. Paths are relative to `src/` unless stated. Firmware references are to `/home/yeraze/Development/MeshCore/examples/companion_radio/MyMesh.cpp` at a3a1aa5e.

## Binding decisions carried over from P8 (do not reopen)
- **What a MeshCore Companion backup holds:**
  - name, radio, TX power, coordinates, other params, auto-add, path hash, BLE PIN and channels (with secrets);
  - the MeshMonitor per-source settings;
  - never the private key or contacts.
- **How it is stored:** plaintext YAML with file mode 0600, kept out of system backups.
- **Legacy `backup_history` rows:** assigned to the only Meshtastic source if there is exactly one; otherwise admin-only.
- **Schedule settings:** per source. The legacy global settings seed the primary Meshtastic source; every other source starts with backups off. Defaults are 02:00 and 7 backups.
- **Restore:** overwrites only the channel slots that are in the backup.
- **UI:** `BackupManagementSection` gets a `protocol` prop and appears in the MeshCore config view.

## Findings (evidence)

**1. File and history layer is global (P8 finding 2).**
- `server/services/backupFileService.ts`:
  - `listBackups()` (93-107), `getBackup(filename)` (112-133) and `deleteBackup(filename)` (138-161) look rows up by filename only.
  - `purgeOldBackups()` (166-213) counts every row against one global `backup_maxBackups`.
  - `saveBackup()` (42-87) never fills the `nodeId`/`nodeNum` columns that already exist (69-75).
- `filename` is not unique (`db/schema/misc.ts:13-35`, MySQL `:376-386`).
- Repo `db/repositories/backupHistory.ts` (31/48/60/73/81/92/105) has no source filter. The facade is `services/database.ts:5657-5690`.

**2. Cross-source secret exposure that is still live.** The routes in `server/routes/backupRoutes.ts` check permission on the named source (or the primary), but the handler then reads any file by name:
- `/download/:filename` (100-123) needs only `configuration:read` on that source.
- `/restore/:filename` (153-185, getBackup at 164) can push source B's PSKs onto source A.
- Settings `GET`/`POST` (26-79) use a plain `requirePermission('configuration', …)`, which any grant on any source satisfies.
- The frontend calls `/api/backup/settings`, `/list`, `/download` and `/delete` without `sourceId` (`components/configuration/BackupManagementSection.tsx:74, 99, 159, 172, 237`). Only create (143-146) and restore (203-205) send it.

**3. Scheduler backs up only the primary Meshtastic source.**
- `server/services/backupSchedulerService.ts:201-224`, initialised with a primary resolver at `server/server.ts:370-372`.
- The day guard compares a UTC `toISOString()` date (119-121) with a local HH:MM (107-112). That is inconsistent near midnight.
- Saving a time equal to the current minute fires a backup at once, because there is no guard for today.
- `triggerManualBackup()` (245-266) has no callers.

**4. Backup files are not 0600.** `fs.writeFileSync(filepath, content, 'utf8')` (`backupFileService.ts:66`) and `mkdirSync` (30) use the umask default, normally 0644/0755. The directory is `getBackupDir()` (`server/config/dataDir.ts:40-42`). "Like Meshtastic PSKs" is therefore not true today; it needs fixing for both protocols.

**5. Meshtastic backups very likely contain the node private key.**
- `deviceBackupService.cleanConfig()` (445-483) copies every non-empty `Uint8Array`.
- `actualDeviceConfig.security` is cached at connect (`server/meshtasticManager.ts:6407-6417, 15840`), and the backup emits it as `base64:` (formatValue 76-80).
- Restore never writes `config.security` (`deviceRestoreService.ts:174-204`), so the key is stored but never used.
- Other points in the same file:
  - #6284 scoping is in place (`deviceBackupService.ts:209-218`).
  - `canned_messages` falls back to a global setting (236-242). Low risk, not secret.

**6. Device gate and connection state** (`server/utils/deviceSourcePermission.ts`).
- `config-capable` (157-164, 181-199) accepts only a live, connected Companion.
- The default gate refuses a disconnected `meshtastic_tcp` source with 409 (`requireMeshtasticDeviceSource.ts` `checkMeshtasticDeviceSource`).
- Listing, downloading or deleting files should not need a connected radio, so a new gate mode is needed.

**7. Meshtastic restore** (`server/services/deviceRestoreService.ts:136-290`).
- Only local admin packets, inside a begin/commit transaction.
- Channels written are only those in `channel_url` (230-259), so "only slots in the backup" already holds.
- LoRa is written last; it reverse-maps enums (78-89) and backfills `txEnabled`.
- `RestoreTargetManager` (31-48) is already a structural adapter seam.

**8. What MeshCore can read and write today** (`server/meshcoreManager.ts`). All bridge commands below are in `SERIAL_ONLY_BRIDGE_COMMANDS` (`server/constants/meshcoreTx.ts:33-55`), so they are allowed in receive-only mode.

| Item | Read | Write | Notes |
|---|---|---|---|
| name | `localNode.name` | `setName` 11080 | firmware prefs only (`MyMesh.cpp:1198-1204`) |
| radio | `localNode.radioFreq/Bw/Sf/Cr` (696-751) | `setRadio` 11115 | firmware applies immediately via `radio_driver.setParams` (`MyMesh.cpp:1365-1400`) |
| TX power | `localNode.txPower` (and `maxTxPower`) | `setTxPower` 11157 | manager allows 1–22; firmware accepts −9..`MAX_LORA_TX_POWER`, immediate (`:1401-1411`) |
| coordinates | `localNode.latitude/longitude` | `setCoords` 11198 | |
| other params | `localNode` / SelfInfo | see note below | firmware stores byte 1 raw; byte 5 is multi_acks (`MyMesh.cpp:1429-1444`) |
| auto-add | `getAutoAddConfig` 8570 | `setAutoAddConfig` 8584 | CMD 58/59 (`MyMesh.cpp:1954-1960`) |
| path hash | `getDefaultPathHashSize` 7778 | `setDefaultPathHashSize` 7788 | per-source setting, pushed to device as CMD 61 |
| BLE PIN | `getBlePin` 11401 | `setBlePin` 11389 | |
| channels | `listChannels` 4205 | `setChannel(idx, name, secretHex, scope)` 4232 | each write re-syncs ALL channels; reorder lock at 4292 |
| `meshcoreDefaultScope` | 7754 | 7763 | per-source setting |
| `meshcoreRespondToDiscovery` | 7684 | 7693 | per-source setting |

- Other-params writers: `set_other_params` (`server/meshcoreNativeBackend.ts:2792-2825`) writes only bit 0 of `manual_add_contacts` and keeps the device's high bits. `setMultiAcks` (11413) checks firmware ≥ 7 and reads the value back.
- Not exposed by MeshMonitor today: `client_repeat` and tuning params (rx delay, airtime factor).
- `saved_regions` is a global table.

**9. Channel rules.**
- MeshCore slot 0 is reserved and the route refuses writes to it (`server/routes/channelRoutes.ts:519-524`).
- Raw PSKs are returned only with `channel_N:write` (162-171).
- P8a made BLE PIN read need `configuration:write` (`meshcoreConfigRoutes.ts:641`).

**10. Migrations.**
- Highest registered is 224 (`db/migrations.ts:3614`).
- The registry enforces strict sequence: `db/migrationRegistry.ts:51`, `db/migrations.test.ts:16,29`.
- 225 is reserved by P7b (#6281, still OPEN, not started; `MESHCORE_PARITY_P7_SPEC.md:11`). Migration 226 is only valid once 225 exists.

**11. Other places that touch backups or sources.**
- `backup_history` is in `BACKUP_EXCLUDED_TABLES` (`server/services/systemBackupTables.ts:199-201`). A new column needs no reclassification.
- The CLI migrator skips `backup_history` (`cli/migrationTables.ts:115, 234`).
- Per-source settings use keys of the form `source:<id>:<key>` (`db/repositories/settings.ts:194, 332`).
- `deleteSource` (`db/repositories/sources.ts:116`) has no cascade.

## Design: shared pieces first (one pipeline, protocol adapters)

| ID | Piece | Used by |
|---|---|---|
| B1 | `backup_history.sourceId` + `protocol` (migration), and the repo scoped by `sourceId` | both |
| B2 | `backupFileService` scoped by source: save / list / get / delete / purge take `sourceId`; files written 0600 | both |
| B3 | `DeviceConfigBackupAdapter` interface + registry `getBackupAdapter(protocol)` | both |
| B4 | `deviceConfigBackupService` pipeline: create, list, get, restore (lock, protocol check, audit) | routes, scheduler |
| B5 | Gate `requireDeviceSourcePermission(..., { accept: 'stored' })` | file routes, settings |
| B6 | Per-source scheduler with a persisted day guard | both |
| B7 | `BackupManagementSection` with `protocol` / `sourceId` props, plus a restore confirm dialog showing a summary | ConfigurationTab, MeshCoreConfigurationView |
| MC-only | MeshCore adapter: YAML format, `set_other_params_raw`, `restoreChannels()` | MeshCore restore needs raw-byte and batched-slot writes; Meshtastic has neither |

**B1 — schema and repository**
- Columns:
  - `sourceId`: TEXT NULL (MySQL `varchar(36)`).
  - `protocol`: TEXT NOT NULL DEFAULT 'meshtastic' (MySQL `varchar(16)`).
  - Index `idx_backup_history_source_ts (sourceId, timestamp)`.
- Every repo method takes `sourceId` and filters with `eq`.
- Legacy and orphan reads use explicit methods: `listUnowned()` returns rows with NULL `sourceId` or with a `sourceId` that is no longer in `sources`.
- `getBackup(sourceId, filename)` matches on both columns.
- Fill `nodeId` / `nodeNum` on insert.

**B2 — file service**
- `saveBackup({ content, type, sourceId, protocol, nodeId })`:
  - filename `<mt|mc>-<nodeIdSanitized>-<YYYY-MM-DD>-<HH-MM-SS>.yaml`, all in UTC. This still passes the route regex `^[a-zA-Z0-9\-_]+\.yaml$`.
  - `writeFileSync(path, content, { mode: 0o600, flag: 'wx' })`; on `EEXIST`, append `-2`, `-3`, and so on.
- The directory is created with 0700.
- `initializeBackupDirectory()` runs a one-time, best-effort `chmod 0600` on existing `*.yaml` and logs failures.
- `purgeOldBackups(sourceId)` uses `source:<id>:backup_maxBackups` (default 7) and counts only that source. Legacy and orphan rows are never auto-purged.
- Keep `resolveWithinDir` everywhere.

**B3 — adapter interface**
```ts
interface DeviceConfigBackupAdapter<M> {
  protocol: 'meshtastic' | 'meshcore'; fileTag: 'mt' | 'mc'; restoreTimeoutMs: number;
  identify(m: M): { nodeId: string; nodeNum: number | null };
  generate(m: M, sourceId: string): Promise<string>;           // YAML
  parse(yaml: string): unknown;                                 // throws BACKUP_PROTOCOL_MISMATCH
  summarize(doc: unknown): BackupSummary;                       // no secrets (radio, name, channel names, pk prefix)
  restore(m: M, doc: unknown, sourceId: string): Promise<RestoreResult>; // {applied, failed, skipped, channels, requiresReboot}
}
```

**Meshtastic adapter.** It wraps the existing `deviceBackupService.generateBackup` and `deviceRestoreService.restoreBackup` unchanged, so the file stays CLI-compatible and needs no header. `parse` refuses a document that has a `meshmonitor_backup` key.

**MeshCore adapter** (`server/services/meshcoreConfigBackup.ts`).
- `generate` reads fresh values over local serial only: SelfInfo via `refreshLocalNode`, `deviceQuery`, `listChannels`, `getAutoAddConfig`, `getBlePin`, and the per-source settings. File layout:
```yaml
meshmonitor_backup: meshcore_companion
format_version: 1
created_at: <ISO>
device: { public_key, model, firmware_ver, firmware_build, max_channels }   # public key = identity check only
config:
  name, radio: {freq, bw, sf, cr}, tx_power, location: {lat, lon}
  other_params: {manual_add_contacts_raw, telemetry_mode_base, telemetry_mode_loc, telemetry_mode_env, adv_loc_policy, multi_acks?}
  auto_add: {overwrite_oldest, types: {chat, repeater, room, sensor}, max_hops}   # omitted if !supported
  path_hash_size: 1|2|3
  ble_pin: <0|100000-999999>    # omitted when DeviceInfo < v3
channels: [{idx, name, secret_hex, scope?}]      # non-empty slots only
meshmonitor: {default_scope, default_path_hash_size, respond_to_discovery}
```
- `generate` must never call `export_private_key`, never read contacts, and never log the YAML.
- **Restore order** (best-effort per section, like Meshtastic; radio last):
  1. name, coordinates.
  2. `set_other_params_raw`: a new backend case that calls `writeOtherParamsFrame` with the raw byte, the packed telemetry modes and adv-loc. The 5th byte (multi_acks) is sent only if the backup value is 0 or 1 and firmware is ≥ 7, then read back. A value above 1 is recorded in `skipped` (P8 decision 2).
  3. `setAutoAddConfig`.
  4. `setDefaultPathHashSize`.
  5. `setBlePin`. If it changed, set `requiresReboot = true` ("takes effect after the next boot").
  6. Channels through the new `manager.restoreChannels(slots)`:
     - holds the reorder lock;
     - writes each slot with `set_channel_verified`, then runs ONE `syncChannelsFromDevice` and then `updateChannelScope` per slot;
     - skips slot 0 and any slot ≥ `maxChannels` (recorded in `skipped`);
     - leaves every slot that is not in the backup untouched.
  7. The MeshMonitor settings: `setDefaultScope`, `setRespondToDiscovery`.
  8. TX power, clamped against `maxTxPower` when known, otherwise refused (`skipped`).
  9. Radio, written last.
- The restore always compares `device.public_key` with the connected radio. A mismatch adds `identityMismatch: true` to the result and the summary but does not block. After a factory reset, the identity is expected to differ, and this restore is the recovery path.

**B4 — pipeline** (`server/services/deviceConfigBackupService.ts`)
- `create(target, type)`: adapter → B2 → purge. Audit `device_backup_created` with `{sourceId, protocol, filename, type}`.
- `list(sourceId, { isAdmin })`: rows for this source. For admins, also unowned rows of the same protocol, flagged `legacy: true`.
- `get(sourceId, filename, { isAdmin })`: the row must belong to the source, or be unowned and the caller an admin. Otherwise 404 `BACKUP_NOT_FOUND`; do not leak that the file exists.
- `restore(target, filename, user)`:
  - row lookup as `get`; row `protocol` must equal the target protocol, else 409 `BACKUP_PROTOCOL_MISMATCH`;
  - `adapter.parse` (header check);
  - a per-source in-memory lock (409 `RESTORE_IN_PROGRESS`), which the scheduler also respects;
  - `adapter.restore`, then audit `device_backup_restored` with sourceId, protocol, filename and counts, never content.

**B5 — `accept: 'stored'` gate**
- Resolves the named source, or the primary Meshtastic source when omitted, and checks the permission on it.
- Then requires a `sources` row of type `meshtastic_tcp` or `meshcore` in any connection state. Other types get 400 `SOURCE_NOT_BACKUP_CAPABLE`.
- It binds `{ sourceId, protocol, named }` with no manager. Add `getStoredBackupTarget(req)`.
- The `deviceSourcePermission.scope.test.ts` gate classifier must learn the new mode.

**Route matrix** (all accept `sourceId`):

| Route | Gate | Permission | Change |
|---|---|---|---|
| `GET /api/backup/settings` | stored, query | configuration:read | per-source keys `source:<id>:backup_{enabled,time,maxBackups}` |
| `POST /api/backup/settings` | stored, body | configuration:write | save sets the day guard (see B6) |
| `GET /api/backup/list` | stored, query | configuration:read | metadata only; adds `protocol`, `legacy` |
| `GET /api/backup/summary/:filename` (new) | stored, query | configuration:read | no-secret summary for the confirm dialog |
| `GET /api/backup/download/:filename` | stored, query | **configuration:write** (Q2) | |
| `DELETE /api/backup/delete/:filename` | stored, query | configuration:write | |
| `GET /api/device/backup` (`save` true or false) | config-capable, query | **configuration:write** (Q2) | branches on protocol via the pipeline |
| `POST /api/backup/restore/:filename` | config-capable, body | configuration:write | timeout `max(adapter.restoreTimeoutMs)` = 120 s |

**B6 — scheduler**
- `initialize(registry)` replaces the primary resolver.
- Each minute, sequentially:
  - candidates are rows of type meshtastic_tcp or meshcore whose `source:<id>:backup_enabled` is `'true'`;
  - match the local HH:MM against `backup_time`;
  - the guard key `source:<id>:backup_lastAutomaticBackupDate` holds a local `YYYY-MM-DD` and must not equal today;
  - the manager must be live and connected (for MeshCore, a Companion).
- Always set the guard once the slot is reached, even on skip or failure; there is no catch-up.
- Store `backup_lastAutomaticBackupError` / `…At` so the UI can show the last result.
- On settings save with `enabled` and a time ≤ now today, set the guard to today. A save therefore never triggers a backup.
- The minute-exact match plus the persisted guard means a restart never triggers a catch-up backup.
- Delete the dead `triggerManualBackup`.

**B7 — UI**
- `BackupManagementSection` props:
  - `protocol: 'meshtastic' | 'meshcore'`;
  - `sourceId?` (defaults to `useSource()`);
  - the `connected` flag, which disables create and restore.
- Every call sends `sourceId`.
- Replace the `window.confirm` on restore with `ConfirmDialog` + summary:
  - radio: current → backup, with a warning when they differ;
  - channel slots that will be overwritten;
  - the identity-mismatch note;
  - "identity and contacts are not in this backup; use Private key import";
  - the Meshtastic reboot note.
- Legacy rows show a badge for admins only.
- Last automatic result line.
- Mount: in `ConfigurationTab.tsx:3026` with `protocol="meshtastic"`, and in `MeshCoreConfigurationView.tsx` as a SectionNav section "Backups" for Companion sources (shown when `canReadConfig`). Not for Repeaters.
- Text uses flat en.json keys under `backup_management.*`.

## Migration 226 (all three backends)
- File: `server/migrations/226_backup_history_source_protocol.ts`, with `migration.up(db)`, `runMigration226Postgres`, `runMigration226Mysql`. Register it in `db/migrations.ts` with settingsKey `migration_226_backup_history_source_protocol`. Update the schemas in `db/schema/misc.ts` (all three).
- Steps, each idempotent:
  1. Add the columns with `addColumnIfMissing*` helpers.
  2. Create the index (`createIndexIfMissingMysql` on MySQL).
  3. Backfill `UPDATE backup_history SET sourceId=? WHERE sourceId IS NULL` only when `SELECT COUNT(*) FROM sources WHERE type='meshtastic_tcp'` = 1. `protocol` defaults to `meshtastic`.
  4. Seed the per-source schedule. Primary = the first `meshtastic_tcp` row ordered by `enabled DESC, displayOrder, createdAt`. Copy global `backup_enabled`, `backup_time`, `backup_maxBackups`, `backup_lastAutomaticBackup` (converted to `backup_lastAutomaticBackupDate`) into `source:<primary>:…` using INSERT … ON CONFLICT DO NOTHING / INSERT IGNORE. Leave the globals in place; they become unread. Do this per migration 050's freeze rule.
- Tests: `226_*.test.ts` (SQLite) and `226_*.pgmysql.test.ts` cover one-source backfill, two-source stays NULL, zero-source no seed, re-run idempotent, and an existing per-source key not clobbered.
- Numbering: see Q1.

## Mesh impact
- **Create (both protocols):** no RF.
  - Meshtastic reads cached config.
  - MeshCore sends local serial frames: APP_START/SelfInfo, DeviceQuery, one CMD_GET_CHANNEL per slot, CMD 59, DeviceInfo for the PIN.
  - Nightly per source; it shares the serial queue with live traffic. Skip when a channel reorder or restore is running.
- **Restore (MeshCore):** every write is a local prefs write (`SERIAL_ONLY_BRIDGE_COMMANDS`); nothing is transmitted and no advert is triggered. Effects:
  - radio params and TX power apply immediately (`MyMesh.cpp:1393, 1409`). A backup taken on another frequency takes the node off its mesh at once. This is the reason for the radio-last order and the confirm warning.
  - name, coordinates and adv-loc policy show up in the next advert (MeshMonitor auto-announce or a manual advert).
  - multi_acks = 1 restores the P8a airtime cost. It is capped at 1.
  - path hash size widens every outgoing flood path.
  - telemetry modes change what we answer to requests over the air.
  - the BLE PIN applies at the next boot.
  - channel overwrites change which channel MeshMonitor's per-slot message history, notification rules and `channel_N` permissions refer to. This is the same as editing a slot today; the UI lists the overwritten slots.
  - no `recordMeshTx` calls.
  - receive-only sources may restore (local-only).
- **Restore (Meshtastic):** unchanged from #4926: local admin packets, LoRa last, possible reboot.
- **New bridge command:** `set_other_params_raw`, to be added to `SERIAL_ONLY_BRIDGE_COMMANDS` and `OTHER_PARAMS_COMMANDS`. `restoreChannels` reuses `set_channel_verified`.

## Security
- **Files hold secrets:**
  - MeshCore: channel secrets and BLE PIN.
  - Meshtastic: PSKs, the Bluetooth fixed PIN, MQTT password, and (finding 5) the private key.
  - Protection: mode 0600, directory 0700, path containment kept, excluded from system backups (unchanged).
- **MeshCore never includes the private key or contacts.** A test asserts that the generator never calls `export_private_key`, and that the YAML has no `private`/`prv` keys and no 64-byte hex outside `channels[].secret_hex`.
- **Scoping:** every file operation is scoped to the source; another source's filename returns 404. Legacy and orphan rows are admin-only. Cross-protocol restore returns 409.
- **Permissions:** download and create need `configuration:write`, in line with the BLE PIN read rule (P8a) and the PSK display rule (MM-SEC-2) (Q2). Restore stays `configuration:write` on the target, as on Meshtastic today; per-channel `channel_N:write` is not checked (parity).
- **Logs and audit:** never log YAML, secrets or the PIN. A logger-spy test checks that a known secret hex never appears. Audit create, download, delete and restore with ids only.
- **Rate limit:** create and restore use `meshcoreDeviceLimiter` for MeshCore targets.

## Work packages
Order: WP1 → WP2 → (WP3 ∥ WP4) → WP5.

Every WP needs: typecheck, lint ratchet, `.js` server imports, no raw SQL outside repos/migrations, `ok()`/`fail()` on new and changed handlers, `createRouteTestApp` route tests, CSS modules with `var(--color-*)`, flat en.json.

**WP1 — data and files.**
- Files: `server/migrations/226_*.ts` (+ two tests), `db/migrations.ts`, `db/schema/misc.ts`, `db/repositories/backupHistory.ts`, `services/database.ts` (5657-5690), `server/services/backupFileService.ts`.
- Tests:
  - new `backupHistory.perSource.test.ts`: isolation and unowned listing;
  - file service: mode 0600 (`statSync().mode & 0o777`), `wx` collision suffix, purge per source ignores other sources and legacy rows, `getBackup` with the wrong source returns not-found;
  - existing `backupFileService.pathContainment.test.ts` updated.

**WP2 — gate, pipeline, Meshtastic adapter, routes, scheduler.**
- Files: `server/utils/deviceSourcePermission.ts` (`stored`), new `server/services/deviceConfigBackupService.ts` + `server/services/backupAdapters/{index,meshtastic}.ts`, `server/routes/backupRoutes.ts`, `server/routes/deviceRoutes.ts` (46-90), `server/services/backupSchedulerService.ts`, `server/server.ts:370`.
- Tests:
  - extend `backupRoutes.deviceBackup.permissions.test.ts`: another source's file returns 404; legacy row is admin-only; download as read-only returns 403 under Q2; settings are per source with no cross-grant;
  - `deviceSourcePermission.scope.test.ts`: `stored` classification, disconnected meshtastic_tcp/meshcore allowed, MQTT gets 400;
  - restore protocol mismatch returns 409; restore lock returns 409;
  - scheduler (fake timers): two sources at different times; disabled source never runs; save at the current minute does not fire; restart in the same minute after a run does not fire; disconnected source sets the guard and the error;
  - `requestTimeout.routes.test.ts` updated for the 120 s restore timeout.

**WP3 — MeshCore adapter.**
- Files: new `server/services/backupAdapters/meshcore.ts`, `server/meshcoreNativeBackend.ts` (`set_other_params_raw`), `server/constants/meshcoreTx.ts`, `server/meshcoreManager.ts` (`restoreChannels`, plus a public `readBackupSnapshot()` helper that gathers the reads).
- Tests:
  - YAML round-trip;
  - frame bytes for `set_other_params_raw` with and without byte 5; multi_acks above 1 is skipped;
  - restore writes only the backup slots, skips slot 0 and slots ≥ `maxChannels`, one sync, scope persisted;
  - radio is the last section; a TX power above `maxTxPower` is skipped;
  - identity-mismatch flag set;
  - no-secret summary;
  - the private-key and contacts negative tests from Security;
  - a disconnected source returns 409 via the gate.

**WP4 — UI.**
- Files: `components/configuration/BackupManagementSection.tsx` (+ test), new `components/configuration/BackupRestoreConfirmDialog.tsx`, `components/ConfigurationTab.tsx`, `components/MeshCore/MeshCoreConfigurationView.tsx` (section + nav), `services/api.ts` if needed, `public/locales/en.json`.
- Tests:
  - every call carries `sourceId`;
  - MeshCore protocol hides the Meshtastic reboot text;
  - the radio-change warning renders;
  - create and restore are disabled when disconnected;
  - legacy badge shows only for admins;
  - the existing ConfigurationTab tests stay green.

**WP5 — docs.**
- Files: `docs/features/device.md` (per-source backups, 0600, what each protocol holds), `docs/features/meshcore.md` (Companion backups: contents, what restore changes, no identity or contacts), epic phase log.
- Then close #6285.

**Browser and API check:** throwaway volume, RF lockdown.
- Seed: one Meshtastic TCP + one MeshCore Companion source, both disconnected; user A with `configuration:write` on the Meshtastic source only; an admin; plus a legacy row fixture.
- API checks:
  - list for each source is isolated;
  - user A on the MeshCore source gets 403;
  - restore and create on a disconnected source return 409;
  - legacy row is visible to the admin only;
  - files on disk are 0600.
- Browser checks: both config views list backups; no console errors in light or dark.

## Open questions for the maintainer
1. **Migration number.** The registry forbids gaps, and 225 (P7b #6281) is not merged or started. *Recommend:* take the next free number when implementing (225 if P7b has not landed) and update the P7 spec's reservation, instead of blocking on P7b.
2. **Download/create permission.** Files hold secrets but download needs only `configuration:read` today. *Recommend:* `configuration:write` on the source for download and for `GET /api/device/backup`, on both protocols. This matches the BLE PIN read rule and MM-SEC-2. Listing and the summary stay `read`.
3. **Meshtastic private key (finding 5).** *Recommend:* stop writing `config.security.privateKey` from now on (restore never uses it; MeshCore's rule is "never"), and document it. Leave old files alone.
4. **Legacy and orphaned backups.** *Recommend:* an admin may restore an unowned backup of the same protocol onto any connected source after an extra confirmation. Non-admins can only use their own source's files. No cross-source restore of owned files.
5. **MeshCore radio on restore.** *Recommend:* restore verbatim with a current → backup warning in the confirm dialog (parity with #4926 LoRa). The alternative is skipping the radio unless a checkbox is ticked.
6. **"MeshMonitor per-source settings" scope.** *Recommend:* a fixed whitelist (`meshcoreDefaultScope`, `meshcoreDefaultPathHashSize`, `meshcoreRespondToDiscovery`, per-channel scope). Automations are left out: some of them transmit, and system backup covers them.
7. **Source deletion.** *Recommend:* keep the files as orphans, visible and deletable by admins only. The alternative is deleting them with the source.
8. **Slot 0 on MeshCore restore.** *Recommend:* always skip it and report it, consistent with `MESHCORE_CHANNEL_ZERO_RESERVED`.

## Out of scope
- Repeater and Room Server backups (P9/P10 settings export exists); meshcore_mqtt, MQTT and Reticulum sources.
- Contacts and the private key in MeshCore backups.
- Selective per-section restore; uploading an external YAML to restore; encrypting backup files at rest.
- `client_repeat` and tuning params (not exposed by MeshMonitor); `saved_regions` (global).
- Putting device backups into system backups.
- Catch-up runs for missed scheduled backups.
- Per-source canned messages in Meshtastic backups.

### Critical files for implementation
- `/home/yeraze/Development/meshmonitor/src/server/services/backupFileService.ts`
- `/home/yeraze/Development/meshmonitor/src/server/routes/backupRoutes.ts`
- `/home/yeraze/Development/meshmonitor/src/server/services/backupSchedulerService.ts`
- `/home/yeraze/Development/meshmonitor/src/server/utils/deviceSourcePermission.ts`
- `/home/yeraze/Development/meshmonitor/src/server/meshcoreManager.ts` (with `/home/yeraze/Development/meshmonitor/src/server/meshcoreNativeBackend.ts`)
- `/home/yeraze/Development/meshmonitor/src/db/schema/misc.ts`, `/home/yeraze/Development/meshmonitor/src/db/migrations.ts`
- `/home/yeraze/Development/meshmonitor/src/components/configuration/BackupManagementSection.tsx`
