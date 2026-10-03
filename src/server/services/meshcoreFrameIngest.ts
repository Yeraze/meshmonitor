/**
 * Shared RX-side ingest for raw MeshCore frames (#5551, #5553).
 *
 * Two kinds of source hand us whole OTA frames rather than companion-protocol
 * events: a `meshcore_mqtt` ingest source (frames other observers heard) and a
 * directly-attached repeater on a `MESH_PACKET_LOGGING` build (its serial
 * `RAW:` lines). Both turn the same two frame types into stored knowledge:
 *
 * - **ADVERT → node.** Adverts are unencrypted and self-describing.
 * - **GRP_TXT → channel message**, when we hold a key whose channel hash
 *   matches the frame.
 *
 * This module is the one copy of that logic, so the two paths cannot drift.
 * It never transmits anything, and it never emits events — notification,
 * automation and socket decisions stay with the caller, because the two
 * callers make different ones.
 *
 * GRP_DATA (0x06) is NOT handled: `ChannelCrypto` only parses the GRP_TXT
 * plaintext layout (timestamp | flags | "sender: text"), and GRP_DATA carries
 * a binary body with a different layout.
 */
import { createHash } from 'node:crypto';
import { ChannelCrypto } from '@michaelhart/meshcore-decoder';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/base.js';
import { decodeMeshCorePacket, type DecodedAdvert } from '../../utils/meshcorePacketDecode.js';

/** Base64 or hex channel secret -> lowercase hex, or null when unusable. */
export function pskToHex(psk: string | null | undefined): string | null {
  if (!psk) return null;
  if (/^[0-9a-fA-F]+$/.test(psk) && psk.length % 2 === 0) return psk.toLowerCase();
  try {
    const buf = Buffer.from(psk, 'base64');
    return buf.length > 0 ? buf.toString('hex') : null;
  } catch {
    return null;
  }
}

/**
 * Convert an ADVERT's self-reported unix-seconds timestamp into a `lastHeard`
 * milliseconds value, or `undefined` when it carries none.
 *
 * Clamped to now: the value comes from an untrusted sender, so a future claim
 * is either a forgery or a node with a bad clock, and both would corrupt every
 * "last heard" ordering that reads this column.
 */
export function advertLastHeardMs(timestampSec: number, nowMs: number = Date.now()): number | undefined {
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) return undefined;
  return Math.min(timestampSec * 1000, nowMs);
}

/**
 * One-way fingerprint of a channel secret: hex SHA-256(secret bytes)[0..8].
 *
 * Stored on cross-source-decrypted message rows so reads can be gated on
 * "does this viewer hold access to a channel with this secret" without copying
 * the secret. Its first byte is the on-air channel hash, so it reveals nothing
 * a listener does not already have beyond 7 more digest bytes.
 */
export function channelKeyFingerprint(secretHex: string): string {
  return createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest('hex').slice(0, 16);
}

/**
 * Channel indices at or above this are "keyed" channels: a bucket derived from
 * the secret, used by a source that decrypts with another source's key. They
 * sit far above any device slot (MeshCore companions top out near 40) and
 * above the Meshtastic CHANNEL_DB_OFFSET (100) range.
 */
export const MESHCORE_KEYED_CHANNEL_BASE = 1000;

/**
 * Stable channel index for a secret: BASE + the fingerprint's first 2 bytes.
 *
 * Derived from the secret, not from whichever source's slot held it, so the
 * same key held by two sources (Public on two companions) files under ONE
 * channel, and deleting and re-adding a key keeps its history together. Two
 * different secrets share an index only on a 16-bit collision; reads still
 * gate each row on its own full fingerprint.
 */
export function keyedChannelIndex(secretHex: string): number {
  return MESHCORE_KEYED_CHANNEL_BASE + parseInt(channelKeyFingerprint(secretHex).slice(0, 4), 16);
}

/** True when `idx` is a keyed-channel index (see {@link keyedChannelIndex}). */
export function isKeyedChannelIndex(idx: number): boolean {
  return Number.isInteger(idx) && idx >= MESHCORE_KEYED_CHANNEL_BASE;
}

