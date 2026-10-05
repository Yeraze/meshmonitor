/**
 * TAK module config on the wire (#5613): set_module_config encode, and the
 * get_module_config_response decode that the load path reads.
 *
 * The encode assertions read raw field numbers: ModuleConfig oneof `tak = 16`,
 * TAKConfig `team = 1`, `role = 2`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import protobuf from 'protobufjs';
import protobufService from './protobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';
import { CONFIG_TYPE_MAP, MODULE_FIELD_BY_ID } from './constants/configTypes.js';
import { isValidModuleConfigType } from './constants/moduleConfig.js';
import { normalizeTakConfig } from '../utils/takConfig.js';

const TAK_FIELD = 16;
const TEAM_FIELD = 1;
const ROLE_FIELD = 2;
const TAK_CONFIG_ADMIN_TYPE = 15;

const RED = 5;
const TEAM_LEAD = 2;

/** One level of protobuf wire format: field number -> value (bytes or varint). */
function wireFields(buf: Uint8Array): Map<number, Uint8Array | number> {
  const reader = protobuf.Reader.create(buf);
  const out = new Map<number, Uint8Array | number>();
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    out.set(tag >>> 3, (tag & 7) === 2 ? reader.bytes() : reader.uint32());
  }
  return out;
}

/** The raw ModuleConfig bytes inside an encoded set_module_config AdminMessage. */
function moduleConfigBytes(adminMessage: Uint8Array): Uint8Array {
  const id = getProtobufRoot()!.lookupType('meshtastic.AdminMessage').fields.setModuleConfig.id;
  const bytes = wireFields(adminMessage).get(id);
  expect(bytes, 'AdminMessage carries set_module_config').toBeInstanceOf(Uint8Array);
  return bytes as Uint8Array;
}

describe('TAK module config — registry and wire format', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('the registry maps tak to admin type 15 and the `tak` field', () => {
    expect(CONFIG_TYPE_MAP.tak).toEqual({ type: TAK_CONFIG_ADMIN_TYPE, isModule: true });
    expect(MODULE_FIELD_BY_ID.tak).toBe('tak');
    expect(isValidModuleConfigType('tak')).toBe(true);
  });

  it('the loaded protobufs agree with those numbers', () => {
    const root = getProtobufRoot()!;
    expect(root.lookupType('meshtastic.ModuleConfig').fields.tak.id).toBe(TAK_FIELD);
    const TAKConfig = root.lookupType('meshtastic.ModuleConfig.TAKConfig');
    expect(TAKConfig.fields.team.id).toBe(TEAM_FIELD);
    expect(TAKConfig.fields.role.id).toBe(ROLE_FIELD);
    expect(root.lookupEnum('meshtastic.AdminMessage.ModuleConfigType').values.TAK_CONFIG).toBe(TAK_CONFIG_ADMIN_TYPE);
  });

  it('encodes team and role under ModuleConfig field 16', () => {
    const encoded = protobufService.createSetModuleConfigMessageGeneric('tak', { team: RED, role: TEAM_LEAD });
    const moduleConfig = wireFields(moduleConfigBytes(encoded));

    expect([...moduleConfig.keys()]).toEqual([TAK_FIELD]);
    const tak = wireFields(moduleConfig.get(TAK_FIELD) as Uint8Array);
    expect(tak.get(TEAM_FIELD)).toBe(RED);
    expect(tak.get(ROLE_FIELD)).toBe(TEAM_LEAD);
  });

  it('an all-default config still names the tak variant, as an empty message', () => {
    // Setting both back to default must reach the node as "set tak to {}",
    // not as a ModuleConfig with no variant at all.
    const encoded = protobufService.createSetModuleConfigMessageGeneric('tak', { team: 0, role: 0 });
    const moduleConfig = wireFields(moduleConfigBytes(encoded));

    expect(moduleConfig.has(TAK_FIELD)).toBe(true);
    expect((moduleConfig.get(TAK_FIELD) as Uint8Array).length).toBe(0);
  });

  it('carries the session passkey for a remote node', () => {
    const passkey = new Uint8Array([1, 2, 3, 4]);
    const encoded = protobufService.createSetModuleConfigMessageGeneric('tak', { team: RED, role: TEAM_LEAD }, passkey);
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    const passkeyBytes = wireFields(encoded).get(AdminMessage.fields.sessionPasskey.id) as Uint8Array;
    expect(Buffer.from(passkeyBytes)).toEqual(Buffer.from(passkey));
  });

  it('round trip: what is encoded decodes back to the same team and role', () => {
    const root = getProtobufRoot()!;
    const encoded = protobufService.createSetModuleConfigMessageGeneric('tak', { team: RED, role: TEAM_LEAD });
    const decoded = root.lookupType('meshtastic.ModuleConfig').decode(moduleConfigBytes(encoded)) as unknown as {
      tak: { team: number; role: number };
    };
    expect(decoded.tak.team).toBe(RED);
    expect(decoded.tak.role).toBe(TEAM_LEAD);
  });

  describe('a node\'s get_module_config_response, through the real admin decoder', () => {
    function nodeAnswer(tak: Record<string, unknown>) {
      const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
      const bytes = AdminMessage.encode(AdminMessage.create({ getModuleConfigResponse: { tak } })).finish();
      return protobufService.decodeAdminMessage(bytes).getModuleConfigResponse;
    }

    it('reads team and role as numbers, not enum names', () => {
      const response = nodeAnswer({ team: RED, role: TEAM_LEAD });
      expect(normalizeTakConfig(response.tak)).toEqual({ team: RED, role: TEAM_LEAD });
      expect(typeof response.tak.team).toBe('number');
    });

    it('an all-default answer normalises to 0 / 0', () => {
      const response = nodeAnswer({});
      expect(normalizeTakConfig(response?.tak)).toEqual({ team: 0, role: 0 });
    });
  });

  it('protobuf.js toJSON writes enum NAMES — which normalizeTakConfig reads back', () => {
    // The local config is a decoded message that res.json() serialises through
    // toJSON; this is the shape the server must not hand to the UI.
    const ModuleConfig = getProtobufRoot()!.lookupType('meshtastic.ModuleConfig');
    const message = ModuleConfig.decode(
      ModuleConfig.encode(ModuleConfig.create({ tak: { team: RED, role: TEAM_LEAD } })).finish(),
    );
    const json = JSON.parse(JSON.stringify(message));
    expect(json.tak).toEqual({ team: 'Red', role: 'TeamLead' });
    expect(normalizeTakConfig(json.tak)).toEqual({ team: RED, role: TEAM_LEAD });
  });
});
