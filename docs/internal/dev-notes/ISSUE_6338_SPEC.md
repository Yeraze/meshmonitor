## Maintainer decisions (2026-11-10, binding)
Reject only when the root changes (an unknown previous value counts as changed). Enforce on POST /config/mqtt, remote-admin setMQTTConfig, broker presets and the embedded-broker rootTopic (reject empty there) with fail(400, 'INVALID_MQTT_ROOT', msg, {field, reason}). Restores stay verbatim with a logged warning (add warnings[] to RestoreResult). No normalisation on device saves. Localise the error in the UI via ApiError code/reason and disable Save on a changed invalid root.

# Spec: #6338, reject invalid MQTT root topics server-side

## Findings
- **Validator.** `src/utils/mqttRootTopic.ts:9` sets `MAX_ROOT_BYTES = 31`. `validateMqttRoot` at `:33-47` returns `WHITESPACE | CONTROL | INVISIBLE | WILDCARD | SLASH | ENDS_WITH_2 | TOO_LONG`, and `''` is valid (firmware default). It is already imported server-side (`src/server/utils/mqttRootFinderTarget.ts:27,64`, `src/server/services/mqttRootFinder/ladder.ts:191`), so it is safe to reuse in the server.
- **en.json.** It has all seven `mqtt_root_finder.validation.<CODE>` strings.
- **Firmware limit.** `protobufs/meshtastic/module_config.options:6` has `*MQTTConfig.root max_size:32`. Usable is 32-1 = 31 bytes, so `MAX_ROOT_BYTES` already matches firmware.
- **UI is advisory only.** `src/components/MQTT/MqttRootFieldError.tsx:1-3` says "UI only: the server does not reject a root on save". It is used in `MQTTConfigSection.tsx:627`, `ModuleConfigurationSection.tsx:363`, `SavedBrokerPresetDialogs.tsx:159`, and in warn mode at `MqttBridgeConfigurationView.tsx:703`. No form disables Save.

