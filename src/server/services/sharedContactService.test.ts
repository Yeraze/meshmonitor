import { beforeAll, describe, expect, it } from 'vitest';
import type { DbNode } from '../../db/types.js';
import { getProtobufRoot, loadProtobufDefinitions } from '../protobufLoader.js';
import {
  CONTACT_URL_PREFIX,
  encodeSharedContactUrl,
  SharedContactValidationError,
} from './sharedContactService.js';

const WAM8_URL =
  'https://meshtastic.org/v/#CPXr_8UEElgKCSE0OGJmZjVmNRIVUi1TRUQtQkzDhUtBTVBFTi1XQU04GgRXQU04IgbB30i_9fUoCTgCQiA1BZ7pj0ZZzX7VjTUKPMB-j6QbrWAoWS6J0ksAArgJQ0gB';

function node(overrides: Partial<DbNode> = {}): DbNode {
  return {
    nodeNum: 0x48bff5f5,
    nodeId: '!48bff5f5',
    longName: 'R-SED-BLÅKAMPEN-WAM8',
    shortName: 'WAM8',
    macaddr: 'c1df48bff5f5',
    hwModel: 9,
    role: 2,
    publicKey: 'NQWe6Y9GWc1+1Y01CjzAfo+kG61gKFkuidJLAAK4CUM=',
    isLicensed: false,
    isUnmessagable: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function decodeContact(url: string) {
  const encoded = url.slice(CONTACT_URL_PREFIX.length);
  const bytes = Buffer.from(encoded, 'base64url');
  const SharedContact = getProtobufRoot()!.lookupType('meshtastic.SharedContact');
  return SharedContact.decode(bytes) as any;
}

describe('sharedContactService', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('reproduces the known-good unmessagable WAM8 contact URL', () => {
    expect(encodeSharedContactUrl(node())).toBe(WAM8_URL);
  });

  it('encodes the complete available User with contact-safe flags', () => {
    const url = encodeSharedContactUrl(node());
    const encoded = url.slice(CONTACT_URL_PREFIX.length);
    const decoded = decodeContact(url);

    expect(url.startsWith(CONTACT_URL_PREFIX)).toBe(true);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('=');
    expect(decoded.nodeNum).toBe(0x48bff5f5);
    expect(decoded.user.id).toBe('!48bff5f5');
    expect(decoded.user.longName).toBe('R-SED-BLÅKAMPEN-WAM8');
    expect(decoded.user.shortName).toBe('WAM8');
    expect(Buffer.from(decoded.user.macaddr).toString('hex')).toBe('c1df48bff5f5');
    expect(decoded.user.hwModel).toBe(9);
    expect(decoded.user.role).toBe(2);
    expect(decoded.user.isLicensed).toBe(false);
    expect(Buffer.from(decoded.user.publicKey).toString('base64')).toBe(
      'NQWe6Y9GWc1+1Y01CjzAfo+kG61gKFkuidJLAAK4CUM=',
    );
    expect(decoded.user.isUnmessagable).toBe(true);
    expect(decoded.shouldIgnore).toBe(false);
    expect(decoded.manuallyVerified).toBe(false);
  });

  it('allows sparse contacts without optional byte fields', () => {
    const decoded = decodeContact(encodeSharedContactUrl(node({
      longName: null,
      shortName: null,
      macaddr: null,
      hwModel: null,
      role: null,
      publicKey: null,
      isLicensed: null,
      isUnmessagable: null,
    })));

    expect(decoded.nodeNum).toBe(0x48bff5f5);
    expect(decoded.user.id).toBe('!48bff5f5');
    expect(decoded.user.publicKey).toHaveLength(0);
  });

  it.each([
    [{ nodeNum: 0 }, 'nodeNum must identify a real Meshtastic node'],
    [
      { nodeNum: 0xFFFFFFFF, nodeId: '!ffffffff' },
      'nodeNum must identify a real Meshtastic node',
    ],
    [{ nodeId: '!00000001' }, 'does not match nodeNum'],
    [{ macaddr: 'not-a-mac' }, 'macaddr must contain exactly 6 bytes'],
    [{ publicKey: 'AQID' }, 'publicKey must contain exactly 32 bytes'],
  ] satisfies Array<[Partial<DbNode>, string]>)(
    'rejects inconsistent or malformed identity data: %j',
    (overrides, message) => {
      expect(() => encodeSharedContactUrl(node(overrides))).toThrowError(
        new RegExp(message),
      );
    },
  );

  it('uses a dedicated validation error type', () => {
    expect(() => encodeSharedContactUrl(node({ nodeId: '!00000001' })))
      .toThrow(SharedContactValidationError);
  });
});
