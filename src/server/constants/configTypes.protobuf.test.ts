/**
 * The config registry against the real protobuf definitions.
 *
 * `processAdminMessage` stores a config reply under the decoded oneof name of
 * `Config` / `ModuleConfig`, and `remoteAdminService` reads it back by the
 * registry's `field`. If the two disagree for a type, a remote load of that
 * type is stored, never matched, and times out — which is how remote `tak` and
 * `meshBeacon` loads failed while an inline map lagged behind the registry.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type protobuf from 'protobufjs';
import { loadProtobufDefinitions } from '../protobufLoader.js';
import { CONFIG_TYPES, DEVICE_FIELD_BY_ADMIN_TYPE, MODULE_FIELD_BY_ADMIN_TYPE } from './configTypes.js';

/**
 * Registry entries whose `field` is not the decoded oneof name. `deviceui`
 * decodes as `deviceUi`; the registry spelling predates this test and is also
 * used on the local path, so it is recorded here, not changed. A remote load of
 * `deviceui` therefore still cannot match. Nothing in the UI asks for it.
 */
const KNOWN_FIELD_MISMATCHES = new Set(['deviceui']);

let root: protobuf.Root;
beforeAll(async () => {
  root = await loadProtobufDefinitions();
});

const oneofNames = (typeName: string) => root.lookupType(typeName).oneofs.payloadVariant.oneof;
const enumValues = (enumName: string) => Object.values(root.lookupEnum(enumName).values);

describe('config registry vs protobufs', () => {
  it('names every module field as the ModuleConfig oneof decodes it', () => {
    const names = oneofNames('meshtastic.ModuleConfig');
    for (const entry of CONFIG_TYPES.filter((e) => e.kind === 'module')) {
      expect(names, `module '${entry.id}' field '${entry.field}'`).toContain(entry.field);
    }
  });

  it('names every device field as the Config oneof decodes it', () => {
    const names = oneofNames('meshtastic.Config');
    for (const entry of CONFIG_TYPES.filter((e) => e.kind === 'device')) {
      if (KNOWN_FIELD_MISMATCHES.has(entry.id)) {
        expect(names, `'${entry.id}' is listed as a known mismatch but now matches`).not.toContain(entry.field);
        continue;
      }
      expect(names, `device '${entry.id}' field '${entry.field}'`).toContain(entry.field);
    }
  });

  it('has a field for every AdminMessage.ModuleConfigType', () => {
    for (const type of enumValues('meshtastic.AdminMessage.ModuleConfigType')) {
      expect(MODULE_FIELD_BY_ADMIN_TYPE[type], `ModuleConfigType ${type}`).toBeTypeOf('string');
    }
  });

  it('has a field for every AdminMessage.ConfigType', () => {
    for (const type of enumValues('meshtastic.AdminMessage.ConfigType')) {
      expect(DEVICE_FIELD_BY_ADMIN_TYPE[type], `ConfigType ${type}`).toBeTypeOf('string');
    }
  });

  it('pairs each ModuleConfigType with the oneof field of the same module', () => {
    // MQTT_CONFIG → mqtt, MESHBEACON_CONFIG → meshBeacon, …: the enum name and
    // the field name agree once case and separators are dropped.
    const byValue = root.lookupEnum('meshtastic.AdminMessage.ModuleConfigType').valuesById;
    const squash = (text: string) => text.replace(/_CONFIG$/, '').replace(/[^a-z]/gi, '').toLowerCase();
    const aliases: Record<string, string> = { extnotif: 'externalnotification', cannedmsg: 'cannedmessage' };
    for (const [value, name] of Object.entries(byValue)) {
      const expected = aliases[squash(name)] ?? squash(name);
      expect(squash(MODULE_FIELD_BY_ADMIN_TYPE[Number(value)]), `${name}`).toBe(expected);
    }
  });
});
