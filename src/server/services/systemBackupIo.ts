/* eslint-disable no-restricted-syntax -- TODO(remediation 6.3): the backup exporter reads every table generically (SELECT * by allowlisted name); retire with the typed-selector rewrite of systemBackupService. */
/**
 * Reading tables out of the database and table files in and out of a backup
 * directory, in bounded memory.
 *
 * A backup holds packet logs and history, which run to hundreds of thousands
 * of rows. Nothing here loads a whole table: rows move in batches from the
 * database to the file, and line by line from the file back to the database.
 *
 * File format (backupVersion 1.1): a JSON array with ONE ROW PER LINE.
 *
 *     [
 *     {"id":1,...},
 *     {"id":2,...}
 *     ]
 *
 * It is still valid JSON, so anything that parsed the 1.0 format (the whole
 * array pretty-printed) reads it. Going the other way, the reader recognises a
 * 1.0 file by its shape and parses it whole, as before.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { once } from 'events';
import type BetterSqlite3 from 'better-sqlite3';
import type { Pool as PgPool, PoolClient as PgClient } from 'pg';
import type { Pool as MySQLPool, PoolConnection as MySQLConnection } from 'mysql2/promise';
import { BACKUP_IDENTIFIER_PATTERN } from './systemBackupTables.js';

export type BackupRow = Record<string, unknown>;

/** Rows per database read and per file write. */
export const BACKUP_BATCH_ROWS = 2000;

/** New backup directories and files are private to the server's user. */
export const BACKUP_DIR_MODE = 0o700;
export const BACKUP_FILE_MODE = 0o600;

export type BackupDatabase =
  | { type: 'sqlite'; db: BetterSqlite3.Database }
  | { type: 'postgres'; pool: PgPool }
  | { type: 'mysql'; pool: MySQLPool };

export interface BackupReadSession {
  /** Every row of `table`, in batches of at most `batchRows`. */
  batches(table: string): AsyncGenerator<BackupRow[]>;
  close(): Promise<void>;
}

function assertIdentifier(name: string): void {
  if (!BACKUP_IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`Refusing to read table with a non-identifier name: ${name}`);
  }
}

const SQLITE_ROWID_ALIAS = '__mm_backup_rowid';

/**
 * SQLite: page through the table by rowid.
 *
 * The app has one SQLite connection, and better-sqlite3 refuses any other
 * statement while a cursor is open on it. So an open cursor cannot be held
 * across an `await`; each page is a complete query, and the event loop runs
 * between pages. Rows written while a table is being read may or may not be in
 * the backup — no row is read twice and none is torn.
 */
