/**
 * Module config types accepted by the generic module-config save route
 * (`POST /api/config/module/:moduleType`).
 *
 * These are the lowercase, separator-free identifiers the UI sends. Every entry
 * here MUST have a matching field in `protobufService.createSetModuleConfigMessageGeneric`'s
 * `configFieldMap` (which translates the id to the protobuf `ModuleConfig` field),
 * otherwise the save 400s with "Invalid module type" even though the encoder
 * supports it.
 *
 * `statusmessage` and `trafficmanagement` were made editable in #3457 (gated on
 * firmware version) but were missing from this allow-list, so saving them failed
 * with "Invalid module type" — see #3464.
 *
 * Note: `telemetry` and `neighborinfo` are intentionally absent — they have their
 * own dedicated config routes rather than going through the generic endpoint.
 */
export const VALID_MODULE_CONFIG_TYPES = [
  'extnotif',
  'storeforward',
  'rangetest',
  'cannedmsg',
  'audio',
  'remotehardware',
  'detectionsensor',
  'paxcounter',
  'serial',
  'ambientlighting',
  'statusmessage',
  'trafficmanagement',
] as const;

export type ModuleConfigType = (typeof VALID_MODULE_CONFIG_TYPES)[number];

export function isValidModuleConfigType(moduleType: string): moduleType is ModuleConfigType {
  return (VALID_MODULE_CONFIG_TYPES as readonly string[]).includes(moduleType);
}
