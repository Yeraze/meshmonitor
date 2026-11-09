/**
 * The shared backup pipeline (#6285): lock, protocol check, legacy
 * confirmation, no secrets in the audit trail. Adapter and file service are
 * doubles; the real pipeline logic runs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  restore: vi.fn(),
  generate: vi.fn(),
  rows: new Map<string, { row: { protocol: string; filename: string }; legacy: boolean }>(),
  audit: vi.fn().mockResolvedValue(undefined),
  saveBackup: vi.fn().mockResolvedValue('mt-x.yaml'),
}));

vi.mock('../../services/database.js', () => ({ default: { auditLogAsync: h.audit } }));
vi.mock('./backupFileService.js', () => {
  class BackupNotFoundError extends Error {}
  return {
    BackupNotFoundError,
    backupFileService: {
      saveBackup: h.saveBackup,
      findBackup: async (_s: string, f: string) => h.rows.get(f) ?? null,
      readRow: () => 'SECRET-CONTENT',
    },
  };
});
vi.mock('./backupAdapters/index.js', () => {
  class BackupProtocolMismatchError extends Error {}
  return {
    BackupProtocolMismatchError,
    getBackupAdapter: () => ({
      protocol: 'meshtastic',
      fileTag: 'mt',
      identify: () => ({ nodeId: '!abc', nodeNum: 1 }),
      generate: h.generate,
      parse: (y: string) => ({ y }),
      summarize: () => ({ protocol: 'meshtastic', channels: [], sections: [], requiresReboot: false }),
      restore: h.restore,
    }),
  };
});

import {
  deviceConfigBackupService,
  RestoreInProgressError,
  LegacyConfirmRequiredError,
  BackupProtocolMismatchError,
  BackupNotFoundError,
  isBackupBusy,
} from './deviceConfigBackupService.js';

const target = { sourceId: 'S1', protocol: 'meshtastic' as const, manager: {} };
const admin = { isAdmin: true, userId: 1, ip: '1.2.3.4' };
const user = { isAdmin: false, userId: 2, ip: null };

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.clear();
  h.rows.set('own.yaml', { row: { protocol: 'meshtastic', filename: 'own.yaml' }, legacy: false });
  h.rows.set('legacy.yaml', { row: { protocol: 'meshtastic', filename: 'legacy.yaml' }, legacy: true });
  h.rows.set('mc.yaml', { row: { protocol: 'meshcore', filename: 'mc.yaml' }, legacy: false });
  h.restore.mockResolvedValue({ applied: ['a', 'b'], failed: [], channels: 0, requiresReboot: false });
  h.generate.mockResolvedValue('SECRET-YAML');
});

describe('restore', () => {
  it('404 for an unknown file, 409 for another protocol', async () => {
    await expect(deviceConfigBackupService.restore(target, 'nope.yaml', user)).rejects.toBeInstanceOf(BackupNotFoundError);
    await expect(deviceConfigBackupService.restore(target, 'mc.yaml', user)).rejects.toBeInstanceOf(BackupProtocolMismatchError);
    expect(h.restore).not.toHaveBeenCalled();
  });

  it('an unowned file needs confirmLegacy', async () => {
    await expect(deviceConfigBackupService.restore(target, 'legacy.yaml', admin)).rejects.toBeInstanceOf(LegacyConfirmRequiredError);
    await expect(deviceConfigBackupService.restore(target, 'legacy.yaml', admin, { confirmLegacy: true })).resolves.toMatchObject({ applied: ['a', 'b'] });
  });

  it('holds a per-source lock: a second restore and a create get RestoreInProgressError', async () => {
    let release!: () => void;
    h.restore.mockImplementationOnce(() => new Promise((res) => { release = () => res({ applied: [], failed: [], channels: 0, requiresReboot: false }); }));
    const first = deviceConfigBackupService.restore(target, 'own.yaml', user);
    await vi.waitFor(() => expect(isBackupBusy('S1')).toBe(true));

    await expect(deviceConfigBackupService.restore(target, 'own.yaml', user)).rejects.toBeInstanceOf(RestoreInProgressError);
    await expect(deviceConfigBackupService.create(target, 'manual')).rejects.toBeInstanceOf(RestoreInProgressError);
    // Another source is unaffected.
    expect(isBackupBusy('S2')).toBe(false);

    release();
    await first;
    expect(isBackupBusy('S1')).toBe(false);
  });

  it('releases the lock when the adapter throws', async () => {
    h.restore.mockRejectedValueOnce(new Error('device gone'));
    await expect(deviceConfigBackupService.restore(target, 'own.yaml', user)).rejects.toThrow('device gone');
    expect(isBackupBusy('S1')).toBe(false);
  });

  it('audits ids and counts only, never content', async () => {
    await deviceConfigBackupService.restore(target, 'own.yaml', admin);
    await vi.waitFor(() => expect(h.audit).toHaveBeenCalled());
    const [userId, action, resource, details] = h.audit.mock.calls[0];
    expect([userId, action, resource]).toEqual([1, 'device_backup_restored', 'device_backup']);
    expect(JSON.parse(details)).toMatchObject({ sourceId: 'S1', filename: 'own.yaml', applied: 2, failed: 0 });
    expect(details).not.toContain('SECRET');
  });
});

describe('create', () => {
  it('saves the generated file for the source and audits without content', async () => {
    const r = await deviceConfigBackupService.create(target, 'automatic');
    expect(r).toEqual({ filename: 'mt-x.yaml', content: 'SECRET-YAML' });
    expect(h.saveBackup).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'S1', protocol: 'meshtastic', type: 'automatic', nodeId: '!abc', nodeNum: 1,
    }));
    await vi.waitFor(() => expect(h.audit).toHaveBeenCalled());
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('SECRET');
    expect(isBackupBusy('S1')).toBe(false);
  });

  it('releases the busy flag when generation fails', async () => {
    h.generate.mockRejectedValueOnce(new Error('serial timeout'));
    await expect(deviceConfigBackupService.create(target, 'manual')).rejects.toThrow('serial timeout');
    expect(isBackupBusy('S1')).toBe(false);
  });
});
