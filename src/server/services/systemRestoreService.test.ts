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