### Server paths that save a root, and what they check today
| Path | Location | Current check |
|---|---|---|
| Local device `POST /api/config/mqtt` | `src/server/routes/configRoutes.ts:247-260` | None. Only `fillDeviceMqttFromPreset`, then `setMQTTConfig` (`deviceAdminService.ts:275-292`, firmware replaces the whole struct). |
| Remote admin `setMQTTConfig` | `src/server/routes/adminRoutes.ts:2124-2134` | Checks only that `config` is present, plus the preset fill. |
| Saved broker presets (`rootTopic`; applied to the device `root` at `src/components/MQTT/brokerPresets.ts:242`) | `src/server/routes/mqttBrokerPresetRoutes.ts:110-115` | Weak. Trims, strips trailing `/`, rejects `#`, `+` and whitespace. Allows control and invisible characters, leading `/`, `//`, `/2`, and more than 31 bytes. Errors are `{error}` only. |
| Embedded broker source `mqtt_broker.rootTopic` | Type at `src/server/mqttBrokerManager.ts:43`. Used as a prefix at `:165` and `:425` (`(rootTopic ?? 'msh') + '/'`). Create at `sourceRoutes.ts:1021-1027`, update at `:1329-1336`. | None. A `''`, trailing `/` or wildcard root silently breaks the prefix match. The UI does not edit this field (API only), and it is shown at `sourceConfigRedaction.ts:531`. |
| MQTT bridge sources | `subscriptions` are topic filters (wildcards are legal) | Out of scope. The UI only warns, which is correct. |
| MeshCore MQTT | Fixed `meshcore/{IATA}/…`. IATA is validated at `sourceRoutes.ts:385-390`. | No root. Out of scope. |
| First-boot env vars | None found for an MQTT root (grep of `src/server/config/*Env.ts` and `process.env.*MQTT`) | N/A |
| Device config restore (#4926) | `backupRoutes.ts:168-205`, then `deviceRestoreService.ts:207-208` calls `manager.setMQTTConfig(moduleConfig.mqtt)` directly, bypassing the routes. It is best-effort per section; failures go to `failed[]`. | None (verbatim by design). |
| System restore | Copies `sources` (`systemBackupTables.ts:40`) and `mqtt_broker_presets` (`:176`) table-wide. | None (only archive validation). |

### Previous root, for checking only changed values
- **Local node:** `manager.getActualModuleConfig()?.mqtt?.root`. The same read is used at `deviceAdminService.ts:638`.
- **Remote node:** `manager.getRemoteNodeConfig(nodeNum)?.moduleConfig?.mqtt?.root` (`meshtasticManager.ts:6299`). The remote-admin form refuses Save until it has loaded the node's config (`AdminCommandsTab.tsx:1329-1339`), so this cache is normally filled.
- **Preset:** the stored row, already loaded as `stored` in the preset parser.
- **Broker source:** `existing.config.rootTopic` in PUT.

### How the UI shows errors today
- `apiService.setMQTTConfig` (`src/services/api.ts:1845-1858`) throws `new Error(body.error)` and drops `code`. `ConfigurationTab.tsx:1173-1177` shows `mqtt_failed: <message>` in a toast.
- The admin `executeCommand` shows `error.message` in a toast (`AdminCommandsTab.tsx:~998-1006`).
- Result: the server's message text is what users see.

## Which paths to enforce on
1. `POST /api/config/mqtt` and admin `setMQTTConfig`: enforce, only when the root changes (see the next section).
2. Broker preset create/update: replace the ad-hoc regex with `validateMqttRoot`, applied after the existing trim and trailing-slash strip. Enforce only when it differs from `stored.rootTopic`. A new preset always counts as a change.
3. `mqtt_broker` source create/update: validate `rootTopic` when present and changed. Also reject `''`, because `''` means "firmware default" for a device but here it produces the prefix `/`.
4. Device restore and system restore: do not reject. Restore is verbatim by #4926 design, and refusing a whole archive or MQTT section because of an old root is worse than restoring it. In `deviceRestoreService`, log a `logger.warn` and add a non-fatal note (e.g. a `warnings[]` entry in `RestoreResult`, if the maintainer agrees).
5. Bridge, MeshCore and env vars: nothing to do.

Put the logic in one helper, `src/server/utils/mqttRootGuard.ts`:
```ts
checkMqttRootSave(next: unknown, prev: unknown, opts?: { allowEmpty?: boolean })
  : null | { code: 'INVALID_MQTT_ROOT'; reason: MqttRootErrorCode | 'NOT_STRING' | 'EMPTY'; message: string }
```
Rules:
- `undefined` → valid (proto default `''`).
- A non-string → `NOT_STRING`.
- `next === prev` → valid, skipped.
- Otherwise run `validateMqttRoot`.

`message` comes from a small server-side English map that copies the en.json wording.

## Existing invalid saved configs
- **Reject only when the root changes (recommended).** Unrelated edits still save, e.g. toggling map reporting on a node that already has `msh/US ` or a 40-byte root. This matters because firmware replaces the whole struct, so every save resends the root. Restores are not affected. The user can't save a new bad root. Cost: a stored bad root can stay until someone edits it. If the previous value is unknown (no cache), treat the root as changed and validate it.
- **Reject always.** Strictest. It blocks every MQTT edit on any node or preset that already holds a bad root, including roots set by the Meshtastic app or CLI, until the root is fixed. If also applied to restore, it would fail the whole `module.mqtt` section, so old backups would restore without MQTT. It would also block system restores containing such presets or sources.
- **Warn only.** Returns `ok` with `warnings: [{ field: 'root', reason }]`. It never blocks, so it does not meet the issue's goal. It is only suitable for restore paths.

## Error envelope
```ts
return fail(res, 400, 'INVALID_MQTT_ROOT', err.message, { field: 'root' /* or 'rootTopic' */, reason: err.reason });
```
- Run it after `fillDeviceMqttFromPreset` in `configRoutes.ts` and before `buildAdminMessage` in `adminRoutes.ts`. Presets and sources should also use `fail()` for this code, even though their neighbouring checks still return `{error}`.
- **UI, minimal:** nothing to change. The English `message` appears in the existing toasts.
- **UI, recommended:** change `apiService.setMQTTConfig` to throw `ApiError(message, status, { code, body })`. Callers then map `code === 'INVALID_MQTT_ROOT'` to `t(\`mqtt_root_finder.validation.${body.reason}\`)` so the message is localized. Add `NOT_STRING`/`EMPTY` keys, or fall back to `message`.
- Update the comment in `MqttRootFieldError.tsx:1-3`.
- Optional: disable Save when the root has changed and is invalid, mirroring the server.

## Test plan
Use `createRouteTestApp` (`src/server/test-helpers/routeTestApp.ts`) and mock the device manager as `configRoutes.test.ts` does.
- **`configRoutes.mqttRoot.test.ts`:**
  - One case per code (`'msh /US'`, `'msh\u0007'`, `'msh\u200B'`, `'msh/#'`, `'/msh'`, `'msh//US'`, `'msh/US/2'`, a 32-byte root and a 31-byte multi-byte root) → 400 `{success:false, code:'INVALID_MQTT_ROOT', reason}`, and `setMQTTConfig` is not called.
  - `''` and `'msh/US/FL'` → 200.
  - Cached root already invalid, same root resubmitted with `mapReportingEnabled` toggled → 200 (unrelated edit passes).
  - Changed to another invalid root → 400.
  - No cached config → validated.
  - The preset-fill error still takes precedence.
- **`adminRoutes` `setMQTTConfig`:** the same matrix for local and remote. For remote, seed `getRemoteNodeConfig`. Assert no admin packet is sent on a 400.
- **`mqttBrokerPresetRoutes.test.ts`:**
  - Create with `'msh/US/2'` or `'msh\u200B'` → 400.
  - `'msh/US/'` is still normalized to `msh/US`.
  - Updating the name of a preset whose stored root is invalid → 200.
- **`sourceRoutes`, `mqtt_broker`:**
  - Create with `rootTopic: 'msh/#'` → 400. With `''` → 400. Missing → 200.
  - PUT with an unchanged invalid `rootTopic` → 200.
- **Unit tests for `mqttRootGuard`:** the `prev`/`next` matrix and `NOT_STRING`.
- **`deviceRestoreService`:** a backup with an invalid root still calls `setMQTTConfig` and records a warning, not a failure.

## Open questions (recommended answer first)
1. **Policy?** Reject only on change, and treat an unknown previous value as changed. "Reject always" would block unrelated edits on nodes configured outside MeshMonitor.
2. **Validate on device or system restore?** No. Restore stays verbatim; log a warning and add an optional `warnings[]` to `RestoreResult`.
3. **Include the `mqtt_broker` `rootTopic` and presets, beyond the two routes the issue names?** Yes. Presets write into device roots, and a bad broker root silently breaks the prefix match. Same helper, same code.
4. **Reject an empty `mqtt_broker.rootTopic`?** Yes. Unset means `msh`; `''` gives the prefix `/`. Alternatively, normalize `''` to unset.
5. **Normalize (trim or strip a trailing `/`) on device saves instead of rejecting?** No. Reject with a clear reason. Keep the preset route's existing normalization for compatibility.
6. **Localize the server error in the UI?** Yes, through `ApiError` with `code` and `reason`, using the existing `mqtt_root_finder.validation.*` keys. Also disable Save when the root has changed and is invalid.

### Critical Files for Implementation
- /home/yeraze/Development/meshmonitor/src/utils/mqttRootTopic.ts
- /home/yeraze/Development/meshmonitor/src/server/routes/configRoutes.ts
- /home/yeraze/Development/meshmonitor/src/server/routes/adminRoutes.ts
- /home/yeraze/Development/meshmonitor/src/server/routes/mqttBrokerPresetRoutes.ts
- /home/yeraze/Development/meshmonitor/src/server/routes/sourceRoutes.ts
- /home/yeraze/Development/meshmonitor/src/server/services/deviceRestoreService.ts
- /home/yeraze/Development/meshmonitor/src/services/api.ts
