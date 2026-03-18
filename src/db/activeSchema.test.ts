import { describe, it, expect } from 'vitest';
import { buildActiveSchema } from './activeSchema.js';
import { nodesSqlite, nodesPostgres, nodesMysql } from './schema/nodes.js';
import { messagesSqlite, messagesPostgres, messagesMysql } from './schema/messages.js';

describe('buildActiveSchema', () => {
  it('returns SQLite tables for sqlite type', () => {
    const schema = buildActiveSchema('sqlite');
    expect(schema.nodes).toBe(nodesSqlite);
    expect(schema.messages).toBe(messagesSqlite);
  });

  it('returns PostgreSQL tables for postgres type', () => {
    const schema = buildActiveSchema('postgres');
    expect(schema.nodes).toBe(nodesPostgres);
    expect(schema.messages).toBe(messagesPostgres);
  });

  it('returns MySQL tables for mysql type', () => {
    const schema = buildActiveSchema('mysql');
    expect(schema.nodes).toBe(nodesMysql);
    expect(schema.messages).toBe(messagesMysql);
  });

  it('includes all table groups', () => {
    const schema = buildActiveSchema('sqlite');
    // Count should match total number of table groups across all schema files
    const keys = Object.keys(schema);
    expect(keys.length).toBeGreaterThanOrEqual(38); // 38+ table groups
  });

  it('returns frozen objects', () => {
    const schema = buildActiveSchema('sqlite');
    expect(Object.isFrozen(schema)).toBe(true);
  });

  it('throws for unknown database type', () => {
    expect(() => buildActiveSchema('invalid' as any)).toThrow('Unknown database type');
  });

  it('uses correct key names for commonly misnamed tables', () => {
    const schema = buildActiveSchema('sqlite');
    // These names were verified against actual schema exports - ensure no regressions
    expect(schema).toHaveProperty('neighborInfo');      // NOT 'neighbors'
    expect(schema).toHaveProperty('packetLog');          // NOT 'packets'
    expect(schema).toHaveProperty('userNotificationPreferences'); // NOT 'notificationPreferences'
    expect(schema).toHaveProperty('sessions');           // from auth.ts
    expect(schema).toHaveProperty('systemBackupHistory');
    expect(schema).toHaveProperty('userMapPreferences');
    expect(schema).toHaveProperty('solarEstimates');
    expect(schema).toHaveProperty('autoTracerouteNodes');
    expect(schema).toHaveProperty('autoTimeSyncNodes');
    expect(schema).toHaveProperty('autoTracerouteLog');
    expect(schema).toHaveProperty('autoKeyRepairState');
    expect(schema).toHaveProperty('autoKeyRepairLog');
    expect(schema).toHaveProperty('autoDistanceDeleteLog');
    expect(schema).toHaveProperty('geofenceCooldowns');
    expect(schema).toHaveProperty('newsCache');
    expect(schema).toHaveProperty('userNewsStatus');
  });

  it('returns different tables for each dialect', () => {
    const sqlite = buildActiveSchema('sqlite');
    const postgres = buildActiveSchema('postgres');
    const mysql = buildActiveSchema('mysql');
    // Each dialect should resolve to its own table object
    expect(sqlite.nodes).not.toBe(postgres.nodes);
    expect(postgres.nodes).not.toBe(mysql.nodes);
    expect(sqlite.nodes).not.toBe(mysql.nodes);
  });
});
