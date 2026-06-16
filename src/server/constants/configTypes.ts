/**
 * Canonical registry of Meshtastic device-config and module-config types.
 *
 * Before this existed, the same facts (the numeric AdminMessage config/module
 * type enum, and the snake_case-id → camelCase-protobuf-field mapping) were
 * copy-pasted across `server.ts` (multiple times), `protobufService.ts`, and
 * `services/api.ts`. They drifted — issue #3464 (a module saveable by the
 * encoder but rejected by a stale route allow-list) was a direct symptom of
 * that drift. Everything derives from `CONFIG_TYPES` here so adding a new
 * config/module type is a single edit.
 *
 * `adminType` is the numeric enum value the device expects:
 *   - kind 'device'  → AdminMessage.ConfigType        (device / position / … )
 *   - kind 'module'  → AdminMessage.ModuleConfigType  (mqtt / serial / … )
 * The two enums share small integers, so `kind` is what disambiguates them.
 *
 * `field` is the camelCase key under the decoded `deviceConfig{}` / `moduleConfig{}`
 * object, which is also the protobuf field name used when encoding a set message.
 *
 * NOTE: which module types are *editable via the generic save route*
 * (`POST /api/config/module/:type`) is a separate concern owned by
 * `VALID_MODULE_CONFIG_TYPES` in ./moduleConfig — a `configTypes.test.ts`
 * asserts those stay consistent with this registry so they can't drift again.
 */

export interface ConfigTypeEntry {
  /** Lowercase, separator-free identifier used in routes/UI (e.g. 'trafficmanagement'). */
  id: string;
  kind: 'device' | 'module';
  /** Numeric AdminMessage ConfigType (device) / ModuleConfigType (module) enum value. */
  adminType: number;
  /** camelCase key in deviceConfig{}/moduleConfig{} and protobuf encode field. */
  field: string;
}

export const CONFIG_TYPES: readonly ConfigTypeEntry[] = [
  // Device configs — AdminMessage.ConfigType
  { id: 'device', kind: 'device', adminType: 0, field: 'device' },
  { id: 'position', kind: 'device', adminType: 1, field: 'position' },
  { id: 'power', kind: 'device', adminType: 2, field: 'power' },
  { id: 'network', kind: 'device', adminType: 3, field: 'network' },
  { id: 'display', kind: 'device', adminType: 4, field: 'display' },
  { id: 'lora', kind: 'device', adminType: 5, field: 'lora' },
  { id: 'bluetooth', kind: 'device', adminType: 6, field: 'bluetooth' },
  { id: 'security', kind: 'device', adminType: 7, field: 'security' },
  { id: 'sessionkey', kind: 'device', adminType: 8, field: 'sessionkey' },
  { id: 'deviceui', kind: 'device', adminType: 9, field: 'deviceui' },
  // Module configs — AdminMessage.ModuleConfigType
  { id: 'mqtt', kind: 'module', adminType: 0, field: 'mqtt' },
  { id: 'serial', kind: 'module', adminType: 1, field: 'serial' },
  { id: 'extnotif', kind: 'module', adminType: 2, field: 'externalNotification' },
  { id: 'storeforward', kind: 'module', adminType: 3, field: 'storeForward' },
  { id: 'rangetest', kind: 'module', adminType: 4, field: 'rangeTest' },
  { id: 'telemetry', kind: 'module', adminType: 5, field: 'telemetry' },
  { id: 'cannedmsg', kind: 'module', adminType: 6, field: 'cannedMessage' },
  { id: 'audio', kind: 'module', adminType: 7, field: 'audio' },
  { id: 'remotehardware', kind: 'module', adminType: 8, field: 'remoteHardware' },
  { id: 'neighborinfo', kind: 'module', adminType: 9, field: 'neighborInfo' },
  { id: 'ambientlighting', kind: 'module', adminType: 10, field: 'ambientLighting' },
  { id: 'detectionsensor', kind: 'module', adminType: 11, field: 'detectionSensor' },
  { id: 'paxcounter', kind: 'module', adminType: 12, field: 'paxcounter' },
  { id: 'statusmessage', kind: 'module', adminType: 13, field: 'statusmessage' },
  { id: 'trafficmanagement', kind: 'module', adminType: 14, field: 'trafficManagement' },
];

/** id → { type: numeric adminType, isModule }. Covers both device and module types. */
export const CONFIG_TYPE_MAP: Record<string, { type: number; isModule: boolean }> =
  Object.fromEntries(CONFIG_TYPES.map((e) => [e.id, { type: e.adminType, isModule: e.kind === 'module' }]));

/** module id → camelCase moduleConfig field (e.g. 'extnotif' → 'externalNotification'). */
export const MODULE_FIELD_BY_ID: Record<string, string> =
  Object.fromEntries(CONFIG_TYPES.filter((e) => e.kind === 'module').map((e) => [e.id, e.field]));

/** device id → camelCase deviceConfig field. */
export const DEVICE_FIELD_BY_ID: Record<string, string> =
  Object.fromEntries(CONFIG_TYPES.filter((e) => e.kind === 'device').map((e) => [e.id, e.field]));
