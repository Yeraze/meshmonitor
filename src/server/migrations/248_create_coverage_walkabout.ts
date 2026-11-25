/**
 * Migration 248: Walkabout Coverage tables (#5891 Phase 1). PER-SOURCE.
 * Sessions, GPS samples and credited receptions. No foreign keys (as
 * `coverage_receptions`); the repository deletes children in order.
 * Idempotent on every backend. Spec: WALKABOUT_P1_SPEC.md §2.2.
 */
import type { Database } from 'better-sqlite3';
import { createTableIfMissingMysql } from './helpers.js';

const SESS = 'coverage_walkabout_sessions';
const SMP = 'coverage_walkabout_samples';
const RX = 'coverage_walkabout_receptions';

export const migration = {
  up: (db: Database): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${SESS} (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        name TEXT,
        startedAt INTEGER NOT NULL,
        endedAt INTEGER,
        endReason TEXT,
        startedBy INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS cov_wk_sess_source_started_idx ON ${SESS}(sourceId, startedAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS cov_wk_sess_ended_idx ON ${SESS}(endedAt)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${SMP} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        sourceId TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        accuracyM REAL NOT NULL,
        deviceFixAt INTEGER NOT NULL,
        fixAt INTEGER NOT NULL,
        receivedAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS cov_wk_smp_session_fix_idx ON ${SMP}(sessionId, fixAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS cov_wk_smp_source_idx ON ${SMP}(sourceId)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${RX} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        sourceId TEXT NOT NULL,
        protocol TEXT NOT NULL,
        creditedKey TEXT NOT NULL,
        creditedNodeNum INTEGER,
        creditKind TEXT NOT NULL,
        hopsAway INTEGER,
        packetKey TEXT NOT NULL,
        snr REAL,
        rssi INTEGER,
        heardAt INTEGER NOT NULL,
        sampleId INTEGER,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        accuracyM REAL NOT NULL,
        sampleAgeMs INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS cov_wk_rx_uniq ON ${RX}(sessionId, packetKey, creditedKey)`);
    db.exec(`CREATE INDEX IF NOT EXISTS cov_wk_rx_session_heard_idx ON ${RX}(sessionId, heardAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS cov_wk_rx_source_idx ON ${RX}(sourceId)`);
  },
};

export async function runMigration248Postgres(client: import('pg').PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${SESS} (
      "id" TEXT PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "name" TEXT,
      "startedAt" BIGINT NOT NULL,
      "endedAt" BIGINT,
      "endReason" TEXT,
      "startedBy" INTEGER,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS cov_wk_sess_source_started_idx ON ${SESS}("sourceId", "startedAt")`);
  await client.query(`CREATE INDEX IF NOT EXISTS cov_wk_sess_ended_idx ON ${SESS}("endedAt")`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${SMP} (
      "id" SERIAL PRIMARY KEY,
      "sessionId" TEXT NOT NULL,
      "sourceId" TEXT NOT NULL,
      "latitude" DOUBLE PRECISION NOT NULL,
      "longitude" DOUBLE PRECISION NOT NULL,
      "accuracyM" REAL NOT NULL,
      "deviceFixAt" BIGINT NOT NULL,
      "fixAt" BIGINT NOT NULL,
      "receivedAt" BIGINT NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS cov_wk_smp_session_fix_idx ON ${SMP}("sessionId", "fixAt")`);
  await client.query(`CREATE INDEX IF NOT EXISTS cov_wk_smp_source_idx ON ${SMP}("sourceId")`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${RX} (
      "id" SERIAL PRIMARY KEY,
      "sessionId" TEXT NOT NULL,
      "sourceId" TEXT NOT NULL,
      "protocol" TEXT NOT NULL,
      "creditedKey" TEXT NOT NULL,
      "creditedNodeNum" BIGINT,
      "creditKind" TEXT NOT NULL,
      "hopsAway" INTEGER,
      "packetKey" TEXT NOT NULL,
      "snr" REAL,
      "rssi" INTEGER,
      "heardAt" BIGINT NOT NULL,
      "sampleId" INTEGER,
      "latitude" DOUBLE PRECISION NOT NULL,
      "longitude" DOUBLE PRECISION NOT NULL,
      "accuracyM" REAL NOT NULL,
      "sampleAgeMs" INTEGER NOT NULL
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS cov_wk_rx_uniq ON ${RX}("sessionId", "packetKey", "creditedKey")`);
  await client.query(`CREATE INDEX IF NOT EXISTS cov_wk_rx_session_heard_idx ON ${RX}("sessionId", "heardAt")`);
  await client.query(`CREATE INDEX IF NOT EXISTS cov_wk_rx_source_idx ON ${RX}("sourceId")`);
}

export async function runMigration248Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  await createTableIfMissingMysql(pool, SESS, `
    CREATE TABLE ${SESS} (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      sourceId VARCHAR(64) NOT NULL,
      name VARCHAR(120),
      startedAt BIGINT NOT NULL,
      endedAt BIGINT,
      endReason VARCHAR(16),
      startedBy INT,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL,
      INDEX cov_wk_sess_source_started_idx (sourceId, startedAt),
      INDEX cov_wk_sess_ended_idx (endedAt)
    )
  `);
  await createTableIfMissingMysql(pool, SMP, `
    CREATE TABLE ${SMP} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sessionId VARCHAR(36) NOT NULL,
      sourceId VARCHAR(64) NOT NULL,
      latitude DOUBLE NOT NULL,
      longitude DOUBLE NOT NULL,
      accuracyM DOUBLE NOT NULL,
      deviceFixAt BIGINT NOT NULL,
      fixAt BIGINT NOT NULL,
      receivedAt BIGINT NOT NULL,
      INDEX cov_wk_smp_session_fix_idx (sessionId, fixAt),
      INDEX cov_wk_smp_source_idx (sourceId)
    )
  `);
  await createTableIfMissingMysql(pool, RX, `
    CREATE TABLE ${RX} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sessionId VARCHAR(36) NOT NULL,
      sourceId VARCHAR(64) NOT NULL,
      protocol VARCHAR(16) NOT NULL,
      creditedKey VARCHAR(80) NOT NULL,
      creditedNodeNum BIGINT,
      creditKind VARCHAR(8) NOT NULL,
      hopsAway INT,
      packetKey VARCHAR(80) NOT NULL,
      snr DOUBLE,
      rssi INT,
      heardAt BIGINT NOT NULL,
      sampleId INT,
      latitude DOUBLE NOT NULL,
      longitude DOUBLE NOT NULL,
      accuracyM DOUBLE NOT NULL,
      sampleAgeMs INT NOT NULL,
      UNIQUE KEY cov_wk_rx_uniq (sessionId, packetKey, creditedKey),
      INDEX cov_wk_rx_session_heard_idx (sessionId, heardAt),
      INDEX cov_wk_rx_source_idx (sourceId)
    )
  `);
}
