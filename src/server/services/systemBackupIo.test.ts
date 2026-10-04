/**
 * The backup table-file writer and reader, and the SQLite batch reader, against
 * real files and a real in-memory database.
 *
 * What matters here is that nothing needs a whole table in memory: rows are
 * read in batches, written as they arrive, and read back one line at a time.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import {
  BACKUP_FILE_MODE,
  checksumFile,
  inBatches,
  openBackupReadSession,
  readTableFileSync,
  writeTableFile,
  type BackupRow,
} from './systemBackupIo.js';

let dir: string;
const file = (name: string) => path.join(dir, name);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-backup-io-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function* asBatches(rows: BackupRow[], size: number): AsyncGenerator<BackupRow[]> {
  yield* inBatches(rows, size);
}

describe('writeTableFile', () => {
  it('writes one row per line, as a valid JSON array', async () => {
    const rows = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: null }];
    const written = await writeTableFile(file('three.json'), asBatches(rows, 2));

    const text = fs.readFileSync(file('three.json'), 'utf8');
    expect(text).toBe('[\n{"id":1,"name":"a"},\n{"id":2,"name":"b"},\n{"id":3,"name":null}\n]');
    expect(JSON.parse(text)).toEqual(rows);
    expect(written.rows).toBe(3);
    expect(written.bytes).toBe(Buffer.byteLength(text));
  });

  it('writes an empty table as []', async () => {
    const written = await writeTableFile(file('empty.json'), asBatches([], 10));
    expect(fs.readFileSync(file('empty.json'), 'utf8')).toBe('[]');
    expect(written).toMatchObject({ rows: 0, bytes: 2 });
    expect([...readTableFileSync(file('empty.json'))]).toEqual([]);
  });

  it('returns the SHA-256 of the bytes on disk, the same value checksumFile reads back', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, text: `row ${i} — ünïcödé ✓` }));
    const written = await writeTableFile(file('sum.json'), asBatches(rows, 64));

    const onDisk = crypto.createHash('sha256').update(fs.readFileSync(file('sum.json'))).digest('hex');
    expect(written.checksum).toBe(onDisk);
    expect(await checksumFile(file('sum.json'))).toBe(onDisk);
  });

  it('keeps a newline inside a value on the row\'s own line', async () => {
    const rows = [{ id: 1, text: 'line one\nline two\r\n],\n[' }, { id: 2, text: '}' }];
    await writeTableFile(file('newline.json'), asBatches(rows, 10));
    expect(fs.readFileSync(file('newline.json'), 'utf8').split('\n')).toHaveLength(4);
    expect([...readTableFileSync(file('newline.json'))]).toEqual(rows);
  });

  it('writes bigint values as numbers', async () => {
    await writeTableFile(file('bigint.json'), asBatches([{ id: 1n, at: 1_790_000_000_000n }], 10));
    expect([...readTableFileSync(file('bigint.json'))]).toEqual([{ id: 1, at: 1_790_000_000_000 }]);
  });

  it.skipIf(process.platform === 'win32')('creates the file readable by its owner only', async () => {
    await writeTableFile(file('mode.json'), asBatches([{ id: 1 }], 10));
    expect(fs.statSync(file('mode.json')).mode & 0o777).toBe(BACKUP_FILE_MODE);
  });

  it('asks for the next batch only after the previous one was written', async () => {
    const order: string[] = [];
    async function* source(): AsyncGenerator<BackupRow[]> {
      for (let b = 0; b < 3; b++) {
        order.push(`produce ${b}`);
        yield [{ b }];
        order.push(`resumed after ${b}`);
      }
    }
    await writeTableFile(file('order.json'), source());
    expect(order).toEqual([
      'produce 0', 'resumed after 0',
      'produce 1', 'resumed after 1',
      'produce 2', 'resumed after 2',
    ]);
  });
});

describe('readTableFileSync', () => {
  it('reads rows lazily: a consumer that stops early never parses the rest', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    await writeTableFile(file('lazy.json'), asBatches(rows, 10));
    // Corrupt a late row. A reader that parsed the whole file would throw.
    const text = fs.readFileSync(file('lazy.json'), 'utf8').replace('{"id":90}', '{"id":');
    fs.writeFileSync(file('lazy.json'), text);

    const reader = readTableFileSync(file('lazy.json'));
    expect(reader.next().value).toEqual({ id: 0 });
    expect(reader.next().value).toEqual({ id: 1 });
    reader.return(undefined);

    expect(() => [...readTableFileSync(file('lazy.json'))]).toThrow();
  });

  it('reads a file bigger than its read chunk, with multi-byte characters across the chunk edge', async () => {
    // Rows of varying length full of 3- and 4-byte characters: across ~3 MiB
    // the 1 MiB chunk boundaries land inside characters.
    const rows = Array.from({ length: 20_000 }, (_, i) => ({
      id: i,
      text: '✓𝄞é'.repeat(8 + (i % 7)) + i,
    }));
    const written = await writeTableFile(file('big.json'), asBatches(rows, 1000));
    expect(written.bytes).toBeGreaterThan(2 * 1024 * 1024);

    let n = 0;
    for (const row of readTableFileSync(file('big.json'))) {
      if (row.id !== rows[n].id || row.text !== rows[n].text) throw new Error(`row ${n} differs`);
      n++;
    }
    expect(n).toBe(rows.length);
  });

  it('reads a 1.0 backup file (the whole array pretty-printed)', () => {
    const rows = [{ id: 1, name: 'old' }, { id: 2, name: 'format' }];
    fs.writeFileSync(file('legacy.json'), JSON.stringify(rows, null, 2));
    expect([...readTableFileSync(file('legacy.json'))]).toEqual(rows);
  });

  it('reads a single-line array', () => {
    fs.writeFileSync(file('oneline.json'), '[{"id":1},{"id":2}]');
    expect([...readTableFileSync(file('oneline.json'))]).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('throws on a truncated file instead of restoring half a table', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    await writeTableFile(file('cut.json'), asBatches(rows, 10));
    const text = fs.readFileSync(file('cut.json'), 'utf8');
    fs.writeFileSync(file('cut.json'), text.slice(0, text.indexOf('{"id":6}')));
    expect(() => [...readTableFileSync(file('cut.json'))]).toThrow(/truncated/);
  });

  it('throws when the file is not an array of objects', () => {
    fs.writeFileSync(file('object.json'), '{"not":"an array"}');
    expect(() => [...readTableFileSync(file('object.json'))]).toThrow(/not a JSON array/);
    fs.writeFileSync(file('scalars.json'), '[1,2,3]');
    expect(() => [...readTableFileSync(file('scalars.json'))]).toThrow(/not an object/);
    fs.writeFileSync(file('linescalars.json'), '[\n{"id":1},\n[1,2]\n]');
    expect(() => [...readTableFileSync(file('linescalars.json'))]).toThrow(/not an object/);
  });
});

describe('openBackupReadSession — SQLite', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE log_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)');
    db.exec('CREATE TABLE keyed (sourceId TEXT NOT NULL, nodeNum INTEGER NOT NULL, v TEXT, PRIMARY KEY (sourceId, nodeNum))');
    db.exec('CREATE TABLE scratch (id INTEGER PRIMARY KEY)');
    const insert = db.prepare('INSERT INTO log_rows (body) VALUES (?)');
    db.transaction(() => {
      for (let i = 0; i < 2501; i++) insert.run(`body ${i}`);
    })();
    // Holes in the rowid sequence must not end the scan early.
    db.exec('DELETE FROM log_rows WHERE id BETWEEN 900 AND 1300');
    const keyed = db.prepare('INSERT INTO keyed VALUES (?, ?, ?)');
    for (let i = 0; i < 25; i++) keyed.run(`s${i % 3}`, i, `v${i}`);
  });
  afterAll(() => db.close());

  it('reads every row exactly once, in batches no larger than asked', async () => {
    const session = await openBackupReadSession({ type: 'sqlite', db }, 1000);
    const sizes: number[] = [];
    const ids: number[] = [];
    for await (const batch of session.batches('log_rows')) {
      sizes.push(batch.length);
      for (const row of batch) ids.push(row.id as number);
    }
    await session.close();

    expect(sizes).toEqual([1000, 1000, 100]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
    expect(ids).toEqual(
      (db.prepare('SELECT id FROM log_rows ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id),
    );
  });

  it('never holds a cursor open between batches, so the app can use the connection meanwhile', async () => {
    const session = await openBackupReadSession({ type: 'sqlite', db }, 500);
    let batches = 0;
    for await (const batch of session.batches('log_rows')) {
      batches++;
      // better-sqlite3 throws "connection is busy" here if a cursor is open.
      db.prepare('INSERT INTO scratch (id) VALUES (?)').run(batches);
      expect(batch.length).toBeGreaterThan(0);
    }
    expect(batches).toBeGreaterThan(1);
    db.exec('DELETE FROM scratch');
  });

  it('reads a table with a composite primary key and returns only its own columns', async () => {
    const session = await openBackupReadSession({ type: 'sqlite', db }, 10);
    const rows: BackupRow[] = [];
    for await (const batch of session.batches('keyed')) rows.push(...batch);

    expect(rows).toHaveLength(25);
    expect(Object.keys(rows[0]).sort()).toEqual(['nodeNum', 'sourceId', 'v']);
    expect(new Set(rows.map((r) => `${r.sourceId}/${r.nodeNum}`)).size).toBe(25);
  });

  it('yields nothing for an empty table', async () => {
    const session = await openBackupReadSession({ type: 'sqlite', db });
    const batches: BackupRow[][] = [];
    for await (const batch of session.batches('scratch')) batches.push(batch);
    expect(batches).toEqual([]);
  });

  it('refuses a table name that is not a plain identifier', async () => {
    const session = await openBackupReadSession({ type: 'sqlite', db });
    await expect(async () => {
      for await (const _ of session.batches('log_rows"; DROP TABLE log_rows; --')) { /* never */ }
    }).rejects.toThrow(/non-identifier/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM log_rows').get() as { n: number }).n).toBeGreaterThan(0);
  });
});
