/**
 * Shared scenario for the migration 228 tests (SQLite and PG/MySQL), so every
 * backend is checked against the same data and the same expected result (#6308).
 *
 * Message ids come from the LIVE `frameChannelMessageId` and the decoder's own
 * channel-hash format, never from the migration's inlined copy.
 */
import { createHash } from 'node:crypto';
import { decodeMeshCorePacket } from '../../utils/meshcorePacketDecode.js';
import { frameChannelMessageId, channelKeyFingerprint, keyedChannelIndex } from '../services/meshcoreFrameIngest.js';

export const MQTT = 'mq';
export const FUTURE = Date.now() + 24 * 60 * 60 * 1000;

const derive = (i: number): string =>
  createHash('sha256').update(`p18-secret-${i}`).digest('hex').slice(0, 32);
/** The channel hash exactly as the live MQTT ingest sees it (decoder output). */
const hashOf = (secretHex: string): string => {
  const first = createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest('hex').slice(0, 2);
  const group = decodeMeshCorePacket(`1500${first}aabb${'00'.repeat(16)}`)?.payload?.groupText;
  if (!group) throw new Error('fixture: decoder rejected the probe frame');
  return group.channelHash;
};

/** Two secrets with the same hash byte, and two with different ones. */
function pickSecrets() {
  const byHash = new Map<string, string>();
  let pair: [string, string] | null = null;
  for (let i = 0; !pair; i++) {
    const s = derive(i);
    const h = hashOf(s);
    const prev = byHash.get(h);
    if (prev) pair = [prev, s];
    else byHash.set(h, s);
  }
  const distinct = [...byHash.values()].filter((s) => hashOf(s) !== hashOf(pair![0])).slice(0, 2);
  return { collide: pair, x: distinct[0], y: distinct[1] };
}
const picked = pickSecrets();
export const SECRET_X = picked.x;
export const SECRET_Y = picked.y;
export const SECRET_A1 = picked.collide[0];
export const SECRET_A2 = picked.collide[1];
export const b64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');

export interface SourceSeed { id: string; type: string }
export interface ChannelSeed { id: number; sourceId: string; name: string; psk: string }
export interface MessageSeed {
  id: string;
  sourceId: string;
  fromPublicKey: string;
  text: string;
  timestamp: number;
  senderTimestamp: number | null;
  reactionRawText: string | null;
  messageType: string;
  keyFingerprint: string | null;
}
export interface PrefSeed { userId: number; sourceId: string; enabledChannels: string | null; mutedChannels: string | null }
export interface ReadSeed { userId: number; sourceId: string; key: string; lastReadAt: number }

const sources: SourceSeed[] = [
  { id: MQTT, type: 'meshcore_mqtt' },
  { id: 'comp1', type: 'meshcore' },
  { id: 'comp2', type: 'meshcore' },
  { id: 'mt', type: 'meshtastic_tcp' },
];
const channels: ChannelSeed[] = [
  { id: 3, sourceId: 'comp1', name: 'X', psk: b64(SECRET_X) },
  { id: 3, sourceId: 'comp2', name: 'Y', psk: b64(SECRET_Y) },
  { id: 6, sourceId: 'comp1', name: 'A1', psk: b64(SECRET_A1) },
  { id: 6, sourceId: 'comp2', name: 'A2', psk: b64(SECRET_A2) },
];

const TS = 1_700_000_000;
function row(
  secret: string,
  slot: number,
  tsSec: number,
  rawText: string,
  extra: Partial<MessageSeed> = {},
): MessageSeed {
  return {
    id: frameChannelMessageId('mqtt', MQTT, hashOf(secret), tsSec, rawText),
    sourceId: MQTT,
    fromPublicKey: `channel-${slot}`,
    text: rawText,
    timestamp: tsSec > 0 ? tsSec * 1000 : 1_700_000_123_456,
    senderTimestamp: tsSec > 0 ? tsSec : null,
    reactionRawText: null,
    messageType: 'channel',
    keyFingerprint: null,
    ...extra,
  };
}

