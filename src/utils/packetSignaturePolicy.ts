/**
 * `Config.SecurityConfig.PacketSignaturePolicy` (field 9, firmware 2.8.0+).
 *
 * BROWSER-SAFE: the server and the UI both read this file, so it must not
 * import a Node-only module. `src/server/constants/meshtastic.ts` re-exports
 * it for server code.
 *
 * What each value does on receive (firmware `Router.cpp`,
 * `checkXeddsaReceivePolicy`):
 *
 *   - COMPATIBLE: an unsigned packet passes. A signature that can be checked
 *     and is wrong still drops the packet.
 *   - BALANCED: as COMPATIBLE, except an unsigned broadcast from a node that
 *     has signed before is dropped (when its signed form would have fit).
 *   - STRICT: every packet that is neither signed-and-verified nor PKI
 *     encrypted is dropped. Firmware signs broadcasts only, so that covers all
 *     traffic from pre-2.8 nodes except PKI DMs, and from 2.8 nodes the channel
 *     unicasts (traceroute replies, ACKs, legacy admin channel) and broadcasts
 *     too large to sign.
 *
 * A build without PKI or XEdDSA forces COMPATIBLE on a set
 * (`AdminModule::handleSetConfig`), and a security set reboots the node.
 */
import { isFirmwareAtLeast } from './firmwareVersion.js';

export const PacketSignaturePolicy = {
  COMPATIBLE: 0,
  BALANCED: 1,
  STRICT: 2,
} as const;

export type PacketSignaturePolicyValue = (typeof PacketSignaturePolicy)[keyof typeof PacketSignaturePolicy];

/** Every policy, in the order the picker lists them. */
export const PACKET_SIGNATURE_POLICIES: readonly PacketSignaturePolicyValue[] = [
  PacketSignaturePolicy.COMPATIBLE,
  PacketSignaturePolicy.BALANCED,
  PacketSignaturePolicy.STRICT,
];

/** First firmware with the field (`since_firmware: "2.8.0"` in config.proto). */
export const PACKET_SIGNATURE_POLICY_MIN_FIRMWARE = { major: 2, minor: 8, patch: 0 } as const;

/** Display form of that version. */
export const PACKET_SIGNATURE_POLICY_MIN_FIRMWARE_LABEL = '2.8.0';

/** True for a value this code can put on the wire. */
export function isPacketSignaturePolicy(value: unknown): value is PacketSignaturePolicyValue {
  return typeof value === 'number' && PACKET_SIGNATURE_POLICIES.includes(value as PacketSignaturePolicyValue);
}

/** `COMPATIBLE` / `BALANCED` / `STRICT`, or `UNKNOWN(n)` for anything else. */
export function getPacketSignaturePolicyName(value: unknown): string {
  const entry = Object.entries(PacketSignaturePolicy).find(([, v]) => v === value);
  return entry ? entry[0] : `UNKNOWN(${String(value)})`;
}

/**
 * True when the firmware has the field. An unknown or unparseable version is
 * false: the caller must not offer or write a policy it cannot know the node
 * understands.
 */
export function supportsPacketSignaturePolicy(firmwareVersion: string | null | undefined): boolean {
  const { major, minor, patch } = PACKET_SIGNATURE_POLICY_MIN_FIRMWARE;
  return isFirmwareAtLeast(firmwareVersion, major, minor, patch);
}

/** What the UI must ask before it sends a policy change. */
export type PolicyChangeConfirmKind = 'none' | 'plain' | 'typed';

/**
 * The confirm a change from `from` to `to` needs (#5612):
 *
 *   - no change, or back to COMPATIBLE: none
 *   - to BALANCED: a plain confirm
 *   - to STRICT: a typed confirm (the node's short name)
 */
export function policyChangeConfirmKind(from: number | null, to: number | null): PolicyChangeConfirmKind {
  if (to === null || from === to) return 'none';
  if (to === PacketSignaturePolicy.STRICT) return 'typed';
  if (to === PacketSignaturePolicy.BALANCED) return 'plain';
  return 'none';
}

/**
 * The policy to put in a save, or undefined to leave it out.
 *
 * It is sent ONLY when the user changed it. Left out, the server keeps the
 * node's own value. `loaded` null means the node's policy is not known, and an
 * unknown policy is never overwritten.
 */
export function policyToSend(loaded: number | null, selected: number | null): PacketSignaturePolicyValue | undefined {
  if (loaded === null || selected === null || loaded === selected) return undefined;
  return isPacketSignaturePolicy(selected) ? selected : undefined;
}

/** A policy read from a node, or null when it is missing or not one we know. */
export function toKnownPolicy(value: unknown): PacketSignaturePolicyValue | null {
  return isPacketSignaturePolicy(value) ? value : null;
}
