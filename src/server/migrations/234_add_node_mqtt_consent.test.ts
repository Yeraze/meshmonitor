/**
 * Tests for migration 234: MQTT consent columns on `nodes` (#5156).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './234_add_node_mqtt_consent.js';

const COLUMNS = ['mqttOkToMqtt', 'mqttOkToMqttAt', 'rfDirectLastHeard'];

function createNodesTable(db: Database.Database): void {
  db.exec(`CREATE TABLE nodes (nodeNum INTEGER NOT NULL, sourceId TEXT NOT NULL, PRIMARY KEY (nodeNum, sourceId))`);
}

describe('Migration 234: node MQTT consent columns', () => {
  it('adds the three columns and is idempotent', () => {
    const db = new Database(':memory:');
    createNodesTable(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of COLUMNS) expect(cols).toContain(c);
    db.close();
  });

  it('existing rows read NULL (unknown consent, so nothing is hidden on upgrade)', () => {
    const db = new Database(':memory:');
    createNodesTable(db);
    db.prepare(`INSERT INTO nodes (nodeNum, sourceId) VALUES (1, 'a')`).run();
    migration.up(db);
    const row = db.prepare('SELECT mqttOkToMqtt, mqttOkToMqttAt, rfDirectLastHeard FROM nodes').get() as Record<string, unknown>;
    expect(row).toEqual({ mqttOkToMqtt: null, mqttOkToMqttAt: null, rfDirectLastHeard: null });
    db.close();
  });
});
