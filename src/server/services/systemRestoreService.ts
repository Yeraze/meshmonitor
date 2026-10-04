/* eslint-disable no-restricted-syntax -- TODO(remediation 6.3): retire raw SQL identifier interpolation in favor of typed Drizzle selectors per BACKUP_TABLES, then remove this disable. */
/**
 * System Restore Service
 * Restores complete database from JSON backup with migration support
 * Supports SQLite, PostgreSQL, and MySQL backends
 *
 * CRITICAL: This service implements the restore safety process from ARCHITECTURE_LESSONS.md:
 * 1. Validate backup integrity
 * 2. Check schema compatibility
 * 3. Stop all background tasks (handled by caller)
 * 4. Clear in-memory caches
 * 5. Restore database atomically
 * 6. Migrate schema if needed
 * 7. Restart background tasks (handled by caller)
 * 8. Mark all node states as "unknown"
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { systemBackupService } from './systemBackupService.js';
import { BACKUP_IDENTIFIER_PATTERN, planRestoreTables } from './systemBackupTables.js';
import { readTableFileSync, type BackupRow } from './systemBackupIo.js';
import { getDatabaseConfig } from '../../db/index.js';
import { resetPostgresSequences } from '../migrations/postgresSequences.js';
import { getMeshCoreObserverKeyStore } from './meshcoreObserverKeyStore.js';
import { getMeshCoreObserverCredentialStore } from './meshcoreObserverCredentialStore.js';
import { getSourcePkiKeyStore } from './sourcePkiKeyStore.js';
import { getMeshCoreCredentialStore } from './meshcoreCredentialStore.js';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';

const SYSTEM_BACKUP_DIR = process.env.SYSTEM_BACKUP_DIR || '/data/system-backups';
const RESTORE_MARKER_FILE = '/data/.restore-completed';

/**
 * PostgreSQL and MySQL cap a statement at 65,535 bind parameters. Rows go in
 * as multi-row INSERTs sized to stay well under it.
 */
const MAX_INSERT_PARAMS = 30_000;
const MAX_INSERT_ROWS = 500;

/**
 * Restored secrets the current SESSION_SECRET cannot open, by kind. Ids only:
 * a source id, or `sourceId/publicKey-prefix` for a MeshCore node.
 */
export interface UnreadableSecrets {
  unreadableObserverKeys: string[];
  unreadablePkiKeys: string[];
  unreadableObserverCredentials: string[];
  unreadableMeshcoreNodeCredentials: string[];
}

interface RestoreResult {
  success: boolean;
  message: string;
  tablesRestored?: number;
  rowsRestored?: number;
  migrationRequired?: boolean;
  errors?: string[];
}

class SystemRestoreService {
  /**
   * Promise that resolves when restore is complete (or immediately if no restore needed)
   * Other services (like database.ts) should await this before creating default users
   */
  private restoreCompletePromise: Promise<void>;
  private restoreCompleteResolve!: () => void;
  private restoreInProgress = false;

  constructor() {
    // Initialize the promise - will be resolved after restore check completes
    this.restoreCompletePromise = new Promise<void>((resolve) => {
      this.restoreCompleteResolve = resolve;
    });
  }

  /**
   * Mark that restore has started - called from server.ts before restore begins
   */
  markRestoreStarted(): void {
    this.restoreInProgress = true;
    logger.debug('[RestoreService] Restore marked as started');
  }

  /**
   * Mark that restore is complete (or was skipped) - called from server.ts
   * This resolves the promise that other services are waiting on
   */
  markRestoreComplete(): void {
    this.restoreInProgress = false;
    this.restoreCompleteResolve();
    logger.debug('[RestoreService] Restore marked as complete');
  }

  /**
   * Wait for any pending restore to complete
   * Other services (like database.ts createAdminIfNeeded) should call this
   * to ensure they don't race with the restore process
   */
  async waitForRestoreComplete(): Promise<void> {
    return this.restoreCompletePromise;
  }

  /**
   * Check if restore is currently in progress
   */
  isRestoreInProgress(): boolean {
    return this.restoreInProgress;
  }

