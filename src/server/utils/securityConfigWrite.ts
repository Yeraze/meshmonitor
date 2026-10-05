/**
 * The one place that turns "what the client asked to change" plus "what the
 * node holds now" into the SecurityConfig we write.
 *
 * Firmware assigns the whole security struct on a set
 * (`AdminModule::handleSetConfig`: `config.security = c.payload_variant.security`).
 * It does not merge. So every field we leave out is reset:
 *
 *   - no 32-byte private key  -> firmware mints a NEW keypair (new identity, #4736)
 *   - no packet_signature_policy (field 9, firmware 2.8) -> COMPATIBLE (0),
 *     a downgrade from BALANCED/STRICT that nothing reports
 *
 * The local and the remote save both build their write here, so the two paths
 * cannot drift apart again: the local path used to carry the keys but not the
 * policy.
 *
 * Keys and policy differ in who may set them. Keys: the node's own always win
 * for a remote node, and the private key never reaches the client (#4736,
 * #4632). Policy: the client's value wins when it sends one (#5612).
 */
import { derivePublicKey, normalizeMeshtasticKey } from './meshtasticKeys.js';
import { isPacketSignaturePolicy } from '../constants/meshtastic.js';

/** What the node holds right now, read from the node itself. */
export interface CurrentSecurityState {
  /** base64, or null when the node has no key yet. */
  publicKey: string | null;
  /** base64, or null when the node has no key yet. */
  privateKey: string | null;
  /** `Config.SecurityConfig.PacketSignaturePolicy`; absent on firmware < 2.8. */
  packetSignaturePolicy?: number;
}

export interface BuildSecurityConfigWriteOptions {
  /**
   * Honor a client-supplied key (#4632). True for the LOCAL node only. For a
   * remote node the server cannot tell an honest echo from an identity hijack,
   * so the node's own keys always win.
   */
  allowClientKeys: boolean;
}

/** A decoded `Config.SecurityConfig` as protobuf.js hands it over. */
export interface RawSecurityConfig {
  publicKey?: Uint8Array | null;
  privateKey?: Uint8Array | null;
  packetSignaturePolicy?: unknown;
  [field: string]: unknown;
}

/**
 * Read a security config (protobuf.js object: byte fields, numeric enum) into
 * the shape `buildSecurityConfigWrite` wants.
 */
export function toCurrentSecurityState(security: RawSecurityConfig | null | undefined): CurrentSecurityState {
  const b64 = (bytes: Uint8Array | null | undefined): string | null =>
    bytes && bytes.length > 0 ? Buffer.from(bytes).toString('base64') : null;
  return {
    publicKey: b64(security?.publicKey),
    privateKey: b64(security?.privateKey),
    packetSignaturePolicy: normalizePolicy(security?.packetSignaturePolicy),
  };
}

/**
 * A policy we can put on the wire, or undefined.
 *
 * COMPATIBLE (0) maps to undefined on purpose. It is the proto3 default, so a
 * write without field 9 already means COMPATIBLE to firmware 2.8, and leaving
 * it off keeps the field off the wire for firmware older than 2.8, which has
 * no such field. (A decode with `defaults: true` reports 0 for those nodes.)
 */
function normalizePolicy(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Build the config handed to `protobufService.createSetSecurityConfigMessage`.
 *
 * `clientConfig` is untrusted request input. `current` must come from the node.
 */
export function buildSecurityConfigWrite(
  clientConfig: Record<string, unknown>,
  current: CurrentSecurityState,
  options: BuildSecurityConfigWriteOptions,
): Record<string, unknown> {
  // Client value wins when sent (#5612): the UI sends a policy only when the
  // user changed it, so a valid one in the body is a choice. Absent (or not a
  // value we know) keeps the node's own. The route validates the value and the
  // node's firmware before this runs.
  //
  // An explicit COMPATIBLE needs the `isPacketSignaturePolicy` test rather
  // than `normalizePolicy(client) ?? current`: 0 normalizes to undefined, which
  // would read as "not sent" and keep a BALANCED/STRICT node where it is.
  const { packetSignaturePolicy: clientPolicy, ...rest } = clientConfig;
  const packetSignaturePolicy = normalizePolicy(
    isPacketSignaturePolicy(clientPolicy) ? clientPolicy : current.packetSignaturePolicy,
  );

  const write: Record<string, unknown> = { ...rest };
  delete write.publicKey;
  delete write.privateKey;

  const keys = resolveKeys(clientConfig, current, options);
  if (keys.publicKey) write.publicKey = keys.publicKey;
  if (keys.privateKey) write.privateKey = keys.privateKey;

  // Absent stays absent: the encoder writes field 9 only when this is set.
  if (packetSignaturePolicy !== undefined) write.packetSignaturePolicy = packetSignaturePolicy;
  return write;
}

function resolveKeys(
  clientConfig: Record<string, unknown>,
  current: CurrentSecurityState,
  options: BuildSecurityConfigWriteOptions,
): { publicKey: string | null; privateKey: string | null } {
  if (!options.allowClientKeys) {
    return { publicKey: current.publicKey, privateKey: current.privateKey };
  }

  const clientPrivate = typeof clientConfig.privateKey === 'string' ? clientConfig.privateKey.trim() : '';
  const clientPublic = typeof clientConfig.publicKey === 'string' ? clientConfig.publicKey.trim() : '';

  // A private key that differs from the stored one is a deliberate identity
  // change (#4632). Firmware stores the pair as sent and does not re-derive,
  // so send the PUBLIC key that matches the NEW private key. Keeping the old
  // public key would leave the node advertising a key that no longer matches
  // its secret and break PKI DMs to it.
  //
  // Compare normalized (no `base64:` prefix) so re-sending the SAME key the
  // firmware reported reads as unchanged.
  const isNewPrivateKey = clientPrivate.length > 0
    && normalizeMeshtasticKey(clientPrivate) !== normalizeMeshtasticKey(current.privateKey ?? '');
  if (isNewPrivateKey) {
    return { privateKey: normalizeMeshtasticKey(clientPrivate), publicKey: derivePublicKey(clientPrivate) };
  }

  // Otherwise keep the node's keys. Normalize a supplied key before it reaches
  // the encoder: `base64:…` is not valid base64 and would corrupt the identity.
  return {
    publicKey: clientPublic ? normalizeMeshtasticKey(clientPublic) : current.publicKey,
    privateKey: clientPrivate ? normalizeMeshtasticKey(clientPrivate) : current.privateKey,
  };
}
