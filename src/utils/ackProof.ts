/**
 * Meshtastic ack proof (#5279): `MeshPacket.AckProofStatus` values and a
 * tolerant reader for the decoded packet field.
 *
 * Firmware 2.8.1+ reports `MeshPacket.ack_proof_status` (field 23) on the
 * phone-bound copy of the ack or nak that settles a unicast this node sent.
 * MeshMonitor never computes or checks the proof itself; it records the
 * verdict the radio gives. Always stored and compared as the enum NUMBER —
 * protobufjs `toJSON` emits enum NAMES, so a name is mapped back here and
 * never persisted.
 *
 * Shared by the server (capture) and the frontend (Delivery Details, Packet
 * Monitor), so it stays framework-free.
 */

export const AckProofStatus = {
  /** No verdict: no proof, a relay's ack, or the packet was already settled. Not a failure. */
  ABSENT: 0,
  /** Proof verified against the addressed node's key: the recipient received it. */
  VALID: 1,
  /** A proof was carried and failed: this ack may be forged. */
  INVALID: 2,
  /** A proof was carried but the radio has no key to check it. Not a failure. */
  NO_KEY: 3,
} as const;

export type AckProofStatusValue = (typeof AckProofStatus)[keyof typeof AckProofStatus];

const NAME_TO_VALUE: Record<string, AckProofStatusValue> = {
  ACK_PROOF_ABSENT: AckProofStatus.ABSENT,
  ACK_PROOF_VALID: AckProofStatus.VALID,
  ACK_PROOF_INVALID: AckProofStatus.INVALID,
  ACK_PROOF_NO_KEY: AckProofStatus.NO_KEY,
};

/** True when `v` is one of the known AckProofStatus numbers. */
export function isAckProofStatus(v: unknown): v is AckProofStatusValue {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

/**
 * Normalise a raw `ackProofStatus` value (number, numeric string, or enum
 * name) to its number. Anything absent or unrecognised returns `undefined`,
 * which callers must treat as "no status reported" and store as NULL.
 */
export function normalizeAckProofStatus(raw: unknown): AckProofStatusValue | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'number') return isAckProofStatus(raw) ? raw : undefined;
  if (typeof raw === 'string') {
    if (raw in NAME_TO_VALUE) return NAME_TO_VALUE[raw];
    const n = Number(raw);
    return raw.trim() !== '' && isAckProofStatus(n) ? n : undefined;
  }
  return undefined;
}

const VALUE_TO_NAME: Record<AckProofStatusValue, string> = {
  0: 'ACK_PROOF_ABSENT',
  1: 'ACK_PROOF_VALID',
  2: 'ACK_PROOF_INVALID',
  3: 'ACK_PROOF_NO_KEY',
};

/**
 * Display-only label for a raw status, e.g. `ACK_PROOF_VALID (1)`. Returns
 * null when the value is not a known status. Never persist this string.
 */
export function formatAckProofStatus(raw: unknown): string | null {
  const v = normalizeAckProofStatus(raw);
  return v === undefined ? null : `${VALUE_TO_NAME[v]} (${v})`;
}

/**
 * Read the ack proof verdict off a decoded MeshPacket (camelCase protobufjs
 * instance or a snake_case plain object).
 *
 * Note: `ack_proof_status` is a plain proto3 enum, so ABSENT (0) is never
 * encoded on the wire. A decoded instance reads it as null/undefined, the
 * same as firmware that predates the field — so ABSENT normally reads as
 * `undefined` (NULL, row hidden) rather than 0. Only a present, recognised
 * value is returned.
 */
export function readAckProofStatus(meshPacket: unknown): AckProofStatusValue | undefined {
  if (!meshPacket || typeof meshPacket !== 'object') return undefined;
  const p = meshPacket as Record<string, unknown>;
  return normalizeAckProofStatus(p.ackProofStatus ?? p.ack_proof_status);
}