  /**
   * Restore system from backup directory
   * This should ONLY be called during bootstrap (before services start)
   */
  async restoreFromBackup(dirname: string): Promise<RestoreResult> {
    logger.info(`🔄 Starting system restore from backup: ${dirname}`);

    const startTime = Date.now();
    let totalRowsRestored = 0;
    let tablesRestored = 0;

    try {
      // Phase 1: Validate backup
      logger.debug('Phase 1: Validating backup integrity...');
      const validation = await systemBackupService.validateBackup(dirname);

      if (!validation.valid) {
        logger.error('❌ Backup validation failed:', validation.errors);
        return {
          success: false,
          message: 'Backup validation failed',
          errors: validation.errors
        };
      }

      logger.debug('✅ Backup validation passed');

      // Phase 2: Load metadata and check compatibility
      logger.debug('Phase 2: Checking schema compatibility...');
      const metadata = await systemBackupService.getBackupMetadata(dirname);

      if (!metadata) {
        return {
          success: false,
          message: 'Failed to load backup metadata'
        };
      }

      const currentSchemaVersion = 21; // Current schema version
      const backupSchemaVersion = metadata.schemaVersion;
      const migrationRequired = backupSchemaVersion < currentSchemaVersion;

      logger.debug(`Schema versions: backup=${backupSchemaVersion}, current=${currentSchemaVersion}`);

      if (migrationRequired) {
        logger.info(`⚠️  Migration will be required (${backupSchemaVersion} → ${currentSchemaVersion})`);
      }

      // Phase 3: Clear in-memory caches
      logger.debug('Phase 3: Clearing in-memory caches...');
      // Note: This is handled by the fact that we're in bootstrap mode
      // before services are initialized

      // Phase 4: Restore database atomically
      logger.debug('Phase 4: Restoring database...');
      const backupPath = path.join(SYSTEM_BACKUP_DIR, dirname);
      const dbConfig = getDatabaseConfig();

      if (dbConfig.type === 'postgres' && dbConfig.postgresUrl) {
        // PostgreSQL: use async transaction
        const result = await this.restorePostgres(backupPath, metadata.tables, dbConfig.postgresUrl);
        totalRowsRestored = result.rowsRestored;
        tablesRestored = result.tablesRestored;
      } else if (dbConfig.type === 'mysql' && dbConfig.mysqlUrl) {
        // MySQL: use async transaction
        const result = await this.restoreMySQL(backupPath, metadata.tables, dbConfig.mysqlUrl);
        totalRowsRestored = result.rowsRestored;
        tablesRestored = result.tablesRestored;
      } else {
        // SQLite: use synchronous transaction
        const result = this.restoreSQLite(backupPath, metadata.tables);
        totalRowsRestored = result.rowsRestored;
        tablesRestored = result.tablesRestored;
      }

      // Phase 4b: say so when a restored key or credential cannot be read
      // under this install's SESSION_SECRET (#5596).
      const unreadable = await this.findUnreadableSecrets(new Set(planRestoreTables(metadata.tables).tables));

      // Phase 5: Run schema migrations if needed
      if (migrationRequired) {
        logger.debug('Phase 5: Running schema migrations...');
        // Migrations will be run automatically when database service initializes
        // Just log that it will happen
        logger.info(`✅ Schema migration will run automatically (${backupSchemaVersion} → ${currentSchemaVersion})`);
      }

      // Phase 6: Mark all node states as "unknown" per ARCHITECTURE_LESSONS.md
      logger.debug('Phase 6: Marking node states as unknown...');
      // This is implicit - on restart, all nodes will need to be re-queried
      // We could add an explicit flag if needed in the future

      // Audit log (after schema migration is complete)
      await databaseService.auditLogAsync(
        null, // System action during restore
        'system_restore_completed',
        'system_backup',
        JSON.stringify({
          dirname,
          tablesRestored,
          rowsRestored: totalRowsRestored,
          backupVersion: metadata.meshmonitorVersion,
          backupSchemaVersion,
          currentSchemaVersion,
          migrationRequired,
          // Ids only. Present so the audit trail records which keys and
          // credentials need attention after this restore.
          ...Object.fromEntries(Object.entries(unreadable).filter(([, ids]) => ids.length > 0))
        }),
        null // No IP address during startup
      );

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info(`✅ System restore completed: ${tablesRestored} tables, ${totalRowsRestored} rows in ${duration}s`);

      // Write restore marker to prevent accidental re-restoration
      try {
        fs.writeFileSync(RESTORE_MARKER_FILE, dirname, 'utf8');
        logger.info(`📝 Restore marker written to: ${RESTORE_MARKER_FILE}`);
        logger.info('ℹ️  This prevents accidental re-restore on next restart');
        logger.info('ℹ️  To restore again, remove RESTORE_FROM_BACKUP from environment or delete the marker file');
      } catch (error) {
        logger.warn('⚠️  Failed to write restore marker file:', error);
        logger.warn('⚠️  Re-restore protection may not work properly');
      }

      return {
        success: true,
        message: 'System restore completed successfully',
        tablesRestored,
        rowsRestored: totalRowsRestored,
        migrationRequired
      };

    } catch (error) {
      logger.error('❌ System restore failed:', error);

      // Audit log failure
      try {
        await databaseService.auditLogAsync(
          null, // System action during restore
          'system_restore_failed',
          'system_backup',
          JSON.stringify({
            dirname,
            error: error instanceof Error ? error.message : String(error)
          }),
          null // No IP address during startup
        );
      } catch (auditError) {
        logger.error('Failed to log restore failure to audit log:', auditError);
      }

      return {
        success: false,
        message: `System restore failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Find restored keys and credentials the current SESSION_SECRET cannot
   * decrypt, and warn about each kind (#5596).
   *
   * Four things in a backup are AES-256-GCM envelopes keyed from
   * SESSION_SECRET: Analyzer Observer signing keys, Observer broker
   * credentials, per-source PKI private keys, and the repeater/room passwords
   * saved on MeshCore nodes. A backup restored onto an install with a
   * different secret brings the rows back intact but unreadable. Restore does
   * what each store already does for a rotated secret: it KEEPS the row.
   * Nothing is deleted or rewritten, so putting the original SESSION_SECRET
   * back makes every one usable again; until then each store reports
   * `key_rotated` and its feature asks for the secret to be entered again.
   *
   * Reads only each envelope's version and key fingerprint — it never decrypts
   * and never logs key material. Each kind is checked on its own and
   * best-effort: a failure here must not turn a good restore into a failed one.
   */
  private async findUnreadableSecrets(restored: ReadonlySet<string>): Promise<UnreadableSecrets> {
    const check = async (table: string, label: string, find: () => Promise<string[]>): Promise<string[]> => {
      if (!restored.has(table)) return [];
      try {
        return await find();
      } catch (error) {
        logger.warn(`⚠️  Could not check restored ${label}:`, error);
        return [];
      }
    };

    const unreadableObserverKeys = await check('meshcore_observer_keys', 'Analyzer Observer keys', async () => {
      const store = getMeshCoreObserverKeyStore();
      const out: string[] = [];
      for (const sourceId of await databaseService.meshcoreObserverKeys.listSourceIds()) {
        if ((await store.status(sourceId)).keyRotated) out.push(sourceId);
      }
      return out;
    });
    if (unreadableObserverKeys.length > 0) {
      logger.warn(
        `⚠️  Restored ${unreadableObserverKeys.length} Analyzer Observer signing key(s) that the current ` +
          `SESSION_SECRET cannot decrypt (sources: ${unreadableObserverKeys.join(', ')}). The rows were kept. ` +
          'Set SESSION_SECRET to the value the backup was made under, or re-import the key for ' +
          'each source; until then the Observer will not publish for them.'
      );
    }

    const unreadablePkiKeys = await check('source_pki_keys', 'PKI private keys', async () => {
      const store = getSourcePkiKeyStore();
      const out: string[] = [];
      for (const sourceId of await databaseService.sourcePkiKeys.listSourceIds()) {
        if (await store.isKeyRotated(sourceId)) out.push(sourceId);
      }
      return out;
    });
    if (unreadablePkiKeys.length > 0) {
      logger.warn(
        `⚠️  Restored ${unreadablePkiKeys.length} PKI private key(s) that the current SESSION_SECRET cannot ` +
          `decrypt (sources: ${unreadablePkiKeys.join(', ')}). The rows were kept. Set SESSION_SECRET to the ` +
          'value the backup was made under, or enter the key again for each source; until then encrypted ' +
          'direct messages to those nodes stay undecrypted.'
      );
    }

    const unreadableObserverCredentials = await check(
      'meshcore_observer_credentials',
      'Analyzer Observer broker credentials',
      async () => {
        const store = getMeshCoreObserverCredentialStore();
        const out: string[] = [];
        for (const sourceId of await databaseService.meshcoreObserverCredentials.listSourceIds()) {
          if ((await store.status(sourceId)).keyRotated) out.push(sourceId);
        }
        return out;
      },
    );
    if (unreadableObserverCredentials.length > 0) {
      logger.warn(
        `⚠️  Restored Analyzer Observer broker credentials for ${unreadableObserverCredentials.length} ` +
          `source(s) that the current SESSION_SECRET cannot decrypt (sources: ` +
          `${unreadableObserverCredentials.join(', ')}). The rows were kept. Set SESSION_SECRET to the value ` +
          'the backup was made under, or enter the broker password again; until then the Observer cannot ' +
          'log in to those brokers.'
      );
    }

    const unreadableMeshcoreNodeCredentials = await check(
      'meshcore_nodes',
      'MeshCore saved passwords',
      async () =>
        (await getMeshCoreCredentialStore().listRotated()).map(
          (entry) => `${entry.sourceId}/${entry.publicKey.substring(0, 8)}`,
        ),
    );
    if (unreadableMeshcoreNodeCredentials.length > 0) {
      logger.warn(
        `⚠️  Restored ${unreadableMeshcoreNodeCredentials.length} saved MeshCore repeater password(s) that the ` +
          `current SESSION_SECRET cannot decrypt (${unreadableMeshcoreNodeCredentials.join(', ')}). The rows ` +
          'were kept. Set SESSION_SECRET to the value the backup was made under, or enter each password again.'
      );
    }

    return {
      unreadableObserverKeys,
      unreadablePkiKeys,
      unreadableObserverCredentials,
      unreadableMeshcoreNodeCredentials,
    };
  }

  /**
   * Check if a restore is needed based on RESTORE_FROM_BACKUP environment variable
   */
  shouldRestore(): string | null {
    const restoreFrom = process.env.RESTORE_FROM_BACKUP;

    if (!restoreFrom) {
      return null;
    }

    logger.info(`🔍 RESTORE_FROM_BACKUP environment variable detected: ${restoreFrom}`);

    // Check if this backup has already been restored (safety mechanism)
    if (fs.existsSync(RESTORE_MARKER_FILE)) {
      try {
        const lastRestored = fs.readFileSync(RESTORE_MARKER_FILE, 'utf8').trim();
        if (lastRestored === restoreFrom) {
          logger.warn('⚠️  ========================================');
          logger.warn('⚠️  RESTORE ALREADY COMPLETED');
          logger.warn('⚠️  ========================================');
          logger.warn(`⚠️  Backup '${restoreFrom}' was already restored on a previous startup.`);
          logger.warn('⚠️  Skipping restore to prevent data loss.');
          logger.warn('⚠️  ');
          logger.warn('⚠️  To restore again:');
          logger.warn('⚠️  1. Remove the file: /data/.restore-completed');
          logger.warn('⚠️  2. Restart the container');
          logger.warn('⚠️  ');
          logger.warn('⚠️  Or to restore a different backup:');
          logger.warn('⚠️  1. Change RESTORE_FROM_BACKUP to a different backup name');
          logger.warn('⚠️  2. Restart the container');
          logger.warn('⚠️  ========================================');
          return null;
        } else {
          logger.info(`ℹ️  Previous restore was from: ${lastRestored}`);
          logger.info(`ℹ️  Requested restore is from: ${restoreFrom}`);
          logger.info('ℹ️  Different backup requested - proceeding with restore...');
        }
      } catch (_error) {
        logger.warn('⚠️  Could not read restore marker file, proceeding with restore...');
      }
    }

    // Check if backup exists
    const backupPath = path.join(SYSTEM_BACKUP_DIR, restoreFrom);
    if (!fs.existsSync(backupPath)) {
      logger.error(`❌ Backup directory not found: ${backupPath}`);
      throw new Error(`Backup directory not found: ${restoreFrom}`);
    }

    // Check if metadata exists
    const metadataPath = path.join(backupPath, 'metadata.json');
    if (!fs.existsSync(metadataPath)) {
      logger.error(`❌ Backup metadata not found: ${metadataPath}`);
      throw new Error(`Backup metadata not found in: ${restoreFrom}`);
    }

    return restoreFrom;
  }

  /**
   * Validate that restore can proceed
   */
  async canRestore(dirname: string): Promise<{ can: boolean; reason?: string }> {
    try {
      // Check if backup exists
      const backupPath = path.join(SYSTEM_BACKUP_DIR, dirname);
      if (!fs.existsSync(backupPath)) {
        return { can: false, reason: 'Backup directory not found' };
      }

      // Validate backup integrity
      const validation = await systemBackupService.validateBackup(dirname);
      if (!validation.valid) {
        return {
          can: false,
          reason: `Backup validation failed: ${validation.errors.join(', ')}`
        };
      }

      // Check metadata
      const metadata = await systemBackupService.getBackupMetadata(dirname);
      if (!metadata) {
        return { can: false, reason: 'Failed to load backup metadata' };
      }

      // Check schema version compatibility
      const currentSchemaVersion = 21;
      if (metadata.schemaVersion > currentSchemaVersion) {
        return {
          can: false,
          reason: `Backup schema version (${metadata.schemaVersion}) is newer than current version (${currentSchemaVersion}). Cannot restore from future version.`
        };
      }

      return { can: true };

    } catch (error) {
      return {
        can: false,
        reason: `Restore validation error: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * The tables to restore, in restore order.
   *
   * Table names from a backup's metadata.json are interpolated into SQL and
   * into file paths, so a crafted backup could otherwise inject statements.
   * Only names on the BACKUP_TABLES allowlist are used, on every backend; any
   * other name is logged and skipped (SQL/Drizzle audit MEDIUM-3).
   *
   * The order is BACKUP_TABLES order, not the file's: parents are cleared and
   * refilled before their children (see systemBackupTables.ts).
   */
  private allowedTables(tables: string[]): string[] {
    const plan = planRestoreTables(tables);
    for (const name of plan.skipped) {
      logger.warn(`⚠️  Skipping table not in backup allowlist: ${name}`);
    }
    return plan.tables;
  }

  /**
   * The column list for a table's INSERT, taken from the first row of its
   * file. Column names are interpolated into the statement, so anything that
   * is not a plain SQL identifier is rejected, which rolls the restore back.
   */
  private insertColumns(tableName: string, row: BackupRow): string[] {
    const columns = Object.keys(row);
    for (const col of columns) {
      if (!BACKUP_IDENTIFIER_PATTERN.test(col)) {
        throw new Error(`Invalid column name in backup for table ${tableName}: ${col}`);
      }
    }
    return columns;
  }

  /**
   * Restore database using SQLite (synchronous transaction)
   */
  private restoreSQLite(backupPath: string, tables: string[]): { rowsRestored: number; tablesRestored: number } {
    const db = databaseService.db;
    let totalRowsRestored = 0;
    let tablesRestored = 0;

    const allowed = this.allowedTables(tables);

    const transaction = db.transaction(() => {
      for (const tableName of allowed) {
        try {
          const tableFile = path.join(backupPath, `${tableName}.json`);

          if (!fs.existsSync(tableFile)) {
            logger.warn(`⚠️  Skipping missing table: ${tableName}`);
            continue;
          }

          // Clear existing table data
          db.prepare(`DELETE FROM ${tableName}`).run();

          // Insert backup data, one row at a time off the file.
          let columns: string[] | null = null;
          let stmt: { run: (...values: unknown[]) => unknown } | null = null;
          let rows = 0;
          for (const row of readTableFileSync(tableFile)) {
            if (!columns || !stmt) {
              columns = this.insertColumns(tableName, row);
              const placeholders = columns.map(() => '?').join(', ');
              stmt = db.prepare<unknown[]>(
                `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`
              );
            }
            stmt.run(...columns.map(col => toSqliteValue(row[col])));
            rows++;
          }

          totalRowsRestored += rows;
          tablesRestored++;
          logger.debug(`  ✅ Restored ${tableName}: ${rows} rows`);

        } catch (error) {
          logger.error(`  ❌ Failed to restore table ${tableName}:`, error);
          throw error; // Transaction will rollback
        }
      }
    });

    // Execute transaction
    transaction();

    return { rowsRestored: totalRowsRestored, tablesRestored };
  }

  /**
   * Restore database using PostgreSQL (async transaction)
   */
  private async restorePostgres(backupPath: string, tables: string[], connectionString: string): Promise<{ rowsRestored: number; tablesRestored: number }> {
    const allowed = this.allowedTables(tables);
    const pool = new Pool({ connectionString });
    const client = await pool.connect();
    let totalRowsRestored = 0;
    let tablesRestored = 0;

    try {
      await client.query('BEGIN');

      for (const tableName of allowed) {
        try {
          const tableFile = path.join(backupPath, `${tableName}.json`);

          if (!fs.existsSync(tableFile)) {
            logger.warn(`⚠️  Skipping missing table file: ${tableName}`);
            continue;
          }

          // Check if table exists in PostgreSQL
          const tableExists = await client.query(
            `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1)`,
            [tableName]
          );
          if (!tableExists.rows[0].exists) {
            logger.warn(`⚠️  Skipping table not in database: ${tableName}`);
            continue;
          }

          // Clear existing table data (quote table name for case-sensitivity)
          await client.query(`DELETE FROM "${tableName}"`);

          // Insert backup data in multi-row statements, streamed off the file.
          let columns: string[] | null = null;
          let quotedColumns = '';
          let rows = 0;
          let batchRows = MAX_INSERT_ROWS;
          const flush = async (batch: BackupRow[]): Promise<void> => {
            if (batch.length === 0 || !columns) return;
            const cols = columns;
            // PostgreSQL uses $1, $2, etc. for placeholders
            const tuples = batch
              .map((_, r) => `(${cols.map((__, c) => `$${r * cols.length + c + 1}`).join(', ')})`)
              .join(', ');
            const values = batch.flatMap(row => cols.map(col => row[col] ?? null));
            // OVERRIDING SYSTEM VALUE: several tables declare `id` as GENERATED
            // ALWAYS AS IDENTITY, which refuses an explicit id without it. The
            // clause is a no-op for every other table.
            await client.query(
              `INSERT INTO "${tableName}" (${quotedColumns}) OVERRIDING SYSTEM VALUE VALUES ${tuples}`,
              values
            );
            rows += batch.length;
          };

          let pending: BackupRow[] = [];
          for (const row of readTableFileSync(tableFile)) {
            if (!columns) {
              columns = this.insertColumns(tableName, row);
              // Quote column names to preserve case-sensitivity
              quotedColumns = columns.map(c => `"${c}"`).join(', ');
              batchRows = insertBatchRows(columns.length);
            }
            pending.push(row);
            if (pending.length >= batchRows) {
              await flush(pending);
              pending = [];
            }
          }
          await flush(pending);

          totalRowsRestored += rows;
          tablesRestored++;
          logger.debug(`  ✅ Restored ${tableName}: ${rows} rows`);

        } catch (error) {
          logger.error(`  ❌ Failed to restore table ${tableName}:`, error);
          throw error; // Will trigger rollback
        }
      }

      // The INSERTs above carry each row's original id, which never advances
      // a SERIAL/IDENTITY sequence. Move the sequences past the restored ids
      // on the same client, after the last INSERT and before COMMIT: a
      // failure here rolls the whole restore back. (setval itself is not
      // undone by a later ROLLBACK, which is harmless: it only moves
      // forward.) Without this the next id-less INSERT collides, and
      // insertIgnore's onConflictDoNothing() silently drops the row.
      const sequences = await resetPostgresSequences(client);
      logger.info(
        `🔄 PostgreSQL sequences: advanced ${sequences.advanced} of ${sequences.checked} past restored ids`
      );

      await client.query('COMMIT');
      return { rowsRestored: totalRowsRestored, tablesRestored };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }

  /**
   * Restore database using MySQL (async transaction)
   */
  private async restoreMySQL(backupPath: string, tables: string[], connectionString: string): Promise<{ rowsRestored: number; tablesRestored: number }> {
    const allowed = this.allowedTables(tables);

    // Parse the connection string
    const parsed = this.parseMySQLUrl(connectionString);
    if (!parsed) {
      throw new Error('Invalid MySQL connection string');
    }

    const pool = mysql.createPool({
      host: parsed.host,
      port: parsed.port,
      user: parsed.user,
      password: parsed.password,
      database: parsed.database,
      connectionLimit: 1,
    });

    const connection = await pool.getConnection();
    let totalRowsRestored = 0;
    let tablesRestored = 0;

    try {
      await connection.beginTransaction();

      for (const tableName of allowed) {
        try {
          const tableFile = path.join(backupPath, `${tableName}.json`);

          if (!fs.existsSync(tableFile)) {
            logger.warn(`⚠️  Skipping missing table file: ${tableName}`);
            continue;
          }

          // Check if table exists in MySQL
          const [tableCheck] = await connection.query(
            `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
            [parsed.database, tableName]
          );
          const tableExists = (tableCheck as any[])[0]?.cnt > 0;
          if (!tableExists) {
            logger.warn(`⚠️  Skipping table not in database: ${tableName}`);
            continue;
          }

          // Clear existing table data (use backticks for MySQL identifiers)
          await connection.execute(`DELETE FROM \`${tableName}\``);

          // Insert backup data in multi-row statements, streamed off the file.
          let columns: string[] | null = null;
          let quotedColumns = '';
          let rows = 0;
          let batchRows = MAX_INSERT_ROWS;
          const flush = async (batch: BackupRow[]): Promise<void> => {
            if (batch.length === 0 || !columns) return;
            const cols = columns;
            // MySQL uses ? for placeholders like SQLite
            const tuple = `(${cols.map(() => '?').join(', ')})`;
            const values = batch.flatMap(row => cols.map(col => row[col] ?? null));
            await connection.query(
              `INSERT INTO \`${tableName}\` (${quotedColumns}) VALUES ${batch.map(() => tuple).join(', ')}`,
              values
            );
            rows += batch.length;
          };

          let pendingMysql: BackupRow[] = [];
          for (const row of readTableFileSync(tableFile)) {
            if (!columns) {
              columns = this.insertColumns(tableName, row);
              quotedColumns = columns.map(c => `\`${c}\``).join(', ');
              batchRows = insertBatchRows(columns.length);
            }
            pendingMysql.push(row);
            if (pendingMysql.length >= batchRows) {
              await flush(pendingMysql);
              pendingMysql = [];
            }
          }
          await flush(pendingMysql);

          totalRowsRestored += rows;
          tablesRestored++;
          logger.debug(`  ✅ Restored ${tableName}: ${rows} rows`);

        } catch (error) {
          logger.error(`  ❌ Failed to restore table ${tableName}:`, error);
          throw error; // Will trigger rollback
        }
      }

      await connection.commit();
      return { rowsRestored: totalRowsRestored, tablesRestored };

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
      await pool.end();
    }
  }

  /**
   * Parse a MySQL URL to extract components
   * Supports both mysql:// and mariadb:// protocols
   */
  private parseMySQLUrl(url: string): {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  } | null {
    try {
      // Replace mysql:// or mariadb:// with a standard protocol for URL parsing
      const normalizedUrl = url.replace(/^(mysql|mariadb):\/\//, 'http://');
      const parsed = new URL(normalizedUrl);
      return {
        host: parsed.hostname,
        port: parseInt(parsed.port || '3306', 10),
        database: parsed.pathname.slice(1), // Remove leading /
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      };
    } catch {
      return null;
    }
  }
}

/** Rows per multi-row INSERT for a table with this many columns. */
function insertBatchRows(columnCount: number): number {
  return Math.max(1, Math.min(MAX_INSERT_ROWS, Math.floor(MAX_INSERT_PARAMS / Math.max(1, columnCount))));
}

/**
 * better-sqlite3 binds numbers, strings, bigints, buffers and null. A backup
 * made on PostgreSQL holds booleans; a row from an older file may lack a
 * column the first row had.
 */
function toSqliteValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export const systemRestoreService = new SystemRestoreService();
