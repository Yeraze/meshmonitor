/**
 * Backup → restore round trip for `meshcore_observer_keys` (#5596).
 *
 * The table was missing from BACKUP_TABLES, so a restore silently dropped
 * every Analyzer Observer signing key: the source came back with an Observer
 * config pointing at a key that no longer existed.
 *
 * Runs the REAL backup and restore services against the singleton's in-memory
 * SQLite and a real temp directory — nothing about the round trip is mocked,
 * so this fails if either side stops carrying the table.
 *
 * Also pins what happens when the backup is restored under a DIFFERENT
 * SESSION_SECRET. Each row is an AES-256-GCM envelope keyed from that secret,
 * so the rows come back unreadable. Restore keeps them, warns, and the key
 * store reports `key_rotated` — the same thing it does for a rotated secret.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const env = vi.hoisted(() => {
  // Read once at module load by both services, so it must be set before import.
  const dir = `${process.env.TMPDIR ?? '/tmp'}/mm-backup-observer-keys-${process.pid}-${Date.now()}`;
  process.env.SYSTEM_BACKUP_DIR = dir;
  return { dir };
});

// Restore writes a marker to /data/.restore-completed. Swallow that one write
// so the test never touches the host's /data; everything else is the real fs.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const writeFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (file === '/data/.restore-completed') return;
    return (actual.writeFileSync as (...a: unknown[]) => void)(file, ...rest);
  }) as typeof actual.writeFileSync;
  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

import * as fs from 'fs';
import * as path from 'path';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { systemBackupService, BACKUP_TABLES } from './systemBackupService.js';
import { systemRestoreService } from './systemRestoreService.js';
import {
  MeshCoreObserverKeyStore,
  setMeshCoreObserverKeyStoreForTesting,
} from './meshcoreObserverKeyStore.js';

const SECRET_AT_BACKUP = 'session-secret-in-use-when-the-backup-was-made';
const OTHER_SECRET = 'a-different-session-secret-on-the-restoring-install';

const SOURCE_A = 'backup-observer-source-a';
const SOURCE_B = 'backup-observer-source-b';
const PRIVATE_A = 'a1'.repeat(64);
const PRIVATE_B = 'b2'.repeat(64);
const PUBLIC_A = 'AA'.repeat(32);
const PUBLIC_B = 'BB'.repeat(32);

function useSecret(secret: string): MeshCoreObserverKeyStore {
  const store = new MeshCoreObserverKeyStore(secret, true);
  setMeshCoreObserverKeyStoreForTesting(store);
  return store;
}

describe('system backup → restore carries meshcore_observer_keys (#5596)', () => {
  let dirname: string;
  let rowsAtBackup: unknown[];

  beforeAll(async () => {
    await databaseService.waitForReady();
    const store = useSecret(SECRET_AT_BACKUP);
    await store.store(SOURCE_A, PRIVATE_A, PUBLIC_A, 'device');
    await store.store(SOURCE_B, PRIVATE_B, PUBLIC_B, 'manual');
    rowsAtBackup = [
      await databaseService.meshcoreObserverKeys.getBySourceId(SOURCE_A),
      await databaseService.meshcoreObserverKeys.getBySourceId(SOURCE_B),
    ];
    dirname = await systemBackupService.createBackup('manual');
  });

  afterAll(() => {
    setMeshCoreObserverKeyStoreForTesting(null);
    fs.rmSync(env.dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // What a restore has to undo: A's key is lost, B's was replaced after the
    // backup, and a source that did not exist at backup time has one.
    const store = useSecret(SECRET_AT_BACKUP);
    await databaseService.meshcoreObserverKeys.deleteBySourceId(SOURCE_A);
    await store.store(SOURCE_B, 'cc'.repeat(64), 'CC'.repeat(32), 'manual');
    await store.store('created-after-the-backup', 'dd'.repeat(64), 'DD'.repeat(32), 'manual');
  });

  it('writes the key table into the backup, envelopes only', () => {
    expect(BACKUP_TABLES).toContain('meshcore_observer_keys');

    const file = path.join(env.dir, dirname, 'meshcore_observer_keys.json');
    const raw = fs.readFileSync(file, 'utf8');
    const rows = JSON.parse(raw) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.sourceId).sort()).toEqual([SOURCE_A, SOURCE_B]);

    // The private keys are in the file only as ciphertext.
    expect(raw).not.toContain(PRIVATE_A);
    expect(raw).not.toContain(PRIVATE_B);

    const metadata = JSON.parse(fs.readFileSync(path.join(env.dir, dirname, 'metadata.json'), 'utf8'));
    expect(metadata.tables).toContain('meshcore_observer_keys');
    expect(metadata.checksums.meshcore_observer_keys).toMatch(/^[0-9a-f]{64}$/);
  });

  it('passes backup validation with the key table present', async () => {
    expect(await systemBackupService.validateBackup(dirname)).toEqual({ valid: true, errors: [] });
  });

  it('restores every key row exactly as it was backed up', async () => {
    const result = await systemRestoreService.restoreFromBackup(dirname);
    expect(result.success).toBe(true);

    expect([
      await databaseService.meshcoreObserverKeys.getBySourceId(SOURCE_A),
      await databaseService.meshcoreObserverKeys.getBySourceId(SOURCE_B),
    ]).toEqual(rowsAtBackup);
    // The table is replaced, not merged: a key made after the backup is gone.
    expect((await databaseService.meshcoreObserverKeys.listSourceIds()).sort()).toEqual([SOURCE_A, SOURCE_B]);
  });

  it('restored keys decrypt under the SESSION_SECRET the backup was made with', async () => {
    await systemRestoreService.restoreFromBackup(dirname);
    const store = useSecret(SECRET_AT_BACKUP);

    expect(await store.load(SOURCE_A)).toEqual({
      kind: 'ok',
      privateKeyHex: PRIVATE_A,
      publicKeyHex: PUBLIC_A,
      origin: 'device',
    });
    expect(await store.load(SOURCE_B)).toMatchObject({ kind: 'ok', privateKeyHex: PRIVATE_B, origin: 'manual' });
    expect((await store.status(SOURCE_A)).keyRotated).toBe(false);
  });

  describe('restored under a different SESSION_SECRET', () => {
    it('keeps the rows, succeeds, and warns which sources are affected', async () => {
      useSecret(OTHER_SECRET);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const result = await systemRestoreService.restoreFromBackup(dirname);
      const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
      warn.mockRestore();

      expect(result.success).toBe(true);
      expect((await databaseService.meshcoreObserverKeys.listSourceIds()).sort()).toEqual([SOURCE_A, SOURCE_B]);
      expect(await databaseService.meshcoreObserverKeys.getBySourceId(SOURCE_A)).toEqual(rowsAtBackup[0]);

      expect(warned).toMatch(/2 Analyzer Observer signing key\(s\) that the current SESSION_SECRET cannot decrypt/);
      expect(warned).toContain(SOURCE_A);
      expect(warned).toContain(SOURCE_B);
      // Ids only — no key material and no secret in the log line.
      expect(warned).not.toContain(PRIVATE_A);
      expect(warned).not.toContain(OTHER_SECRET);
      expect(warned).not.toContain(SECRET_AT_BACKUP);
    });

    it('the key store reports key_rotated, exactly as for a rotated secret', async () => {
      const store = useSecret(OTHER_SECRET);
      await systemRestoreService.restoreFromBackup(dirname);

      expect(await store.load(SOURCE_A)).toMatchObject({ kind: 'key_rotated' });
      expect(await store.status(SOURCE_A)).toMatchObject({ stored: true, keyRotated: true, publicKey: PUBLIC_A });
    });

    it('putting the original secret back makes the kept rows usable again', async () => {
      useSecret(OTHER_SECRET);
      await systemRestoreService.restoreFromBackup(dirname);

      const store = useSecret(SECRET_AT_BACKUP);
      expect(await store.load(SOURCE_A)).toMatchObject({ kind: 'ok', privateKeyHex: PRIVATE_A });
    });

    it('does not warn when every restored key is readable', async () => {
      useSecret(SECRET_AT_BACKUP);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      await systemRestoreService.restoreFromBackup(dirname);
      const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
      warn.mockRestore();

      expect(warned).not.toMatch(/Analyzer Observer signing key/);
    });
  });
});
