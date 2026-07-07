/**
 * MeshCore GRP_TXT (channel/broadcast text) self-echo crypto (#3979).
 *
 * When a nearby repeater re-floods one of OUR channel messages, our device
 * hears it back as an inbound `PAYLOAD_TYPE_GRP_TXT` (0x05) OTA packet whose
 * relay-hash chain names the repeaters that carried it. To attribute that echo
 * to the SPECIFIC message we sent — and to reject unrelated third-party channel
 * chatter on the same channel — we hold the channel PSK and decrypt the echoed
 * payload, then match the recovered plaintext against what we sent.
 *
 * Wire format (verified against ripplebiz/MeshCore `main`):
 *   GRP_TXT payload = [channel_hash : 1B][MAC : 2B][ciphertext]
 *     - channel_hash = SHA-256(secret)[0]            (Utils/BaseChatMesh.addChannel)
 *     - MAC          = HMAC-SHA256(secret32, ciphertext)[0:2]   (Utils.encryptThenMAC)
 *                      where secret32 = 16-byte PSK zero-padded to 32 bytes
 *     - ciphertext   = AES-128-ECB(secret[0:16], plaintext), zero-padded to 16B
 *   plaintext = timestamp(4 LE) || flags(1, =0x00 for PLAIN group text)
 *               || "<senderName>: <text>"   (NUL-terminated / zero-padded)
 *
 * Repeaters forward the payload byte-for-byte (only `path[]` mutates), so the
 * ciphertext we hear back is identical to what we sent and the decrypt is exact.
 *
 * Server-only (Node `crypto`). Every function is defensive: a malformed,
 * wrong-channel, MAC-failing, or otherwise undecodable frame returns null and
 * NEVER throws, so this can run on the hot inbound-packet path safely.
 */
import { createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { hexToBytes } from '../../utils/meshcorePacketDecode.js';
import { MESHCORE_SECRET_BYTES } from '../../utils/meshcoreHelpers.js';

/** Bytes of channel_hash prefixing a GRP_TXT payload (PATH_HASH_SIZE = 1). */
const CHANNEL_HASH_SIZE = 1;
/** Bytes of MAC (CIPHER_MAC_SIZE = 2). */
const CIPHER_MAC_SIZE = 2;
/** AES block size — the firmware zero-pads ciphertext to a multiple of this. */
const AES_BLOCK_SIZE = 16;
/** Plaintext header: timestamp(4 LE) + flags(1). */
const GROUP_TEXT_HEADER_SIZE = 5;
/**
 * Firmware `GroupChannel.secret` is a PUB_KEY_SIZE = 32-byte buffer; the HMAC
 * key is the whole buffer (a 16-byte PSK is zero-padded to 32), while AES uses
 * only the first CIPHER_KEY_SIZE = 16 bytes.
 */
const SECRET_BUFFER_SIZE = 32;

/**
 * Derive the 1-byte MeshCore channel hash from a channel secret: the first byte
 * of SHA-256 over the secret (`BaseChatMesh::addChannel`). For MeshMonitor's
 * 16-byte AES-128 PSKs this hashes the 16 stored bytes.
 */
export function deriveMeshCoreChannelHash(secret: Uint8Array): number {
  return createHash('sha256').update(Buffer.from(secret)).digest()[0];
}

/**
 * Split a channel secret into the AES key (first 16 bytes) and the HMAC key
 * (the secret zero-padded to 32 bytes). Returns null for a too-short secret.
 */
function secretToKeys(secret: Uint8Array): { aesKey: Buffer; hmacKey: Buffer } | null {
  if (secret.length < MESHCORE_SECRET_BYTES) return null;
  const aesKey = Buffer.from(secret.subarray(0, MESHCORE_SECRET_BYTES));
  const hmacKey = Buffer.alloc(SECRET_BUFFER_SIZE);
  Buffer.from(secret).copy(hmacKey, 0, 0, Math.min(secret.length, SECRET_BUFFER_SIZE));
  return { aesKey, hmacKey };
}

export interface DecodedGroupText {
  /** Firmware send-time timestamp (unix seconds, LE) recovered from plaintext. */
  timestamp: number;
  /**
   * The recovered `"<senderName>: <text>"` body. MeshCore prefixes every group
   * message with the sender's node name and a `": "` separator, so a self-echo
   * of our own send decrypts to `"<ourNodeName>: <textWeSent>"`.
   */
  body: string;
}

/**
 * MAC-verify and AES-128-ECB decrypt a raw GRP_TXT payload
 * (`[channel_hash:1][MAC:2][ciphertext]` hex) with a candidate 16-byte channel
 * secret. Returns the recovered `{ timestamp, body }` or null on ANY failure
 * (wrong channel hash, MAC mismatch, malformed structure, non-PLAIN group text,
 * no `": "` separator). NEVER throws.
 */
export function tryDecodeGroupTextPayload(
  payloadHex: string | null | undefined,
  secret: Uint8Array,
): DecodedGroupText | null {
  try {
    if (!payloadHex) return null;
    const keys = secretToKeys(secret);
    if (!keys) return null;

    const payload = hexToBytes(payloadHex);
    if (payload.length < CHANNEL_HASH_SIZE + CIPHER_MAC_SIZE + AES_BLOCK_SIZE) return null;

    // (1) Channel-hash pre-filter — cheap reject for the wrong channel.
    if (payload[0] !== deriveMeshCoreChannelHash(secret)) return null;

    const mac = payload.subarray(CHANNEL_HASH_SIZE, CHANNEL_HASH_SIZE + CIPHER_MAC_SIZE);
    const ciphertext = payload.subarray(CHANNEL_HASH_SIZE + CIPHER_MAC_SIZE);
    if (ciphertext.length === 0 || ciphertext.length % AES_BLOCK_SIZE !== 0) return null;

    // (2) MAC verify: HMAC-SHA256(secret32, ciphertext)[0:2].
    const expected = createHmac('sha256', keys.hmacKey).update(Buffer.from(ciphertext)).digest();
    if (expected[0] !== mac[0] || expected[1] !== mac[1]) return null;

    // (3) AES-128-ECB decrypt. Firmware zero-pads (not PKCS), so no auto-padding.
    const decipher = createDecipheriv('aes-128-ecb', keys.aesKey, null);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
    if (plain.length < GROUP_TEXT_HEADER_SIZE + 1) return null;

    // Group text is TXT_TYPE_PLAIN — the receiver drops anything with the type
    // bits set (`onGroupDataRecv` rejects `(flags >> 2) != 0`). Mirror that.
    if ((plain[GROUP_TEXT_HEADER_SIZE - 1] >> 2) !== 0) return null;

    const timestamp = plain.readUInt32LE(0);
    // Text is NUL-terminated inside the buffer (or ends at the zero padding).
    let end = plain.indexOf(0, GROUP_TEXT_HEADER_SIZE);
    if (end < 0) end = plain.length;
    const body = plain.subarray(GROUP_TEXT_HEADER_SIZE, end).toString('utf8');
    return { timestamp, body };
  } catch {
    return null;
  }
}

/**
 * Build the wire GRP_TXT payload (`[channel_hash:1][MAC:2][ciphertext]`) for a
 * channel message. This is the exact inverse of {@link tryDecodeGroupTextPayload}
 * — the production decode path is validated end-to-end against fixtures built
 * with this. Returns the payload as a lowercase hex string.
 *
 * @param secret      16-byte AES-128 channel secret.
 * @param senderName  Sender node name (prefixed to the text on the wire).
 * @param text        Message text.
 * @param timestamp   Firmware send timestamp (unix seconds); defaults to now.
 */
export function encodeGroupTextPayload(
  secret: Uint8Array,
  senderName: string,
  text: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const keys = secretToKeys(secret);
  if (!keys) throw new Error('channel secret too short');

  const bodyBytes = Buffer.from(`${senderName}: ${text}`, 'utf8');
  const rawLen = GROUP_TEXT_HEADER_SIZE + bodyBytes.length;
  const paddedLen = Math.ceil(rawLen / AES_BLOCK_SIZE) * AES_BLOCK_SIZE;
  const plain = Buffer.alloc(paddedLen); // zero-filled → zero padding
  plain.writeUInt32LE(timestamp >>> 0, 0);
  plain[4] = 0x00; // TXT_TYPE_PLAIN, attempt 0
  bodyBytes.copy(plain, GROUP_TEXT_HEADER_SIZE);

  const cipher = createCipheriv('aes-128-ecb', keys.aesKey, null);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);

  const mac = createHmac('sha256', keys.hmacKey).update(ciphertext).digest();
  const channelHash = deriveMeshCoreChannelHash(secret);

  const payload = Buffer.concat([
    Buffer.from([channelHash]),
    mac.subarray(0, CIPHER_MAC_SIZE),
    ciphertext,
  ]);
  return payload.toString('hex');
}
