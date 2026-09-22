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

/**
 * Decode a Meshtastic contact URL into the identity it carries (#5317) — the
 * mirror of {@link encodeSharedContactUrl}, and the reason a node can be
 * messaged before it has ever been heard on the mesh.
 *
 * Accepts the `https://meshtastic.org/v/#<payload>` form and a bare payload,
 * since a user pasting from a phone often loses the prefix. `base64url`
 * decoding is lenient about padding, which real links omit.
 *
 * Throws {@link SharedContactValidationError} for anything that is not a
 * decodable contact carrying a usable nodeNum — the caller turns that into a
 * 400 rather than writing a junk row.
 */
export function decodeSharedContactUrl(url: string): SharedContactIdentity {
  const root = getProtobufRoot();
  if (!root) {
    throw new Error('Protobuf definitions are not loaded');
  }

  const trimmed = (url ?? '').trim();
  if (!trimmed) {
    throw new SharedContactValidationError('Contact URL is empty');
  }

  // Everything after the first '#', or the whole string when there is none.
  const hashIndex = trimmed.indexOf('#');
  const payload = (hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : trimmed).trim();
  if (!payload) {
    throw new SharedContactValidationError('Contact URL carries no payload');
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(payload)) {
    throw new SharedContactValidationError('Contact URL payload is not valid base64url');
  }

  const SharedContact = root.lookupType('meshtastic.SharedContact');
  let decoded: Record<string, unknown>;
  try {
    const bytes = Buffer.from(payload, 'base64url');
    decoded = SharedContact.decode(bytes) as unknown as Record<string, unknown>;
  } catch {
    throw new SharedContactValidationError('Contact URL is not a valid Meshtastic contact');
  }

  const nodeNum = Number(decoded.nodeNum ?? 0);
  if (!isValidNodeNum(nodeNum) || nodeNum === 0 || nodeNum === MAX_NODE_NUM) {
    throw new SharedContactValidationError('Contact URL does not identify a real Meshtastic node');
  }

  // protobufjs leaves unset scalars absent rather than zero-valued, so read
  // defensively and keep "absent" as null rather than inventing a value.
  const user = (decoded.user ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const bool = (value: unknown): boolean | null =>
    typeof value === 'boolean' ? value : null;

  const publicKey = user.publicKey instanceof Uint8Array && user.publicKey.length > 0
    ? Buffer.from(user.publicKey).toString('base64')
    : null;
  const macaddr = user.macaddr instanceof Uint8Array && user.macaddr.length === 6
    ? Buffer.from(user.macaddr).toString('hex')
    : null;

  return {
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: text(user.longName),
    shortName: text(user.shortName),
    macaddr,
    hwModel: num(user.hwModel),
    role: num(user.role),
    publicKey,
    isLicensed: bool(user.isLicensed),
    isUnmessagable: bool(user.isUnmessagable),
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
