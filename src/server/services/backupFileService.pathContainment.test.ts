/**
 * The backup file service reads the on-disk path from the `backup_history`
 * database row (`filePath`). That column is attacker-reachable if a row is ever
 * written out of band, so the service must confine the resolved path to the
 * backup directory before reading or deleting it — otherwise a poisoned row
 * turns download into an arbitrary file read (#6055) and delete into an
 * arbitrary file wipe (#6054).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockBackupHistory = vi.hoisted(() => ({
  getBackupByFilename: vi.fn(),
  deleteBackupHistory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    backupHistory: mockBackupHistory,
    settings: { getSetting: vi.fn() },
  },
}));

import { backupFileService } from './backupFileService.js';

let backupDir: string;
let outsideFile: string;

beforeEach(async () => {
  backupDir = await mkdtemp(join(tmpdir(), 'mm-backupdir-'));
  process.env.BACKUP_DIR = backupDir;
  mockBackupHistory.getBackupByFilename.mockReset();
  mockBackupHistory.deleteBackupHistory.mockClear().mockResolvedValue(undefined);
  // A file OUTSIDE the backup directory that a poisoned row might target.
  outsideFile = join(await mkdtemp(join(tmpdir(), 'mm-outside-')), 'secret.txt');
  await writeFile(outsideFile, 'SECRET');
});

afterEach(async () => {
  delete process.env.BACKUP_DIR;
  await rm(backupDir, { recursive: true, force: true });
  await rm(join(outsideFile, '..'), { recursive: true, force: true });
});

describe('getBackup — arbitrary file read containment (#6055)', () => {
  it('reads a backup whose filePath is inside the backup directory', async () => {
    const legit = join(backupDir, 'node-2026-01-01.yaml');
    await writeFile(legit, 'legit-content');
    mockBackupHistory.getBackupByFilename.mockResolvedValue({ filename: 'node-2026-01-01.yaml', filePath: legit });

    await expect(backupFileService.getBackup('node-2026-01-01.yaml')).resolves.toBe('legit-content');
  });

  it('refuses a poisoned filePath that points outside the backup directory', async () => {
    mockBackupHistory.getBackupByFilename.mockResolvedValue({ filename: 'evil.yaml', filePath: outsideFile });

    await expect(backupFileService.getBackup('evil.yaml')).rejects.toThrow(/Failed to get backup/);
    // The outside file is still readable afterwards — nothing exfiltrated it,
    // but the point is the service refused to read it.
    await expect(access(outsideFile)).resolves.toBeUndefined();
  });
});

describe('deleteBackup — arbitrary file deletion containment (#6054)', () => {
  it('deletes a backup whose filePath is inside the backup directory', async () => {
    const legit = join(backupDir, 'node-2026-01-01.yaml');
    await writeFile(legit, 'legit-content');
    mockBackupHistory.getBackupByFilename.mockResolvedValue({ filename: 'node-2026-01-01.yaml', filePath: legit });

    await backupFileService.deleteBackup('node-2026-01-01.yaml');

    await expect(access(legit)).rejects.toThrow(); // gone
    expect(mockBackupHistory.deleteBackupHistory).toHaveBeenCalledWith('node-2026-01-01.yaml');
  });

  it('refuses to delete a poisoned filePath outside the backup directory', async () => {
    mockBackupHistory.getBackupByFilename.mockResolvedValue({ filename: 'evil.yaml', filePath: outsideFile });

    await expect(backupFileService.deleteBackup('evil.yaml')).rejects.toThrow(/Failed to delete backup/);
    // The outside file must still exist, and the history row must not be removed.
    await expect(access(outsideFile)).resolves.toBeUndefined();
    expect(mockBackupHistory.deleteBackupHistory).not.toHaveBeenCalled();
  });
});