const messages: MessageSeed[] = [
  row(SECRET_X, 3, TS, 'exact x'),
  row(SECRET_Y, 3, TS + 1, 'exact y'),
  // Reaction: text is the emoji, the id was derived from the raw text.
  row(SECRET_X, 3, TS + 2, 'reacted', { text: '+1', reactionRawText: 'reacted' }),
  // Row from before senderTimestamp existed: whole-second timestamp.
  row(SECRET_X, 3, TS + 3, 'old row', { senderTimestamp: null }),
  // Clock-less sender: the id keeps the raw 0, the row holds ingest time.
  row(SECRET_Y, 3, 0, 'no clock'),
  // Two different secrets at slot 6 share a hash byte: cannot be told apart.
  row(SECRET_A1, 6, TS + 4, 'ambiguous'),
  // No key at slot 7 any more.
  row(SECRET_X, 7, TS + 5, 'key deleted'),
  // Already keyed: untouched.
  row(SECRET_X, 3, TS + 6, 'keyed already', {
    fromPublicKey: `channel-${keyedChannelIndex(SECRET_X)}`,
    keyFingerprint: channelKeyFingerprint(SECRET_X),
  }),
  // A DM on the feed: untouched.
  row(SECRET_X, 3, TS + 7, 'dm', { messageType: 'text', fromPublicKey: 'channel-3' }),
  // A device source's own slot row: untouched.
  { ...row(SECRET_X, 3, TS + 8, 'own slot'), id: 'dev_1', sourceId: 'comp1' },
];

const prefs: PrefSeed[] = [
  { userId: 1, sourceId: MQTT, enabledChannels: JSON.stringify([3, 7]), mutedChannels: JSON.stringify([{ channelId: 3, muteUntil: null }]) },
  { userId: 2, sourceId: MQTT, enabledChannels: null, mutedChannels: JSON.stringify([{ channelId: 3, muteUntil: FUTURE }, { channelId: 7, muteUntil: null }]) },
  { userId: 1, sourceId: 'comp1', enabledChannels: JSON.stringify([3]), mutedChannels: null },
];
const reads: ReadSeed[] = [{ userId: 1, sourceId: MQTT, key: '3', lastReadAt: 12345 }];

export const scenario = { sources, channels, messages, prefs, reads };

export const KEYED_X = keyedChannelIndex(SECRET_X);
export const KEYED_Y = keyedChannelIndex(SECRET_Y);

/** Expected state per message id after the migration. */
export const expectedMessages: Record<string, { fromPublicKey: string; keyFingerprint: string | null; keySourceId?: string; keyChannelIdx?: number }> = {
  [messages[0].id]: { fromPublicKey: `channel-${KEYED_X}`, keyFingerprint: channelKeyFingerprint(SECRET_X), keySourceId: 'comp1', keyChannelIdx: 3 },
  [messages[1].id]: { fromPublicKey: `channel-${KEYED_Y}`, keyFingerprint: channelKeyFingerprint(SECRET_Y), keySourceId: 'comp2', keyChannelIdx: 3 },
  [messages[2].id]: { fromPublicKey: `channel-${KEYED_X}`, keyFingerprint: channelKeyFingerprint(SECRET_X), keySourceId: 'comp1', keyChannelIdx: 3 },
  [messages[3].id]: { fromPublicKey: `channel-${KEYED_X}`, keyFingerprint: channelKeyFingerprint(SECRET_X), keySourceId: 'comp1', keyChannelIdx: 3 },
  [messages[4].id]: { fromPublicKey: `channel-${KEYED_Y}`, keyFingerprint: channelKeyFingerprint(SECRET_Y), keySourceId: 'comp2', keyChannelIdx: 3 },
  [messages[5].id]: { fromPublicKey: 'channel-6', keyFingerprint: 'unresolved' },
  [messages[6].id]: { fromPublicKey: 'channel-7', keyFingerprint: 'unresolved' },
  [messages[7].id]: { fromPublicKey: `channel-${KEYED_X}`, keyFingerprint: channelKeyFingerprint(SECRET_X) },
  [messages[8].id]: { fromPublicKey: 'channel-3', keyFingerprint: null },
  dev_1: { fromPublicKey: 'channel-3', keyFingerprint: null },
};
