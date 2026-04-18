/**
 * Tests for systemBackupService
 * Mocks filesystem operations and database to test logic without I/O.
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
  readdirSync: vi.fn(),
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
  },
  settings: {
    getSetting: vi.fn(),
  },
  auditLogAsync: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: mockDb,
}));

// ─── Import service AFTER mocks ───────────────────────────────────────────────

import { systemBackupService, BACKUP_TABLES } from './systemBackupService.js';

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  fsMock.existsSync.mockReturnValue(false);
  fsMock.mkdirSync.mockReturnValue(undefined);
  fsMock.statSync.mockReturnValue({ size: 1024 });
  mockDb.getDatabaseType.mockReturnValue('sqlite');
  mockDb.settings.getSetting.mockResolvedValue(null);

  // Default SQLite db mock: prepare returns a stub
  const stmtMock = { all: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null), run: vi.fn() };
  mockDb.db.prepare.mockReturnValue(stmtMock);
});

// ─── initializeBackupDirectory ────────────────────────────────────────────────

describe('systemBackupService.initializeBackupDirectory', () => {
  it('creates directory when it does not exist', () => {
    fsMock.existsSync.mockReturnValue(false);
    systemBackupService.initializeBackupDirectory();
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it('does not create directory when it already exists', () => {
    fsMock.existsSync.mockReturnValue(true);
    systemBackupService.initializeBackupDirectory();
    expect(fsMock.mkdirSync).not.toHaveBeenCalled();
  });

  it('throws on fs error', () => {
    fsMock.existsSync.mockReturnValue(false);
    fsMock.mkdirSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });
    expect(() => systemBackupService.initializeBackupDirectory()).toThrow(
      'Failed to initialize system backup directory'
    );
  });
});

// ─── getBackupPath ────────────────────────────────────────────────────────────

describe('systemBackupService.getBackupPath', () => {
  it('returns a path containing the dirname', () => {
    const result = systemBackupService.getBackupPath('2024-01-15_120000');
    expect(result).toContain('2024-01-15_120000');
  });
});

// ─── listBackups ──────────────────────────────────────────────────────────────

describe('systemBackupService.listBackups', () => {
  it('returns empty array when no backups exist', async () => {
    const stmtMock = { all: vi.fn().mockReturnValue([]) };
    mockDb.db.prepare.mockReturnValue(stmtMock);

    const result = await systemBackupService.listBackups();
    expect(result).toEqual([]);
  });

  it('returns formatted backup list', async () => {
    const now = Date.now();
    const stmtMock = {
      all: vi.fn().mockReturnValue([
        {
          backupPath: '2024-01-15_120000',
          timestamp: now,
          backupType: 'manual',
          totalSize: 2048,
          tableCount: 18,
          appVersion: '4.0.0',
          schemaVersion: 21,
        },
      ]),
    };
    mockDb.db.prepare.mockReturnValue(stmtMock);

    const result = await systemBackupService.listBackups();
    expect(result).toHaveLength(1);
    expect(result[0].dirname).toBe('2024-01-15_120000');
    expect(result[0].type).toBe('manual');
    expect(result[0].size).toBe(2048);
    expect(result[0].tableCount).toBe(18);
    expect(result[0].meshmonitorVersion).toBe('4.0.0');
  });

  it('throws when database query fails', async () => {
    mockDb.db.prepare.mockImplementation(() => {
      throw new Error('DB error');
    });
    await expect(systemBackupService.listBackups()).rejects.toThrow('Failed to list system backups');
  });
});

// ─── getBackupMetadata ────────────────────────────────────────────────────────

describe('systemBackupService.getBackupMetadata', () => {
  it('returns null when metadata file does not exist', async () => {
    fsMock.existsSync.mockReturnValue(false);
    const result = await systemBackupService.getBackupMetadata('2024-01-15_120000');
    expect(result).toBeNull();
  });

  it('returns parsed metadata when file exists', async () => {
    fsMock.existsSync.mockReturnValue(true);
    const metadata = {
      backupVersion: '1.0',
      meshmonitorVersion: '4.0.0',
      timestamp: '2024-01-15T12:00:00.000Z',
      timestampUnix: 1705320000000,
      schemaVersion: 21,
      tables: ['nodes', 'messages'],
      tableCount: 2,
      checksums: {},
    };
    fsMock.readFileSync.mockReturnValue(JSON.stringify(metadata));

    const result = await systemBackupService.getBackupMetadata('2024-01-15_120000');
    expect(result).toMatchObject({ backupVersion: '1.0', schemaVersion: 21 });
  });

  it('returns null when metadata file is corrupt JSON', async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('not-json{{{');
    const result = await systemBackupService.getBackupMetadata('2024-01-15_120000');
    expect(result).toBeNull();
  });
});

// ─── validateBackup ───────────────────────────────────────────────────────────

describe('systemBackupService.validateBackup', () => {
  it('returns invalid when backup directory does not exist', async () => {
    fsMock.existsSync.mockReturnValue(false);
    const result = await systemBackupService.validateBackup('nonexistent');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Backup directory not found');
  });

  it('returns invalid when metadata.json is missing', async () => {
    // Directory exists but metadata.json doesn't
    fsMock.existsSync.mockImplementation((p: string) => !p.endsWith('metadata.json'));
    const result = await systemBackupService.validateBackup('2024-01-15_120000');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('metadata'))).toBe(true);
  });

  it('returns invalid when table file is missing', async () => {
    // Directory and metadata exist, but table files are missing
    const metadata = {
      backupVersion: '1.0',
      tables: ['nodes'],
      checksums: { nodes: 'abc123' },
    };
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.endsWith('metadata.json')) return true;
      if (p.endsWith('nodes.json')) return false; // missing
      return true;
    });
    fsMock.readFileSync.mockReturnValue(JSON.stringify(metadata));

    const result = await systemBackupService.validateBackup('2024-01-15_120000');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('nodes.json'))).toBe(true);
  });

  it('returns valid when all files exist and checksums match', async () => {
    const tableData = '[{"id":1}]';
    // sha256 of tableData
    const { createHash } = await import('crypto');
    const checksum = createHash('sha256').update(tableData).digest('hex');

    const metadata = {
      backupVersion: '1.0',
      tables: ['nodes'],
      checksums: { nodes: checksum },
    };

    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p.endsWith('metadata.json')) return JSON.stringify(metadata);
      return tableData;
    });

    const result = await systemBackupService.validateBackup('2024-01-15_120000');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns invalid when checksum does not match', async () => {
    const metadata = {
      backupVersion: '1.0',
      tables: ['nodes'],
      checksums: { nodes: 'wrongchecksum' },
    };

    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p.endsWith('metadata.json')) return JSON.stringify(metadata);
      return '[{"id":1}]';
    });

    const result = await systemBackupService.validateBackup('2024-01-15_120000');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Checksum mismatch'))).toBe(true);
  });
});

// ─── deleteBackup ─────────────────────────────────────────────────────────────

describe('systemBackupService.deleteBackup', () => {
  it('throws when backup not found in DB or disk', async () => {
    fsMock.existsSync.mockReturnValue(false);
    const stmtMock = { get: vi.fn().mockReturnValue(null), run: vi.fn() };
    mockDb.db.prepare.mockReturnValue(stmtMock);

    await expect(
      systemBackupService.deleteBackup('nonexistent')
    ).rejects.toThrow('Failed to delete system backup');
  });

  it('deletes from disk when backup exists on disk', async () => {
    fsMock.existsSync.mockReturnValue(true);
    const stmtMock = { get: vi.fn().mockReturnValue({ backupPath: 'test' }), run: vi.fn() };
    mockDb.db.prepare.mockReturnValue(stmtMock);

    await systemBackupService.deleteBackup('test');
    expect(fsMock.rmSync).toHaveBeenCalled();
  });
});

// ─── BACKUP_TABLES manifest ──────────────────────────────────────────────────
// Regression: every downstream table carries a sourceId FK to `sources`. If
// `sources` is missing from the manifest, restoring a backup into a clean
// install orphans every source-scoped row and loses all Source definitions.

describe('BACKUP_TABLES manifest', () => {
  it('includes the sources table', () => {
    expect(BACKUP_TABLES).toContain('sources');
  });

  it('lists sources before any source-scoped child table', () => {
    const sourcesIdx = BACKUP_TABLES.indexOf('sources');
    expect(sourcesIdx).toBeGreaterThanOrEqual(0);
    // Child tables that carry a sourceId FK — sources must come first so a
    // future restore can recreate source definitions before inserting children.
    for (const child of ['nodes', 'messages', 'telemetry', 'traceroutes', 'neighbor_info']) {
      const childIdx = BACKUP_TABLES.indexOf(child);
      expect(childIdx).toBeGreaterThan(sourcesIdx);
    }
  });
});
