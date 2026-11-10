/**
 * Migration 228 (SQLite): re-file MeshCore MQTT slot rows under keyed indices
 * (#6308). Same scenario as the PG/MySQL suite (migration228Fixture).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  migration,
  planRefile,
  planPrefFanOut,
  buildSlotKeys,
  pskToHex as migPskToHex,
  channelKeyFingerprint as migFingerprint,
  keyedChannelIndex as migKeyedIndex,
  mqttMessageId,
} from './228_refile_meshcore_mqtt_slot_channels.js';
import {
  pskToHex,
  channelKeyFingerprint,
  keyedChannelIndex,
  frameChannelMessageId,
} from '../services/meshcoreFrameIngest.js';
import { decodeMeshCorePacket } from '../../utils/meshcorePacketDecode.js';
import {
  scenario, expectedMessages, MQTT, KEYED_X, KEYED_Y, FUTURE, SECRET_X, SECRET_Y, SECRET_A1, b64,
} from '../test-helpers/migration228Fixture.js';

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', type TEXT NOT NULL);
    CREATE TABLE channels (pk INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL, name TEXT NOT NULL, psk TEXT, sourceId TEXT);
    CREATE TABLE meshcore_messages (
      id TEXT PRIMARY KEY, fromPublicKey TEXT NOT NULL, text TEXT NOT NULL, timestamp INTEGER NOT NULL,
      senderTimestamp INTEGER, reactionRawText TEXT, keySourceId TEXT, keyChannelIdx INTEGER,
      keyFingerprint TEXT, messageType TEXT DEFAULT 'text', sourceId TEXT
    );
    CREATE TABLE user_notification_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, source_id TEXT NOT NULL,
      enabled_channels TEXT, muted_channels TEXT
    );
    CREATE TABLE conversation_read_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, source_id TEXT NOT NULL,
      conversation_kind TEXT NOT NULL, conversation_key TEXT NOT NULL, last_read_at INTEGER NOT NULL,
      UNIQUE (user_id, source_id, conversation_kind, conversation_key)
    );
  `);
  for (const s of scenario.sources) db.prepare('INSERT INTO sources (id, type) VALUES (?, ?)').run(s.id, s.type);
  for (const c of scenario.channels) db.prepare('INSERT INTO channels (id, name, psk, sourceId) VALUES (?, ?, ?, ?)').run(c.id, c.name, c.psk, c.sourceId);
  for (const m of scenario.messages) {
    db.prepare(
      'INSERT INTO meshcore_messages (id, fromPublicKey, text, timestamp, senderTimestamp, reactionRawText, keyFingerprint, messageType, sourceId) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(m.id, m.fromPublicKey, m.text, m.timestamp, m.senderTimestamp, m.reactionRawText, m.keyFingerprint, m.messageType, m.sourceId);
  }
  for (const p of scenario.prefs) {
    db.prepare('INSERT INTO user_notification_preferences (user_id, source_id, enabled_channels, muted_channels) VALUES (?,?,?,?)')
      .run(p.userId, p.sourceId, p.enabledChannels, p.mutedChannels);
  }
  for (const r of scenario.reads) {
    db.prepare("INSERT INTO conversation_read_state (user_id, source_id, conversation_kind, conversation_key, last_read_at) VALUES (?,?,'meshcore_channel',?,?)")
      .run(r.userId, r.sourceId, r.key, r.lastReadAt);
  }
  return db;
}

const messageState = (db: Database.Database) =>
  Object.fromEntries(
    (db.prepare('SELECT id, fromPublicKey, keyFingerprint, keySourceId, keyChannelIdx FROM meshcore_messages').all() as Array<Record<string, unknown>>)
      .map((r) => [r.id as string, r]),
  );

describe('Migration 228 — SQLite', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = setup();
  });

  it('re-files, resolves, and leaves other rows alone', () => {
    migration.up(db);
    const state = messageState(db);
    for (const [id, want] of Object.entries(expectedMessages)) {
      expect(state[id], id).toMatchObject({ fromPublicKey: want.fromPublicKey, keyFingerprint: want.keyFingerprint });
      if (want.keySourceId) expect(state[id], id).toMatchObject({ keySourceId: want.keySourceId, keyChannelIdx: want.keyChannelIdx });
    }
  });

  it('is a no-op on a second run', () => {
    migration.up(db);
    const dump = () => JSON.stringify([
      db.prepare('SELECT * FROM meshcore_messages ORDER BY id').all(),
      db.prepare('SELECT * FROM user_notification_preferences ORDER BY id').all(),
      db.prepare('SELECT * FROM conversation_read_state ORDER BY id').all(),
    ]);
    const first = dump();
    migration.up(db);
    expect(dump()).toBe(first);
  });

  it('fans out notification prefs: union, originals kept, mutes merged', () => {
    migration.up(db);
    const get = (u: number, s: string) =>
      db.prepare('SELECT enabled_channels AS e, muted_channels AS m FROM user_notification_preferences WHERE user_id = ? AND source_id = ?').get(u, s) as { e: string | null; m: string | null };
    const u1 = get(1, MQTT);
    expect(JSON.parse(u1.e!).sort((a: number, b: number) => a - b)).toEqual([3, 7, KEYED_X, KEYED_Y].sort((a, b) => a - b));
    expect(JSON.parse(u1.m!).sort((a: { channelId: number }, b: { channelId: number }) => a.channelId - b.channelId)).toEqual(
      [{ channelId: 3, muteUntil: null }, { channelId: KEYED_X, muteUntil: null }, { channelId: KEYED_Y, muteUntil: null }]
        .sort((a, b) => a.channelId - b.channelId),
    );
    const u2 = get(2, MQTT);
    expect(u2.e).toBeNull();
    const m2 = JSON.parse(u2.m!) as Array<{ channelId: number; muteUntil: number | null }>;
    expect(m2).toContainEqual({ channelId: KEYED_X, muteUntil: FUTURE });
    expect(m2).toContainEqual({ channelId: 7, muteUntil: null });
    // A device source's prefs are untouched.
    expect(get(1, 'comp1')).toEqual({ e: JSON.stringify([3]), m: null });
  });

  it('copies read markers to each keyed index', () => {
    migration.up(db);
    const rows = db.prepare("SELECT conversation_key AS k, last_read_at AS t FROM conversation_read_state WHERE user_id = 1 AND source_id = ? ORDER BY k").all(MQTT) as Array<{ k: string; t: number }>;
    expect(rows.map((r) => r.k).sort()).toEqual(['3', String(KEYED_X), String(KEYED_Y)].sort());
    expect(rows.every((r) => r.t === 12345)).toBe(true);
  });

  it('crash-resume: rows already done but prefs not gives the same prefs', () => {
    const clean = setup();
    migration.up(clean);
    // Simulate a crash after step 3: rows are re-filed, prefs/read untouched.
    migration.up(db);
    db.exec('DELETE FROM conversation_read_state WHERE conversation_key <> \'3\'');
    for (const p of scenario.prefs) {
      db.prepare('UPDATE user_notification_preferences SET enabled_channels = ?, muted_channels = ? WHERE user_id = ? AND source_id = ?')
        .run(p.enabledChannels, p.mutedChannels, p.userId, p.sourceId);
    }
    migration.up(db);
    const read = (d: Database.Database) => JSON.stringify([
      d.prepare('SELECT user_id, source_id, enabled_channels, muted_channels FROM user_notification_preferences ORDER BY user_id, source_id').all(),
      d.prepare('SELECT user_id, conversation_key, last_read_at FROM conversation_read_state ORDER BY conversation_key').all(),
    ]);
    // Order inside the JSON lists may differ; compare normalised.
    const norm = (s: string) => JSON.stringify(JSON.parse(s), (_k, v) => (Array.isArray(v) ? [...v].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : v));
    const normPrefs = (d: Database.Database) => (d.prepare('SELECT user_id, source_id, enabled_channels AS e, muted_channels AS m FROM user_notification_preferences ORDER BY user_id, source_id').all() as Array<{ user_id: number; source_id: string; e: string | null; m: string | null }>)
      .map((r) => [r.user_id, r.source_id, r.e ? norm(r.e) : null, r.m ? norm(r.m) : null]);
    expect(normPrefs(db)).toEqual(normPrefs(clean));
    expect(read(db).includes(String(KEYED_X))).toBe(true);
  });

  it('does nothing when there is no MQTT source', () => {
    db.prepare("DELETE FROM sources WHERE type = 'meshcore_mqtt'").run();
    const before = JSON.stringify(db.prepare('SELECT * FROM meshcore_messages ORDER BY id').all());
    migration.up(db);
    expect(JSON.stringify(db.prepare('SELECT * FROM meshcore_messages ORDER BY id').all())).toBe(before);
  });
});

describe('Migration 228 — pure planners', () => {
  it('leaves a moved key unresolved (strict slot match)', () => {
    const bySlot = buildSlotKeys([{ id: 4, sourceId: 'comp1', psk: b64(SECRET_X), type: 'meshcore' }]);
    const msg = scenario.messages[0]; // encrypted with SECRET_X, filed at slot 3
    expect(planRefile(MQTT, msg, bySlot)).toEqual({ resolved: false });
  });

  it('does not fan out expired mutes', () => {
    const out = planPrefFanOut(
      [{ id: 1, sourceId: MQTT, enabledChannels: null, mutedChannels: JSON.stringify([{ channelId: 3, muteUntil: 5 }]) }],
      () => new Map([[3, [KEYED_X]]]),
      1000,
    );
    expect(out).toEqual([]);
  });

  it('later muteUntil wins when both rows mute the same keyed id', () => {
    const out = planPrefFanOut(
      [{
        id: 1, sourceId: MQTT, enabledChannels: null,
        mutedChannels: JSON.stringify([{ channelId: 3, muteUntil: null }, { channelId: KEYED_X, muteUntil: 9_999_999_999_999 }]),
      }],
      () => new Map([[3, [KEYED_X]]]),
      1000,
    );
    expect(JSON.parse(out[0].mutedChannels!)).toEqual([
      { channelId: 3, muteUntil: null },
      { channelId: KEYED_X, muteUntil: null },
    ]);
  });
});

describe('Migration 228 — inlined helpers match the live ones', () => {
  it('pskToHex, fingerprint and keyed index agree', () => {
    for (const psk of [b64(SECRET_X), SECRET_X, SECRET_A1.toUpperCase(), null, '']) {
      expect(migPskToHex(psk)).toBe(pskToHex(psk));
    }
    expect(migFingerprint(SECRET_X)).toBe(channelKeyFingerprint(SECRET_X));
    expect(migKeyedIndex(SECRET_X)).toBe(keyedChannelIndex(SECRET_X));
  });

  it('the message id formula matches frameChannelMessageId and the decoder hash format', () => {
    const hash = createHash('sha256').update(Buffer.from(SECRET_Y, 'hex')).digest('hex').slice(0, 2);
    // A frame the live decoder parses: header | path_len | hash | mac | ciphertext.
    const frame = '1500' + hash + 'aabb' + '00'.repeat(16);
    const decoded = decodeMeshCorePacket(frame)?.payload?.groupText;
    expect(decoded).toBeTruthy();
    expect(mqttMessageId(MQTT, decoded!.channelHash, 1_700_000_000, 'hello')).toBe(
      frameChannelMessageId('mqtt', MQTT, decoded!.channelHash, 1_700_000_000, 'hello'),
    );
    // Y's hash byte holds a letter, so a case mismatch would show here.
    expect(decoded!.channelHash).toBe(hash);
    expect(hash).toMatch(/[a-f]/);
  });
});
