import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../services/database.js', () => ({
  default: {},
}));

import protobufService from './protobufService.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';
import { FemLnaMode } from './constants/meshtastic.js';

/**
 * Round-trip tests for Config.LoRaConfig.fem_lna_mode (FEM_LNA_Mode enum), surfaced
 * for issue #3599. protobufjs silently DROPS keys that aren't fields of the looked-up
 * type, so this locks the camelCase field name (`femLnaMode`) against the proto. Both
 * the Device Configuration save and the Remote Admin save funnel through
 * createSetLoRaConfigMessage, so this single round-trip covers both surfaces.
 *
 * It also guards the proto3 elision class (#3594): the zero enum value (DISABLED) is a
 * real selectable mode, so writing it must not be inflated to a non-zero default.
 */
describe('createSetLoRaConfigMessage femLnaMode round-trip', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  const decode = (encoded: Uint8Array) => {
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    return AdminMessage.toObject(AdminMessage.decode(encoded), {
      defaults: true,
      oneofs: true,
      enums: Number,
    }) as any;
  };

  it('encodes femLnaMode ENABLED and it survives the round-trip', () => {
    const encoded = protobufService.createSetLoRaConfigMessage({
      femLnaMode: FemLnaMode.ENABLED,
    });
    const msg = decode(encoded);

    expect(msg.setConfig.payloadVariant).toBe('lora');
    expect(msg.setConfig.lora.femLnaMode).toBe(FemLnaMode.ENABLED);
    expect(msg.setConfig.lora.femLnaMode).toBe(1);
  });

  it('encodes femLnaMode NOT_PRESENT and it survives the round-trip', () => {
    const encoded = protobufService.createSetLoRaConfigMessage({
      femLnaMode: FemLnaMode.NOT_PRESENT,
    });
    const msg = decode(encoded);

    expect(msg.setConfig.lora.femLnaMode).toBe(FemLnaMode.NOT_PRESENT);
    expect(msg.setConfig.lora.femLnaMode).toBe(2);
  });

  it('encodes femLnaMode DISABLED (proto3 zero) without inflating it to a non-zero value', () => {
    const encoded = protobufService.createSetLoRaConfigMessage({
      femLnaMode: FemLnaMode.DISABLED,
    });
    // decode WITHOUT defaults to confirm proto3 elision behaviour: the wire
    // representation of the zero value is absent, and decoding yields 0/undefined,
    // never a non-zero fallback.
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    const raw = AdminMessage.toObject(AdminMessage.decode(encoded)) as any;
    const decodedMode = raw.setConfig?.lora?.femLnaMode ?? 0;
    expect(decodedMode).toBe(FemLnaMode.DISABLED);
    expect(decodedMode).toBe(0);
  });

  it('encodes femLnaMode AUTO (3, firmware #12380) and it survives the round-trip', () => {
    const msg = decode(protobufService.createSetLoRaConfigMessage({ femLnaMode: FemLnaMode.AUTO }));
    expect(msg.setConfig.lora.femLnaMode).toBe(3);
  });

  it('passes an enum value newer than our schema through unchanged (#6452)', () => {
    const msg = decode(protobufService.createSetLoRaConfigMessage({ femLnaMode: 7 }));
    expect(msg.setConfig.lora.femLnaMode).toBe(7);
  });

  it('does not set femLnaMode when the field is absent from the config payload', () => {
    const encoded = protobufService.createSetLoRaConfigMessage({
      usePreset: true,
      modemPreset: 0,
    });
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    const raw = AdminMessage.toObject(AdminMessage.decode(encoded)) as any;
    // Absent in payload => elided on the wire (decodes to undefined / proto3 default 0).
    expect(raw.setConfig?.lora?.femLnaMode ?? 0).toBe(0);
  });
});

describe('incoming LoRa config keeps femLnaMode AUTO (3) as a number (#6452)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('parseIncomingData yields femLnaMode 3, not a name, undefined or 0', () => {
    const root = getProtobufRoot()!;
    const FromRadio = root.lookupType('meshtastic.FromRadio');
    const bytes = FromRadio.encode(FromRadio.create({ config: { lora: { femLnaMode: 3, region: 1 } } })).finish();
    const parsed = meshtasticProtobufService.parseIncomingData(bytes) as any;
    expect(parsed.type).toBe('config');
    expect(parsed.data.lora.femLnaMode).toBe(3);
  });
});
