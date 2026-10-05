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
 */
import { derivePublicKey, normalizeMeshtasticKey } from './meshtasticKeys.js';

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
  // The policy never comes from the client in this version: there is no UI for
  // it, so a value in the request body is not a user's choice. Strip it and
  // carry the node's own.
  //
  // #5612 hook: to let a caller set the policy, change the line below to
  //   normalizePolicy(clientPolicy) ?? current.packetSignaturePolicy
  // after validating `clientPolicy` (an explicit COMPATIBLE needs its own
  // "client sent a value" check, since 0 normalizes to undefined).
  const { packetSignaturePolicy: _clientPolicy, ...rest } = clientConfig;
  const packetSignaturePolicy = normalizePolicy(current.packetSignaturePolicy);

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