/** The subset of a `channels` row this module reads. */
export interface ChannelKeyRow {
  id: number;
  name?: string | null;
  psk?: string | null;
  sourceId?: string | null;
}

/** The subset of a MeshCore `channel_database` row this module reads (#5552). */
export interface VirtualChannelKeyRow {
  id?: number;
  name?: string | null;
  psk?: string | null;
}

/**
 * A channel key whose hash matched a frame. It comes from a device source's
 * `channels` row (`sourceId` + `channelIdx` set) or from a MeshCore virtual
 * channel in `channel_database` (`channelDbId` set, the other two null).
 */
export interface ChannelKeyCandidate {
  sourceId: string | null;
  channelIdx: number | null;
  channelDbId: number | null;
  name: string;
  secretHex: string;
}

/**
 * Enabled MeshCore virtual channels (#5552): keys held by the server alone, so
 * decrypt is not capped by a companion's ~40 slots. Never the Meshtastic rows.
 * Best-effort: a read failure leaves the device keys usable.
 */
async function readVirtualChannelKeys(): Promise<VirtualChannelKeyRow[]> {
  try {
    return (await databaseService.channelDatabase?.getEnabledAsync?.('meshcore')) ?? [];
  } catch {
    return [];
  }
}

/**
 * Every stored channel key, across ALL sources, whose channel hash is
 * `channelHashHex` (the frame's first payload byte = SHA-256(secret)[0]).
 *
 * Keys are global by design here, like the Meshtastic `channel_database`:
 * a radio-less or channel-less source has no keys of its own. Selecting by
 * hash means at most a couple of candidates are ever tried per frame.
 *
 * Device keys come first, then MeshCore virtual channels (`channel_database`
 * rows with protocol 'meshcore', #5552) whose secret no device key already
 * supplied. `rows` / `virtualRows` let a caller pass pre-read lists; by
 * default both are read fresh.
 */
export async function findChannelKeysByHash(
  channelHashHex: string,
  rows?: ChannelKeyRow[],
  virtualRows?: VirtualChannelKeyRow[],
): Promise<ChannelKeyCandidate[]> {
  const all = rows ?? ((await databaseService.channels.getAllChannels(ALL_SOURCES)) as ChannelKeyRow[]);
  const out: ChannelKeyCandidate[] = [];
  const want = channelHashHex.toLowerCase();
  const seen = new Set<string>();
  for (const ch of all) {
    const secretHex = pskToHex(ch.psk);
    if (!secretHex) continue;
    if (ChannelCrypto.calculateChannelHash(secretHex) !== want) continue;
    seen.add(secretHex);
    out.push({
      sourceId: ch.sourceId ?? null,
      channelIdx: Number(ch.id),
      channelDbId: null,
      name: typeof ch.name === 'string' ? ch.name : '',
      secretHex,
    });
  }
  for (const vc of virtualRows ?? (rows ? [] : await readVirtualChannelKeys())) {
    const secretHex = pskToHex(vc.psk);
    if (!secretHex || seen.has(secretHex)) continue;
    if (ChannelCrypto.calculateChannelHash(secretHex) !== want) continue;
    seen.add(secretHex);
    out.push({
      sourceId: null,
      channelIdx: null,
      channelDbId: vc.id ?? null,
      name: typeof vc.name === 'string' ? vc.name : '',
      secretHex,
    });
  }
  return out;
}

/** The shape `ChannelCrypto.decryptGroupTextMessage` returns in `data`. */
interface ChannelPlaintext {
  timestamp?: number;
  flags?: number;
  sender?: string;
  message?: string;
}

/** A decrypted GRP_TXT body plus the key that opened it. */
export interface DecryptedGroupText {
  text: string;
  senderName: string | null;
  /** Sender's own clock, epoch seconds; 0 when it has none. */
  timestampSec: number;
  key: ChannelKeyCandidate;
}

/**
 * Try every known channel key whose hash matches the frame's.
 *
 * Returns null when we hold no matching key — the common case for traffic on
 * channels we are not in. That is not an error and must not be logged per
 * packet. The FIRST key that opens it wins; a secret held by several sources
 * decrypts identically whichever one that is.
 */
