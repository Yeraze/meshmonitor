import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../services/database.js', () => ({
  default: {
    upsertNode: vi.fn(),
    insertMessage: vi.fn().mockReturnValue(true),
    insertTelemetry: vi.fn(),
  },
}));

import protobufService from './protobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

/**
 * Round-trip tests for the generic module-config encoder
 * (createSetModuleConfigMessageGeneric). protobufjs silently DROPS keys that
 * aren't fields of the looked-up type, so a field-name drift between the UI
 * payload and the proto would encode an empty/partial sub-message that the
 * firmware can't act on. These tests lock the field names by encoding an
 * AdminMessage and decoding it back to assert the values survive.
 *
 * Context: issue #3491 — Traffic Management saves were investigated for exactly
 * this failure mode. The encoding turned out correct (the real gap is firmware
 * support), and these tests prevent a future regression where it silently isn't.
 */
describe('createSetModuleConfigMessageGeneric round-trip', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  const decode = (encoded: Uint8Array) => {
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    return AdminMessage.toObject(AdminMessage.decode(encoded), {
      defaults: true,
      oneofs: true,
    }) as any;
  };

  it('encodes trafficmanagement with the correct payload variant and field names', () => {
    const encoded = protobufService.createSetModuleConfigMessageGeneric('trafficmanagement', {
      enabled: true,
      rateLimitEnabled: true,
      rateLimitMaxPackets: 5,
      routerPreserveHops: true,
    });
    const msg = decode(encoded);

    // ModuleConfig.payload_variant must be the trafficManagement oneof case,
    // not empty — an empty/omitted variant is the silent-failure we guard against.
    expect(msg.setModuleConfig.payloadVariant).toBe('trafficManagement');
    expect(msg.setModuleConfig.trafficManagement.enabled).toBe(true);
    expect(msg.setModuleConfig.trafficManagement.rateLimitEnabled).toBe(true);
    expect(msg.setModuleConfig.trafficManagement.rateLimitMaxPackets).toBe(5);
    expect(msg.setModuleConfig.trafficManagement.routerPreserveHops).toBe(true);
  });

  it('encodes statusmessage with the correct payload variant and field name', () => {
    const encoded = protobufService.createSetModuleConfigMessageGeneric('statusmessage', {
      nodeStatus: 'on duty',
    });
    const msg = decode(encoded);

    expect(msg.setModuleConfig.payloadVariant).toBe('statusmessage');
    expect(msg.setModuleConfig.statusmessage.nodeStatus).toBe('on duty');
  });

  it('encodes telemetry (a working module) for comparison', () => {
    const encoded = protobufService.createSetModuleConfigMessageGeneric('telemetry', {
      deviceUpdateInterval: 900,
    });
    const msg = decode(encoded);

    expect(msg.setModuleConfig.payloadVariant).toBe('telemetry');
    expect(msg.setModuleConfig.telemetry.deviceUpdateInterval).toBe(900);
  });

  it('throws on an unknown module type rather than encoding an empty message', () => {
    expect(() =>
      protobufService.createSetModuleConfigMessageGeneric('bogus', { enabled: true }),
    ).toThrow();
  });
});
