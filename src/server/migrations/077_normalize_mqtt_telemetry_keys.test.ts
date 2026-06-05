/**
 * Migration 077 — Normalize historical MQTT telemetry keys
 *
 * Validates that rows stored under dotted group-prefixed keys (the old MQTT
 * format, e.g. `environment.barometricPressure`) are rewritten to the canonical
 * short keys serial ingestion uses (`pressure`), with units backfilled, while
 * serial rows and unmapped groups are left untouched. Implements #3314.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './077_normalize_mqtt_telemetry_keys.js';

function createSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nodeId TEXT NOT NULL,
      nodeNum INTEGER NOT NULL,
      telemetryType TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      value REAL NOT NULL,
      unit TEXT,
      createdAt INTEGER NOT NULL,
      packetTimestamp INTEGER,
      packetId INTEGER,
      channel INTEGER,
      precisionBits INTEGER,
      gpsAccuracy INTEGER,
      sourceId TEXT
    );
  `);
}

function insert(db: Database.Database, telemetryType: string, value: number, unit: string | null) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO telemetry (nodeId, nodeNum, telemetryType, timestamp, value, unit, createdAt, sourceId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('!deadbeef', 0xdeadbeef, telemetryType, now, value, unit, now, 'src-1');
}

function types(db: Database.Database): Array<{ telemetryType: string; unit: string | null }> {
  return db.prepare('SELECT telemetryType, unit FROM telemetry ORDER BY id').all() as any;
}

describe('Migration 077 — normalize MQTT telemetry keys', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('rewrites dotted environment keys to canonical keys with units', () => {
    insert(db, 'environment.temperature', 21.5, null);
    insert(db, 'environment.barometricPressure', 1013.2, null);
    insert(db, 'environment.relativeHumidity', 55, null);
    insert(db, 'environment.voltage', 4.1, null);

    migration.up(db);

    const rows = types(db);
    const byType = Object.fromEntries(rows.map((r) => [r.telemetryType, r.unit]));
    expect(byType['temperature']).toBe('°C');
    expect(byType['pressure']).toBe('hPa');
    expect(byType['humidity']).toBe('%');
    expect(byType['envVoltage']).toBe('V');
    // No dotted environment keys remain.
    expect(rows.some((r) => r.telemetryType.startsWith('environment.'))).toBe(false);
  });

  it('rewrites dotted device / air-quality / power keys', () => {
    insert(db, 'device.batteryLevel', 90, null);
    insert(db, 'airQuality.pm25Standard', 12, null);
    insert(db, 'power.ch1Voltage', 3.7, null);

    migration.up(db);

    const byType = Object.fromEntries(types(db).map((r) => [r.telemetryType, r.unit]));
    expect(byType['batteryLevel']).toBe('%');
    expect(byType['pm25Standard']).toBe('µg/m³');
    expect(byType['ch1Voltage']).toBe('V');
  });

  it('leaves serial (already-canonical) rows and unmapped groups untouched', () => {
    insert(db, 'temperature', 20, '°C'); // serial row
    insert(db, 'health.temperature', 36.8, null); // unmapped group — must stay dotted

    migration.up(db);

    const rows = types(db);
    expect(rows.find((r) => r.telemetryType === 'temperature')).toMatchObject({ unit: '°C' });
    expect(rows.find((r) => r.telemetryType === 'health.temperature')).toBeDefined();
  });

  it('is idempotent — a second run changes nothing', () => {
    insert(db, 'environment.temperature', 21.5, null);
    migration.up(db);
    const after1 = types(db);
    migration.up(db);
    const after2 = types(db);
    expect(after2).toEqual(after1);
    expect(after1.find((r) => r.telemetryType === 'temperature')).toBeDefined();
  });

  it('merges MQTT and serial rows under the same canonical key (unifies graphs)', () => {
    insert(db, 'temperature', 20, '°C'); // serial
    insert(db, 'environment.temperature', 21, null); // MQTT

    migration.up(db);

    const tempRows = types(db).filter((r) => r.telemetryType === 'temperature');
    expect(tempRows).toHaveLength(2);
  });
});