function openSqliteSession(db: BetterSqlite3.Database, batchRows: number): BackupReadSession {
  return {
    async *batches(table: string) {
      assertIdentifier(table);
      const select = `SELECT rowid AS ${SQLITE_ROWID_ALIAS}, * FROM "${table}"`;
      const first = db.prepare(`${select} ORDER BY rowid LIMIT ?`);
      const next = db.prepare(`${select} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
      let last: unknown = null;
      for (;;) {
        const rows = (last === null ? first.all(batchRows) : next.all(last, batchRows)) as BackupRow[];
        if (rows.length === 0) return;
        last = rows[rows.length - 1][SQLITE_ROWID_ALIAS];
        for (const row of rows) delete row[SQLITE_ROWID_ALIAS];
        yield rows;
        if (rows.length < batchRows) return;
        // Let the server answer requests between pages.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    async close() {
      /* nothing held open */
    },
  };
}

/**
 * PostgreSQL: one read-only REPEATABLE READ transaction for the whole backup,
 * and a server-side cursor per table. Every table is read from the same
 * snapshot, and the server hands rows over `batchRows` at a time.
 */
async function openPostgresSession(pool: PgPool, batchRows: number): Promise<BackupReadSession> {
  const client: PgClient = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  } catch (error) {
    client.release();
    throw error;
  }
  return {
    async *batches(table: string) {
      assertIdentifier(table);
      await client.query(`DECLARE mm_backup_cursor NO SCROLL CURSOR FOR SELECT * FROM "${table}"`);
      try {
        for (;;) {
          const result = await client.query(`FETCH ${Math.floor(batchRows)} FROM mm_backup_cursor`);
          if (result.rows.length === 0) return;
          yield result.rows as BackupRow[];
          if (result.rows.length < batchRows) return;
        }
      } finally {
        // A failed FETCH aborts the transaction, and CLOSE would then throw
        // over the error that matters.
        await client.query('CLOSE mm_backup_cursor').catch(() => {});
      }
    },
    async close() {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    },
  };
}

interface MysqlStreamingConnection {
  query(sql: string): { stream(options: { highWaterMark: number }): AsyncIterable<unknown> };
}

/**
 * MySQL: one consistent-snapshot transaction for the whole backup, and a row
 * stream per table (mysql2 reads from the socket as the stream is consumed, so
 * a slow disk holds the server back instead of filling memory).
 */
async function openMysqlSession(pool: MySQLPool, batchRows: number): Promise<BackupReadSession> {
  const connection: MySQLConnection = await pool.getConnection();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  } catch (error) {
    connection.release();
    throw error;
  }
  return {
    async *batches(table: string) {
      assertIdentifier(table);
      // The promise wrapper has no row stream; the callback-style connection
      // under it does. mysql2's promise typings describe `.connection` as the
      // wrapper again, hence the cast.
      const core = (connection as unknown as { connection: MysqlStreamingConnection }).connection;
      const stream = core.query(`SELECT * FROM \`${table}\``).stream({ highWaterMark: batchRows });
      let batch: BackupRow[] = [];
      for await (const row of stream) {
        batch.push({ ...(row as BackupRow) });
        if (batch.length >= batchRows) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
    },
    async close() {
      try {
        await connection.query('ROLLBACK');
      } finally {
        connection.release();
      }
    },
  };
}

export async function openBackupReadSession(
  database: BackupDatabase,
  batchRows: number = BACKUP_BATCH_ROWS,
): Promise<BackupReadSession> {
  if (database.type === 'postgres') return openPostgresSession(database.pool, batchRows);
  if (database.type === 'mysql') return openMysqlSession(database.pool, batchRows);
  return openSqliteSession(database.db, batchRows);
}

/** JSON has no bigint; ids and timestamps fit a double. */
function serializeRow(row: BackupRow): string {
  return JSON.stringify(row, (_key, value) => (typeof value === 'bigint' ? Number(value) : value));
}

export interface WrittenTableFile {
  rows: number;
  bytes: number;
  /** SHA-256 of the file's bytes, hex. */
  checksum: string;
}

/**
 * Write batches of rows to `file` in the one-row-per-line format, hashing as it
 * goes. Honours backpressure: a batch is not requested until the previous one
 * has been handed to the disk.
 */
export async function writeTableFile(
  file: string,
  batches: AsyncIterable<BackupRow[]> | Iterable<BackupRow[]>,
): Promise<WrittenTableFile> {
  const stream = fs.createWriteStream(file, { encoding: 'utf8', mode: BACKUP_FILE_MODE });
  const failed = new Promise<never>((_resolve, reject) => stream.once('error', reject));
  // The stream's error is also surfaced through the write/finish awaits below;
  // this keeps a late error from being an unhandled rejection.
  failed.catch(() => {});

  const hash = crypto.createHash('sha256');
  let rows = 0;
  let bytes = 0;

  const write = async (text: string): Promise<void> => {
    hash.update(text, 'utf8');
    bytes += Buffer.byteLength(text, 'utf8');
    if (!stream.write(text)) {
      await Promise.race([once(stream, 'drain'), failed]);
    }
  };

  try {
    await write('[');
    for await (const batch of batches) {
      if (batch.length === 0) continue;
      let text = '';
      for (const row of batch) {
        text += (rows === 0 ? '\n' : ',\n') + serializeRow(row);
        rows++;
      }
      await write(text);
    }
    await write(rows === 0 ? ']' : '\n]');
    stream.end();
    await Promise.race([once(stream, 'finish'), failed]);
  } catch (error) {
    stream.destroy();
    throw error;
  }

  return { rows, bytes, checksum: hash.digest('hex') };
}

/** SHA-256 of a file's bytes, read as a stream. */
export async function checksumFile(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

const READ_CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;

/** Yield the file's lines without holding more than one chunk and one line. */
function* readLinesSync(file: string): Generator<string> {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let carry: Buffer = Buffer.alloc(0);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, READ_CHUNK_BYTES, null);
      if (read === 0) break;
      let start = 0;
      for (;;) {
        const end = chunk.indexOf(NEWLINE, start);
        if (end === -1 || end >= read) break;
        // Lines are split on the newline BYTE, so a multi-byte character that
        // straddles two chunks is decoded whole.
        const line = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(start, end)]) : chunk.subarray(start, end);
        carry = Buffer.alloc(0);
        yield line.toString('utf8');
        start = end + 1;
      }
      if (start < read) carry = Buffer.concat([carry, chunk.subarray(start, read)]);
    }
    if (carry.length > 0) yield carry.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** True when the file starts `[` newline `{` — the one-row-per-line format. */
function isLineFormat(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(3);
    const read = fs.readSync(fd, head, 0, 3, 0);
    return read === 3 && head.toString('latin1') === '[\n{';
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read a table file's rows one at a time.
 *
 * Synchronous because the SQLite restore runs inside a synchronous
 * transaction. A one-row-per-line file is streamed; anything else (a 1.0
 * pretty-printed file, an empty `[]`, a hand-written file) is parsed whole,
 * exactly as restore always did. A file that is not a JSON array of objects
 * throws, which rolls the restore back.
 */
export function* readTableFileSync(file: string): Generator<BackupRow> {
  if (!isLineFormat(file)) {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data)) throw new Error(`Backup table file is not a JSON array: ${file}`);
    for (const row of data) yield assertRow(row, file);
    return;
  }

  let closed = false;
  let lineNumber = 0;
  for (const raw of readLinesSync(file)) {
    lineNumber++;
    if (lineNumber === 1) continue; // the opening `[`
    if (raw === ']') {
      closed = true;
      continue;
    }
    if (closed) {
      if (raw.trim() === '') continue;
      throw new Error(`Backup table file has data after the closing bracket: ${file}`);
    }
    const text = raw.endsWith(',') ? raw.slice(0, -1) : raw;
    yield assertRow(JSON.parse(text), file);
  }
  if (!closed) throw new Error(`Backup table file is truncated: ${file}`);
}

function assertRow(row: unknown, file: string): BackupRow {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`Backup table file holds a row that is not an object: ${file}`);
  }
  return row as BackupRow;
}

/**
 * Group an iterable into arrays of at most `size`.
 */
export function* inBatches<T>(items: Iterable<T>, size: number): Generator<T[]> {
  let batch: T[] = [];
  for (const item of items) {
    batch.push(item);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}
