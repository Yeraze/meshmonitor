/**
 * Tests for migration 238: default heartbeat for MeshCore Companion sources (#6437).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration, withCompanionHeartbeat } from './238_meshcore_companion_default_heartbeat.js';

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT, type TEXT NOT NULL, config TEXT NOT NULL)`);
  const ins = db.prepare('INSERT INTO sources (id, name, type, config) VALUES (?, ?, ?, ?)');
  ins.run('c-none', 'c', 'meshcore', JSON.stringify({ transport: 'usb', deviceType: 'companion', autoConnect: true }));
  ins.run('c-nodt', 'c', 'meshcore', JSON.stringify({ transport: 'tcp' }));
  ins.run('c-zero', 'c', 'meshcore', JSON.stringify({ deviceType: 'companion', heartbeatIntervalSeconds: 0 }));
  ins.run('c-30', 'c', 'meshcore', JSON.stringify({ deviceType: 'companion', heartbeatIntervalSeconds: 30 }));
  ins.run('r-none', 'r', 'meshcore', JSON.stringify({ deviceType: 'repeater' }));
  ins.run('t-none', 't', 'meshtastic_tcp', JSON.stringify({ host: 'h' }));
  ins.run('bad', 'b', 'meshcore', 'not json');
  return db;
}
const cfg = (db: Database.Database, id: string) =>
  (db.prepare('SELECT config FROM sources WHERE id = ?').get(id) as { config: string }).config;

describe('Migration 238', () => {
  it('adds 60 to a Companion with no stored value, keeping other keys', () => {
    const db = setup();
    migration.up(db);
    expect(JSON.parse(cfg(db, 'c-none'))).toEqual({ transport: 'usb', deviceType: 'companion', autoConnect: true, heartbeatIntervalSeconds: 60 });
    expect(JSON.parse(cfg(db, 'c-nodt')).heartbeatIntervalSeconds).toBe(60);
    db.close();
  });

  it('leaves explicit values, Repeaters, other types and bad JSON alone', () => {
    const db = setup();
    const before = Object.fromEntries(['c-zero', 'c-30', 'r-none', 't-none', 'bad'].map((id) => [id, cfg(db, id)]));
    migration.up(db);
    for (const [id, v] of Object.entries(before)) expect(cfg(db, id)).toBe(v);
    db.close();
  });

  it('is a no-op on re-run', () => {
    const db = setup();
    migration.up(db);
    const once = db.prepare('SELECT id, config FROM sources ORDER BY id').all();
    migration.up(db);
    expect(db.prepare('SELECT id, config FROM sources ORDER BY id').all()).toEqual(once);
    db.close();
  });

  it('withCompanionHeartbeat ignores non-object JSON', () => {
    expect(withCompanionHeartbeat('[]')).toBeNull();
    expect(withCompanionHeartbeat('null')).toBeNull();
  });
});