export async function decryptGroupTextFrame(
  group: { channelHash: string; cipherMacHex: string; ciphertextHex: string },
  rows?: ChannelKeyRow[],
  virtualRows?: VirtualChannelKeyRow[],
): Promise<DecryptedGroupText | null> {
  const candidates = await findChannelKeysByHash(group.channelHash, rows, virtualRows);
  for (const key of candidates) {
    const res = ChannelCrypto.decryptGroupTextMessage(group.ciphertextHex, group.cipherMacHex, key.secretHex);
    // The library already splits the plaintext into timestamp / flags /
    // sender / message, so there is no second parser to keep in step.
    const data = res?.success ? (res.data as ChannelPlaintext | undefined) : undefined;
    if (!data || typeof data.message !== 'string' || data.message === '') continue;
    return {
      text: data.message,
      senderName: typeof data.sender === 'string' && data.sender !== '' ? data.sender : null,
      timestampSec: typeof data.timestamp === 'number' ? data.timestamp : 0,
      key,
    };
  }
  return null;
}

/**
 * Count one stored message against the virtual channel whose key opened it
 * (#5552), for the Channel Database page. No-op for a device key. Best-effort:
 * a counter must never cost an ingested message.
 */
export function noteVirtualChannelDecrypt(key: ChannelKeyCandidate): void {
  if (key.channelDbId === null) return;
  void databaseService.channelDatabase.incrementDecryptedCountAsync(key.channelDbId).catch(() => undefined);
}

/**
 * Content-derived id for a channel message ingested from raw frames.
 *
 * Includes `sourceId` so a copy another source heard keeps its own row, while
 * every copy of the SAME transmission on THIS source (several observers, or a
 * repeater hearing a flood relayed by several neighbours) collapses to one id
 * and therefore one row. Keyed on (channel, sender timestamp, text) rather than
 * the raw frame, because relays differ in path bytes while the message does
 * not. For a clock-less sender (timestamp 0) two identical sends collapse —
 * inherent, since they are byte-identical on the wire.
 */
export function frameChannelMessageId(
  prefix: string,
  sourceId: string,
  channelKey: string,
  timestampSec: number,
  text: string,
): string {
  const digest = createHash('sha256')
    .update(`${channelKey}\u0000${timestampSec}\u0000${text}`)
    .digest('hex')
    .slice(0, 24);
  return `${prefix}_${sourceId}_${digest}`;
}

/**
 * Create or update a node on `sourceId` from an ADVERT frame.
 *
 * Signatures are decoded but not enforced — the same trade-off the MQTT path
 * documents (#5040): per-source scoping bounds a forged advert to this source.
 * `undefined` fields mean "not observed" to `upsertNode`, which then keeps the
 * stored value, so an advert without a name never blanks a good one.
 *
 * `lastHeardMs`: `'advert'` uses the advert's own timestamp capped at now (an
 * MQTT feed can replay or delay); a number uses that reception time.
 *
 * Returns the decoded advert when a node was written, else null. Throws on a
 * DB failure; callers are best-effort and catch.
 */
export async function ingestAdvertFrame(
  rawHex: string,
  sourceId: string,
  opts: { lastHeardMs: number | 'advert'; skipPublicKey?: string | null },
): Promise<DecodedAdvert | null> {
  const packet = decodeMeshCorePacket(rawHex);
  const advert = packet?.payload?.advert;
  if (!advert?.publicKey) return null;
  if (opts.skipPublicKey && advert.publicKey.toLowerCase() === opts.skipPublicKey.toLowerCase()) return null;

  await databaseService.meshcore.upsertNode(
    {
      publicKey: advert.publicKey,
      name: advert.name ?? undefined,
      advType: advert.advType,
      latitude: advert.latitude,
      longitude: advert.longitude,
      // An advert position is the static kind, so a real telemetry fix keeps
      // precedence (same tag the contact-sync path uses).
      positionSource: advert.latitude !== undefined ? 'contact' : undefined,
      lastHeard: opts.lastHeardMs === 'advert' ? advertLastHeardMs(advert.timestamp) : opts.lastHeardMs,
    },
    sourceId,
  );
  return advert;
}
