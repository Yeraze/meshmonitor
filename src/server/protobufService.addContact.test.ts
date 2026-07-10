import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../services/database.js', () => ({
  default: {},
}));

import protobufService from './protobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

describe('createAddContactMessage', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('creates a valid AdminMessage with addContact payload', () => {
    const encoded = protobufService.createAddContactMessage(
      0xaabbccdd,
      '!aabbccdd',
      'Test Node',
      'TN',
      'AQIDBAUGCAY=', // base64 of [1,2,3,4,5,6,8,6]
    );

    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const root = getProtobufRoot()!;
    const AdminMessage = root.lookupType('meshtastic.AdminMessage');
    const decoded = AdminMessage.decode(encoded) as any;

    expect(decoded.addContact).toBeTruthy();
    expect(decoded.addContact.nodeNum).toBe(0xaabbccdd);
    expect(decoded.addContact.manuallyVerified).toBe(false);
    expect(decoded.addContact.user).toBeTruthy();
    expect(decoded.addContact.user.id).toBe('!aabbccdd');
    expect(decoded.addContact.user.longName).toBe('Test Node');
    expect(decoded.addContact.user.shortName).toBe('TN');
    expect(Buffer.from(decoded.addContact.user.publicKey).toString('base64')).toBe('AQIDBAUGCAY=');
  });

  it('includes hwModel when provided', () => {
    const encoded = protobufService.createAddContactMessage(
      0x12345678,
      '!12345678',
      'HW Node',
      'HW',
      'AQID',
      43, // TBEAM
    );

    const root = getProtobufRoot()!;
    const AdminMessage = root.lookupType('meshtastic.AdminMessage');
    const decoded = AdminMessage.decode(encoded) as any;

    expect(decoded.addContact.user.hwModel).toBe(43);
  });

  it('omits hwModel when not provided', () => {
    const encoded = protobufService.createAddContactMessage(
      0x12345678,
      '!12345678',
      'No HW',
      'NH',
      'AQID',
    );

    const root = getProtobufRoot()!;
    const AdminMessage = root.lookupType('meshtastic.AdminMessage');
    const decoded = AdminMessage.decode(encoded) as any;

    expect(decoded.addContact.user.hwModel).toBeFalsy();
  });
});
