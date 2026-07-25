/**
 * Meshtastic SharedContact URL encoding.
 *
 * Contact links use a base64url-encoded meshtastic.SharedContact protobuf:
 * https://meshtastic.org/v/#<payload>
 */
import type { DbNode } from '../../db/types.js';
import { getProtobufRoot } from '../protobufLoader.js';
import { isValidNodeNum, MAX_NODE_NUM } from '../constants/meshtastic.js';

export const CONTACT_URL_PREFIX = 'https://meshtastic.org/v/#';

export interface SharedContactIdentity {
  nodeNum: number;
  nodeId: string;
  longName?: string | null;
  shortName?: string | null;
  macaddr?: string | null;
  hwModel?: number | null;
  role?: number | null;
  publicKey?: string | null;
  isLicensed?: boolean | null;
  isUnmessagable?: boolean | null;
}

export class SharedContactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SharedContactValidationError';
  }
}

interface SharedContactPayloadOptions {
  validatePublicKeyLength?: boolean;
  /**
   * Contact URLs must use an internally consistent identity. The legacy
   * AdminMessage.add_contact path opts out to preserve its pre-existing
   * pass-through behavior for radio NodeDB repair.
   */
  validateIdentity?: boolean;
}

function decodeHexBytes(value: string, fieldName: string, expectedLength: number): Buffer {
  const normalized = value.replace(/[:-]/g, '');
  if (!new RegExp(`^[0-9a-fA-F]{${expectedLength * 2}}$`).test(normalized)) {
    throw new SharedContactValidationError(
      `${fieldName} must contain exactly ${expectedLength} bytes`,
    );
  }
  return Buffer.from(normalized, 'hex');
}

function decodeBase64Bytes(value: string, fieldName: string, expectedLength?: number): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new SharedContactValidationError(`${fieldName} is not valid base64`);
  }

  const bytes = Buffer.from(normalized, 'base64');
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new SharedContactValidationError(
      `${fieldName} must contain exactly ${expectedLength} bytes`,
    );
  }
  return bytes;
}

/**
 * Build the wire-shape shared by contact URLs and AdminMessage.add_contact.
 * Optional User fields are omitted instead of inventing values.
 */
export function buildSharedContactPayload(
  identity: SharedContactIdentity,
  options: SharedContactPayloadOptions = {},
) {
  const expectedNodeId = `!${identity.nodeNum.toString(16).padStart(8, '0')}`;
  if (options.validateIdentity !== false) {
    if (
      !isValidNodeNum(identity.nodeNum)
      || identity.nodeNum === 0
      || identity.nodeNum === MAX_NODE_NUM
    ) {
      throw new SharedContactValidationError('nodeNum must identify a real Meshtastic node');
    }

    if (identity.nodeId.toLowerCase() !== expectedNodeId) {
      throw new SharedContactValidationError(
        `nodeId ${identity.nodeId} does not match nodeNum ${identity.nodeNum}`,
      );
    }
  }

  const user: Record<string, unknown> = {
    id: options.validateIdentity === false ? identity.nodeId : expectedNodeId,
  };

  if (identity.longName != null) user.longName = identity.longName;
  if (identity.shortName != null) user.shortName = identity.shortName;
  if (identity.macaddr) user.macaddr = decodeHexBytes(identity.macaddr, 'macaddr', 6);
  if (identity.hwModel != null) user.hwModel = identity.hwModel;
  if (identity.isLicensed != null) user.isLicensed = Boolean(identity.isLicensed);
  if (identity.role != null) user.role = identity.role;
  if (identity.publicKey) {
    user.publicKey = decodeBase64Bytes(
      identity.publicKey,
      'publicKey',
      options.validatePublicKeyLength === false ? undefined : 32,
    );
  }
  if (identity.isUnmessagable != null) {
    user.isUnmessagable = Boolean(identity.isUnmessagable);
  }

  return {
    nodeNum: identity.nodeNum,
    user,
    shouldIgnore: false,
    manuallyVerified: false,
  };
}

export function encodeSharedContactUrl(node: DbNode): string {
  const root = getProtobufRoot();
  if (!root) {
    throw new Error('Protobuf definitions are not loaded');
  }

  const SharedContact = root.lookupType('meshtastic.SharedContact');
  const payload = buildSharedContactPayload(node);
  const bytes = SharedContact.encode(SharedContact.create(payload)).finish();
  const encoded = Buffer.from(bytes).toString('base64url');
  return `${CONTACT_URL_PREFIX}${encoded}`;
}
