/**
 * Tests for systemRestoreService
 * Mocks filesystem, database, and systemBackupService to test logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Filesystem mock ──────────────────────────────────────────────────────────

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  statSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('fs', () => ({
  default: fsMock,
  ...fsMock,
}));

// ─── Database mock ────────────────────────────────────────────────────────────

const mockDb = vi.hoisted(() => ({
  drizzleDbType: 'sqlite',
  getDatabaseType: vi.fn().mockReturnValue('sqlite'),
  getPostgresPool: vi.fn(),
  getMySQLPool: vi.fn(),
  db: {
    prepare: vi.fn(),
    transaction: vi.fn((fn: Function) => fn),
  },
  settings: {
    getSetting: vi.fn(),
  },
  auditLogAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/database.js', () => ({
  default: mockDb,
}));

// ─── systemBackupService mock ─────────────────────────────────────────────────

const mockBackupService = vi.hoisted(() => ({
  validateBackup: vi.fn(),
  getBackupMetadata: vi.fn(),
}));

vi.mock('./systemBackupService.js', async () => {
  const actual = await vi.importActual<typeof import('./systemBackupService.js')>(
    './systemBackupService.js'
  );
  return {
    systemBackupService: mockBackupService,
    BACKUP_TABLES: actual.BACKUP_TABLES,
  };
});

// ─── getDatabaseConfig mock ───────────────────────────────────────────────────

vi.mock('../../db/index.js', () => ({
  getDatabaseConfig: vi.fn().mockReturnValue({ type: 'sqlite' }),
}));

// ─── pg mock ──────────────────────────────────────────────────────────────────
vi.mock('pg', () => ({ Pool: vi.fn() }));

// ─── mysql2/promise mock ──────────────────────────────────────────────────────
vi.mock('mysql2/promise', () => ({
  default: { createPool: vi.fn() },
}));

// ─── Import service AFTER mocks ───────────────────────────────────────────────

import { systemRestoreService } from './systemRestoreService.js';

// ─── TX-disabled exit criterion 2 (#4294) ─────────────────────────────────────
// Restore is a pure DB row restore — it never touches a source manager, so it
// can never call setLoRaConfig / force lora.txEnabled. This is a structural
// lock rather than a mocked-manager behavioral test: neither restore nor
// backup service imports a manager or references setLoRaConfig/txEnabled at
// all, so there is no runtime call site to intercept. Reads the real
// filesystem (bypassing this file's `fs` mock) to inspect the actual source.

describe('systemRestoreService / systemBackupService — never touch lora.txEnabled (#4294)', () => {
  it('restore never calls setLoRaConfig or references txEnabled', async () => {
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const restoreSource = realFs.readFileSync(
      new URL('./systemRestoreService.ts', import.meta.url),
      'utf-8'
    );
    expect(restoreSource).not.toContain('setLoRaConfig');
    expect(restoreSource).not.toContain('txEnabled');
  });

  it('backup never calls setLoRaConfig or references txEnabled', async () => {
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const backupSource = realFs.readFileSync(
      new URL('./systemBackupService.ts', import.meta.url),
      'utf-8'
    );
    expect(backupSource).not.toContain('setLoRaConfig');
    expect(backupSource).not.toContain('txEnabled');
  });
});

// ─── Valid metadata fixture ───────────────────────────────────────────────────

const validMetadata = {
  backupVersion: '1.0',
  meshmonitorVersion: '4.0.0',
  timestamp: '2024-01-15T12:00:00.000Z',
  timestampUnix: 1705320000000,
  schemaVersion: 21,
  tables: ['nodes'],
  tableCount: 1,
  checksums: { nodes: 'abc' },
};

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  fsMock.existsSync.mockReturnValue(false);
  fsMock.readFileSync.mockReturnValue('[]');
  mockBackupService.validateBackup.mockResolvedValue({ valid: true, errors: [] });
  mockBackupService.getBackupMetadata.mockResolvedValue(validMetadata);
  mockDb.getDatabaseType.mockReturnValue('sqlite');
  const stmtMock = { all: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null), run: vi.fn() };
  mockDb.db.prepare.mockReturnValue(stmtMock);
  mockDb.db.transaction.mockImplementation((fn: Function) => fn);
  mockDb.auditLogAsync.mockResolvedValue(undefined);
});

// ─── State management ─────────────────────────────────────────────────────────

describe('systemRestoreService state management', () => {
  it('isRestoreInProgress returns false initially', () => {
    // Create a fresh instance to test initial state
    expect(typeof systemRestoreService.isRestoreInProgress()).toBe('boolean');
  });

  it('markRestoreStarted sets restoreInProgress to true', () => {
    systemRestoreService.markRestoreStarted();
    expect(systemRestoreService.isRestoreInProgress()).toBe(true);
    // Clean up
    systemRestoreService.markRestoreComplete();
  });

  it('markRestoreComplete sets restoreInProgress to false', async () => {
    systemRestoreService.markRestoreStarted();
    systemRestoreService.markRestoreComplete();
    expect(systemRestoreService.isRestoreInProgress()).toBe(false);
  });

  it('waitForRestoreComplete resolves after markRestoreComplete', async () => {
    // New restore cycle: start then complete
    systemRestoreService.markRestoreStarted();
    const waitPromise = systemRestoreService.waitForRestoreComplete();
    systemRestoreService.markRestoreComplete();
    await expect(waitPromise).resolves.toBeUndefined();
  });
});

// ─── restoreFromBackup — validation failures ──────────────────────────────────

describe('systemRestoreService.restoreFromBackup - validation', () => {
  it('returns failure when backup validation fails', async () => {
    mockBackupService.validateBackup.mockResolvedValue({
      valid: false,
      errors: ['Backup directory not found'],
    });

    const result = await systemRestoreService.restoreFromBackup('bad-backup');
    expect(result.success).toBe(false);
    expect(result.message).toContain('validation failed');
    expect(result.errors).toContain('Backup directory not found');
  });

  it('returns failure when metadata cannot be loaded', async () => {
    mockBackupService.validateBackup.mockResolvedValue({ valid: true, errors: [] });
    mockBackupService.getBackupMetadata.mockResolvedValue(null);

    const result = await systemRestoreService.restoreFromBackup('missing-metadata');
    expect(result.success).toBe(false);
    expect(result.message).toContain('metadata');
  });
});

// ─── restoreFromBackup — schema version detection ─────────────────────────────

describe('systemRestoreService.restoreFromBackup - schema versions', () => {
  it('detects migration requirement when backup schema is older', async () => {
    const oldMetadata = { ...validMetadata, schemaVersion: 15, tables: ['nodes'] };
    mockBackupService.getBackupMetadata.mockResolvedValue(oldMetadata);

    // SQLite restore reads table JSON files from disk
    fsMock.readFileSync.mockReturnValue('[]');

    const result = await systemRestoreService.restoreFromBackup('old-backup');
    // Migration is required but restore can still succeed
    expect(result.migrationRequired).toBe(true);
  });

  it('reports no migration required when schemas match', async () => {
    // Schema version 21 matches current
    mockBackupService.getBackupMetadata.mockResolvedValue({ ...validMetadata, schemaVersion: 21, tables: ['nodes'] });
    fsMock.readFileSync.mockReturnValue('[]');

    const result = await systemRestoreService.restoreFromBackup('current-backup');
    expect(result.migrationRequired).toBe(false);
  });
});

// ─── restoreFromBackup — SQLite success path ──────────────────────────────────

describe('systemRestoreService.restoreFromBackup - SQLite success', () => {
  it('restores tables and returns success', async () => {
    const tableData = JSON.stringify([{ id: 1, name: 'Test Node' }]);
    fsMock.readFileSync.mockReturnValue(tableData);

    const result = await systemRestoreService.restoreFromBackup('valid-backup');
    expect(result.success).toBe(true);
    expect(result.tablesRestored).toBeGreaterThanOrEqual(0);
  });

  it('writes restore marker file on success', async () => {
    fsMock.readFileSync.mockReturnValue('[]');

    await systemRestoreService.restoreFromBackup('valid-backup');
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.restore-completed'),
      'valid-backup',
      'utf8'
    );
  });

  it('calls audit log after successful restore', async () => {
    fsMock.readFileSync.mockReturnValue('[]');

    await systemRestoreService.restoreFromBackup('valid-backup');
    expect(mockDb.auditLogAsync).toHaveBeenCalledWith(
      null,
      'system_restore_completed',
      'system_backup',
      expect.stringContaining('valid-backup'),
      null
    );
  });
});

// ─── restoreFromBackup — coverage_receptions (#5277 P4b WP2) ─────────────────
//
// Spec §2b.6 / decision U3/A8: `exportSurveyReceptions` (WP1) omits the `id`
// column from every exported row so a restore can never re-insert an
// explicit id that collides with a live PostgreSQL sequence value (the
// target-less `onConflictDoNothing()` in `insertIgnore` would otherwise
// silently swallow the resulting insert — the "PG sequence trap"). Restore
// itself needs no coverage-specific code: it already builds its INSERT
// column list from `Object.keys(data[0])`, so an `id`-less backup row simply
// never appears in that list and the database assigns a fresh id. This test
// asserts that structural guarantee at the SQLite level (mocked `db.prepare`
// call capture) — the PG-specific "does the sequence actually stay ahead of
// a live insert" behavior needs a real PostgreSQL connection and belongs to
// WP1's repository-level multi-backend test, not this mocked service test.
describe('systemRestoreService.restoreFromBackup — coverage_receptions (PG sequence trap avoidance)', () => {
  it('is in the SQLite restore allowlist and its INSERT statement omits the id column for an id-less backup row', async () => {
    const row = { sourceId: 's1', senderId: '!aabbccdd', receivedAt: 1234, snr: 4.5 }; // no `id`
    mockBackupService.getBackupMetadata.mockResolvedValue({
      ...validMetadata,
      tables: ['coverage_receptions'],
      checksums: { coverage_receptions: 'x' },
    });
    fsMock.existsSync.mockImplementation(
      (p: unknown) => typeof p === 'string' && p.endsWith('coverage_receptions.json')
    );
    fsMock.readFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('coverage_receptions.json')) return JSON.stringify([row]);
      return '[]';
    });

    const result = await systemRestoreService.restoreFromBackup('survey-backup');
    expect(result.success).toBe(true);
    expect(result.tablesRestored).toBe(1);
    expect(result.rowsRestored).toBe(1);

    const insertSql = mockDb.db.prepare.mock.calls
      .map(([sql]) => sql as string)
      .find((sql) => sql.startsWith('INSERT INTO coverage_receptions'));
    expect(insertSql).toBeDefined();
    expect(insertSql).not.toContain('id');
    // Every other exported column is still present.
    for (const col of Object.keys(row)) {
      expect(insertSql).toContain(col);
    }
  });

  it('does not skip coverage_receptions as "not in backup allowlist" (regression guard)', async () => {
    // Before this WP, coverage_receptions wasn't in BACKUP_TABLES, so
    // restoreSQLite's allowlist check would have logged "Skipping table not
    // in backup allowlist" and left tablesRestored at 0 even for a
    // zero-row (but present) table.
    mockBackupService.getBackupMetadata.mockResolvedValue({
      ...validMetadata,
      tables: ['coverage_receptions'],
      checksums: { coverage_receptions: 'x' },
    });
    fsMock.existsSync.mockImplementation(
      (p: unknown) => typeof p === 'string' && p.endsWith('coverage_receptions.json')
    );
    fsMock.readFileSync.mockReturnValue('[]');

    const result = await systemRestoreService.restoreFromBackup('empty-survey-backup');
    expect(result.success).toBe(true);
    expect(result.tablesRestored).toBe(1);
  });
});

// ─── canRestore ───────────────────────────────────────────────────────────────

describe('systemRestoreService.canRestore', () => {
  it('returns can=false when backup validation fails', async () => {
    mockBackupService.validateBackup.mockResolvedValue({
      valid: false,
      errors: ['Backup not found'],
    });

    const result = await systemRestoreService.canRestore('bad-backup');
    expect(result.can).toBe(false);
  });

  it('returns can=true when backup is valid', async () => {
    fsMock.existsSync.mockReturnValue(true);
    mockBackupService.validateBackup.mockResolvedValue({ valid: true, errors: [] });
    mockBackupService.getBackupMetadata.mockResolvedValue(validMetadata);

    const result = await systemRestoreService.canRestore('valid-backup');
    expect(result.can).toBe(true);
  });

  it('returns can=false when restore is already in progress', async () => {
    systemRestoreService.markRestoreStarted();
    const result = await systemRestoreService.canRestore('any-backup');
    expect(result.can).toBe(false);
    systemRestoreService.markRestoreComplete();
  });
});
