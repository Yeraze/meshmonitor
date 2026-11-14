import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../services/database.js', () => ({
  default: {},
}));

import protobufService from './protobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

/**
 * #6181: set_config replaces the whole LoRaConfig, so createSetLoRaConfigMessage
 * must carry transparent_mode (tag 108) or every LoRa save turns it off.
 * protobufjs drops unknown keys, so this locks the camelCase name too.
 */
describe('createSetLoRaConfigMessage transparentMode', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  const decodeLora = (encoded: Uint8Array) => {
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    return (AdminMessage.toObject(AdminMessage.decode(encoded), { defaults: true }) as any).setConfig.lora;
  };

  it('encodes transparentMode true', () => {
    expect(decodeLora(protobufService.createSetLoRaConfigMessage({ region: 1, transparentMode: true })).transparentMode).toBe(true);
  });

  it('encodes transparentMode false and leaves it false when absent', () => {
    expect(decodeLora(protobufService.createSetLoRaConfigMessage({ region: 1, transparentMode: false })).transparentMode).toBe(false);
    expect(decodeLora(protobufService.createSetLoRaConfigMessage({ region: 1 })).transparentMode).toBe(false);
  });
});
