/**
 * Wire-accurate MeshCore frame builders for tests (#5551, #5553).
 *
 * GRP_TXT is GENUINELY encrypted — AES-128-ECB with the 2-byte HMAC-SHA256
 * prefix MeshCore uses — so tests run the shipping decoder and decrypt rather
 * than a stub of them.
 */
import { createHmac, createCipheriv } from 'node:crypto';
import { ChannelCrypto } from '@michaelhart/meshcore-decoder';

/** header | path_len | channel_hash | mac(2) | ciphertext, route FLOOD. */
export function buildGrpTxtFrame(timestampSec: number, body: string, secretHex: string): string {
  const text = Buffer.from(body, 'utf8');
  const plain = Buffer.alloc(5 + text.length);
  plain.writeUInt32LE(timestampSec, 0);
  plain[4] = 0; // flags
  text.copy(plain, 5);
  // AES-ECB with NoPadding needs a block multiple.
  const padded = Buffer.alloc(Math.ceil(plain.length / 16) * 16);
  plain.copy(padded);
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(secretHex, 'hex'), null);
  cipher.setAutoPadding(false);
  const ct = Buffer.concat([cipher.update(padded), cipher.final()]);
  // MAC: HMAC-SHA256 over the ciphertext, keyed with the secret zero-padded to 32.
  const key32 = Buffer.alloc(32);
  Buffer.from(secretHex, 'hex').copy(key32);
  const mac = createHmac('sha256', key32).update(ct).digest();
  const hash = ChannelCrypto.calculateChannelHash(secretHex);
  const header = ((5 & 0x0f) << 2) | 1; // payload GRP_TXT(5), route FLOOD(1)
  return header.toString(16).padStart(2, '0') + '00' + hash + mac.subarray(0, 2).toString('hex') + ct.toString('hex');
}

/**
 * GRP_DATA: same outer frame as GRP_TXT, with the firmware's datagram
 * plaintext `data_type(2 LE) | data_len(1) | data` (BaseChatMesh::sendGroupData).
 */
export function buildGrpDataFrame(dataType: number, data: Buffer, secretHex: string): string {
  const plain = Buffer.alloc(3 + data.length);
  plain.writeUInt16LE(dataType, 0);
  plain[2] = data.length;
  data.copy(plain, 3);
  const padded = Buffer.alloc(Math.ceil(plain.length / 16) * 16);
  plain.copy(padded);
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(secretHex, 'hex'), null);
  cipher.setAutoPadding(false);
  const ct = Buffer.concat([cipher.update(padded), cipher.final()]);
  const key32 = Buffer.alloc(32);
  Buffer.from(secretHex, 'hex').copy(key32);
  const mac = createHmac('sha256', key32).update(ct).digest();
  const hash = ChannelCrypto.calculateChannelHash(secretHex);
  const header = ((6 & 0x0f) << 2) | 1; // payload GRP_DATA(6), route FLOOD(1)
  return header.toString(16).padStart(2, '0') + '00' + hash + mac.subarray(0, 2).toString('hex') + ct.toString('hex');
}

/** header | path_len | pubkey(32) | timestamp(4 LE) | signature(64) | appData */
export function buildAdvertFrame(opts: {
  publicKey: string;
  timestamp?: number;
  advType?: number;
  lat?: number;
  lon?: number;
  name?: string;
}): string {
  const bytes: number[] = [(4 << 2) | 1, 0x00]; // ADVERT(4), FLOOD(1), path_len 0
  for (let i = 0; i < 64; i += 2) bytes.push(parseInt(opts.publicKey.slice(i, i + 2), 16));
  const ts = opts.timestamp ?? 1_700_000_000;
  bytes.push(ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, (ts >>> 24) & 0xff);
  for (let i = 0; i < 64; i++) bytes.push(0xcd); // signature (not verified on ingest)
  let flags = opts.advType ?? 1;
  const tail: number[] = [];
  if (opts.lat !== undefined && opts.lon !== undefined) {
    flags |= 0x10;
    for (const deg of [opts.lat, opts.lon]) {
      const v = Math.round(deg * 1_000_000) | 0;
      tail.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    }
  }
  if (opts.name !== undefined) {
    flags |= 0x80;
    for (const ch of Buffer.from(opts.name, 'utf8')) tail.push(ch);
  }
  bytes.push(flags, ...tail);
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}
