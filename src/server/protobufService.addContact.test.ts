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
    const encoded = protobufService.createAddContactMessage({
      nodeNum: 0xaabbccdd,
      nodeId: '!aabbccdd',
      longName: 'Test Node',
      shortName: 'TN',
      publicKey: 'AQIDBAUGCAY=', // base64 of [1,2,3,4,5,6,8,6]
    });

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
    const encoded = protobufService.createAddContactMessage({
      nodeNum: 0x12345678,
      nodeId: '!12345678',
      longName: 'HW Node',
      shortName: 'HW',
      publicKey: 'AQID',
      hwModel: 43, // TBEAM
    });

    const root = getProtobufRoot()!;
    const AdminMessage = root.lookupType('meshtastic.AdminMessage');
    const decoded = AdminMessage.decode(encoded) as any;

    expect(decoded.addContact.user.hwModel).toBe(43);
  });

  it('omits hwModel when not provided', () => {
    const encoded = protobufService.createAddContactMessage({
      nodeNum: 0x12345678,
      nodeId: '!12345678',
      longName: 'No HW',
      shortName: 'NH',
      publicKey: 'AQID',
    });

    const root = getProtobufRoot()!;
    const AdminMessage = root.lookupType('meshtastic.AdminMessage');
    const decoded = AdminMessage.decode(encoded) as any;

    expect(decoded.addContact.user.hwModel).toBeFalsy();
  });

  it('attaches sessionPasskey on the AdminMessage when provided (#6153)', () => {
    const passkey = new Uint8Array([10, 20, 30, 40]);
    const encoded = protobufService.createAddContactMessage(
      { nodeNum: 0x12345678, nodeId: '!12345678', longName: 'PK Node', shortName: 'PK', publicKey: 'AQID' },
      passkey,
    );

    const root = getProtobufRoot()!;
    const AdminMessage = root.lookupType('meshtastic.AdminMessage');
    const decoded = AdminMessage.decode(encoded) as any;

    expect(decoded.addContact).toBeTruthy();
    expect(Buffer.from(decoded.sessionPasskey).toString('base64')).toBe(Buffer.from(passkey).toString('base64'));
  });

  it('omits sessionPasskey when empty or not provided (#6153)', () => {
    const root = getProtobufRoot()!;
    const AdminMessage = root.lookupType('meshtastic.AdminMessage');

    const contact = { nodeNum: 0x12345678, nodeId: '!12345678', longName: 'N', shortName: 'N', publicKey: 'AQID' };
    const encodedNone = protobufService.createAddContactMessage(contact);
    const decodedNone = AdminMessage.decode(encodedNone) as any;
    expect(decodedNone.sessionPasskey == null || decodedNone.sessionPasskey.length === 0).toBe(true);

    const encodedEmpty = protobufService.createAddContactMessage(contact, new Uint8Array());
    const decodedEmpty = AdminMessage.decode(encodedEmpty) as any;
    expect(decodedEmpty.sessionPasskey == null || decodedEmpty.sessionPasskey.length === 0).toBe(true);
  });

  it('preserves the legacy pass-through behavior for inconsistent identities', () => {
    const encoded = protobufService.createAddContactMessage({
      nodeNum: 0,
      nodeId: '!legacy-id',
      longName: 'Legacy Node',
      shortName: 'LN',
      publicKey: 'AQID',
    });

    const root = getProtobufRoot()!;
    const AdminMessage = root.lookupType('meshtastic.AdminMessage');
    const decoded = AdminMessage.decode(encoded) as any;

    expect(decoded.addContact.nodeNum).toBe(0);
    expect(decoded.addContact.user.id).toBe('!legacy-id');
  });
  // Firmware addFromContact replaces the stored user record, so a role left
  // out is stored as CLIENT and a favorite router loses zero-hop.
  it('carries role, isLicensed and isUnmessagable', () => {
    const encoded = protobufService.createAddContactMessage({
      nodeNum: 0x12345678,
      nodeId: '!12345678',
      longName: 'Roof',
      shortName: 'RF',
      publicKey: 'AQID',
      role: 2, // ROUTER
      isLicensed: true,
      isUnmessagable: true,
    });

    const root = getProtobufRoot()!;
    const AdminMessage = root.lookupType('meshtastic.AdminMessage');
    const decoded = AdminMessage.decode(encoded) as any;

    expect(decoded.addContact.user.role).toBe(2);
    expect(decoded.addContact.user.isLicensed).toBe(true);
    expect(decoded.addContact.user.isUnmessagable).toBe(true);
  });

  it('accepts a whole node row and leaves out macaddr', () => {
    const node = {
      nodeNum: 0x12345678,
      nodeId: '!12345678',
      longName: 'Row',
      shortName: 'RW',
      publicKey: 'AQID',
      role: 11, // ROUTER_LATE
      macaddr: 'not-a-mac',
      lastHeard: 1700000000,
    };
    const encoded = protobufService.createAddContactMessage(node);

    const root = getProtobufRoot()!;
    const AdminMessage = root.lookupType('meshtastic.AdminMessage');
    const decoded = AdminMessage.decode(encoded) as any;

    expect(decoded.addContact.user.role).toBe(11);
    expect(decoded.addContact.user.macaddr?.length ?? 0).toBe(0);
  });
});
