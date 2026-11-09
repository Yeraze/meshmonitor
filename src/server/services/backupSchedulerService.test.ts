/**
 * Per-source device-backup scheduling (#6285): matching, the persisted local
 * day guard, "a save never fires a backup", restart safety, offline sources.
 * Pure logic: the clock is passed in, no timers run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  sources: [] as Array<{ id: string; type: string }>,
  create: vi.fn(),
  busy: new Set<string>(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: async (k: string) => state.settings.get(k) ?? null,
      setSetting: async (k: string, v: string) => { state.settings.set(k, v); },
    },
    sources: { getAllSources: async () => state.sources },
  },
}));
vi.mock('./systemBackupService.js', () => ({ systemBackupService: { initializeBackupDirectory: vi.fn() } }));
vi.mock('./backupFileService.js', () => ({ backupFileService: { initializeBackupDirectory: vi.fn() } }));
vi.mock('./deviceConfigBackupService.js', () => ({
  deviceConfigBackupService: { create: state.create },
  isBackupBusy: (id: string) => state.busy.has(id),
}));

import { backupSchedulerService, localDateString } from './backupSchedulerService.js';

const live = (sourceId: string, connected = true) => ({
  sourceId,
  getStatus: () => ({ connected }),
  getConnectionStatus: () => ({ deviceType: 1 }), // MeshCoreDeviceType.COMPANION
});

const registryOf = (managers: Record<string, ReturnType<typeof live> | undefined>) => ({
  getManager: (id: string) => managers[id] as never,
});

// Local-time constructor: the scheduler matches LOCAL HH:MM.
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0);
const set = (id: string, name: string, value: string) => state.settings.set(`source:${id}:${name}`, value);
const get = (id: string, name: string) => state.settings.get(`source:${id}:${name}`);

async function run(now: Date, managers: Record<string, ReturnType<typeof live> | undefined>) {
  (backupSchedulerService as unknown as { registry: unknown }).registry = registryOf(managers);
  await backupSchedulerService.checkAndRunDeviceBackup(now);
}

beforeEach(() => {
  state.settings.clear();
  state.sources = [
    { id: 'A', type: 'meshtastic_tcp' },
    { id: 'B', type: 'meshcore' },
    { id: 'M', type: 'mqtt_broker' },
  ];
  state.busy.clear();
  state.create.mockReset().mockResolvedValue({ filename: 'x.yaml', content: 'c' });
});

describe('per-source schedule', () => {
  it('runs each enabled source at its own time, with its own protocol', async () => {
    set('A', 'backup_enabled', 'true'); set('A', 'backup_time', '02:00');
    set('B', 'backup_enabled', 'true'); set('B', 'backup_time', '03:30');
    const managers = { A: live('A'), B: live('B') };

    await run(at(2026, 11, 9, 2, 0), managers);
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.create.mock.calls[0][0]).toMatchObject({ sourceId: 'A', protocol: 'meshtastic' });
    expect(state.create.mock.calls[0][1]).toBe('automatic');

    await run(at(2026, 11, 9, 3, 30), managers);
    expect(state.create).toHaveBeenCalledTimes(2);
    expect(state.create.mock.calls[1][0]).toMatchObject({ sourceId: 'B', protocol: 'meshcore' });
  });

  it('never runs a disabled source or a non-device source', async () => {
    set('A', 'backup_enabled', 'false'); set('A', 'backup_time', '02:00');
    set('M', 'backup_enabled', 'true'); set('M', 'backup_time', '02:00');
    await run(at(2026, 11, 9, 2, 0), { A: live('A'), M: live('M') });
    expect(state.create).not.toHaveBeenCalled();
  });

  it('does not use the retired global keys', async () => {
    state.settings.set('backup_enabled', 'true');
    state.settings.set('backup_time', '02:00');
    await run(at(2026, 11, 9, 2, 0), { A: live('A') });
    expect(state.create).not.toHaveBeenCalled();
  });

  it('a restart in the same minute after a run does not fire again', async () => {
    set('A', 'backup_enabled', 'true'); set('A', 'backup_time', '02:00');
    await run(at(2026, 11, 9, 2, 0), { A: live('A') });
    expect(get('A', 'backup_lastAutomaticBackupDate')).toBe('2026-11-09');
    // "restart": the guard is only in settings, the scheduler holds no memory of the run.
    await run(at(2026, 11, 9, 2, 0), { A: live('A') });
    expect(state.create).toHaveBeenCalledTimes(1);
    // The next day fires again.
    await run(at(2026, 11, 10, 2, 0), { A: live('A') });
    expect(state.create).toHaveBeenCalledTimes(2);
  });

  it('there is no catch-up: a missed slot (process down) is not run later', async () => {
    set('A', 'backup_enabled', 'true'); set('A', 'backup_time', '02:00');
    await run(at(2026, 11, 9, 2, 1), { A: live('A') });
    await run(at(2026, 11, 9, 9, 0), { A: live('A') });
    expect(state.create).not.toHaveBeenCalled();
  });

  it('uses a LOCAL date for the guard, so late-evening slots work near UTC midnight', async () => {
    set('A', 'backup_enabled', 'true'); set('A', 'backup_time', '23:59');
    const now = at(2026, 11, 9, 23, 59);
    await run(now, { A: live('A') });
    expect(get('A', 'backup_lastAutomaticBackupDate')).toBe(localDateString(now));
    expect(get('A', 'backup_lastAutomaticBackupDate')).toBe('2026-11-09');
  });

  it('a source that is offline sets the guard and the error, and runs nothing', async () => {
    set('A', 'backup_enabled', 'true'); set('A', 'backup_time', '02:00');
    await run(at(2026, 11, 9, 2, 0), { A: live('A', false) });
    expect(state.create).not.toHaveBeenCalled();
    expect(get('A', 'backup_lastAutomaticBackupDate')).toBe('2026-11-09');
    expect(get('A', 'backup_lastAutomaticBackupError')).toBe('SOURCE_NOT_CONNECTED');
    // No retry in the same minute or later that day.
    await run(at(2026, 11, 9, 2, 0), { A: live('A') });
    expect(state.create).not.toHaveBeenCalled();
  });

  it('a source with no manager at all is treated as offline', async () => {
    set('A', 'backup_enabled', 'true'); set('A', 'backup_time', '02:00');
    await run(at(2026, 11, 9, 2, 0), {});
    expect(get('A', 'backup_lastAutomaticBackupError')).toBe('SOURCE_NOT_CONNECTED');
  });

  it('skips while a restore or manual create holds the source, and says so', async () => {
    set('A', 'backup_enabled', 'true'); set('A', 'backup_time', '02:00');
    state.busy.add('A');
    await run(at(2026, 11, 9, 2, 0), { A: live('A') });
    expect(state.create).not.toHaveBeenCalled();
    expect(get('A', 'backup_lastAutomaticBackupError')).toBe('BACKUP_BUSY');
  });

  it('records success (clears the error) and failure without throwing', async () => {
    set('A', 'backup_enabled', 'true'); set('A', 'backup_time', '02:00');
    set('A', 'backup_lastAutomaticBackupError', 'BACKUP_FAILED');
    await run(at(2026, 11, 9, 2, 0), { A: live('A') });
    expect(get('A', 'backup_lastAutomaticBackupError')).toBe('');

    state.create.mockRejectedValueOnce(new Error('boom: secret-stuff'));
    await run(at(2026, 11, 10, 2, 0), { A: live('A') });
    expect(get('A', 'backup_lastAutomaticBackupError')).toBe('BACKUP_FAILED');
    expect(get('A', 'backup_lastAutomaticBackupDate')).toBe('2026-11-10');
  });

  it('one failing source does not stop the next', async () => {
    set('A', 'backup_enabled', 'true'); set('A', 'backup_time', '02:00');
    set('B', 'backup_enabled', 'true'); set('B', 'backup_time', '02:00');
    state.create.mockRejectedValueOnce(new Error('A failed'));
    await run(at(2026, 11, 9, 2, 0), { A: live('A'), B: live('B') });
    expect(state.create).toHaveBeenCalledTimes(2);
  });
});

describe('saving the schedule never fires a backup', () => {
  it('a time equal to the current minute sets today\'s guard', async () => {
    const now = at(2026, 11, 9, 10, 15);
    await backupSchedulerService.applySettings('A', { enabled: true, maxBackups: 7, backupTime: '10:15' }, now);
    expect(get('A', 'backup_lastAutomaticBackupDate')).toBe('2026-11-09');
    await run(now, { A: live('A') });
    expect(state.create).not.toHaveBeenCalled();
  });

  it('a time earlier today also sets the guard; a later time does not', async () => {
    const now = at(2026, 11, 9, 10, 15);
    await backupSchedulerService.applySettings('A', { enabled: true, maxBackups: 7, backupTime: '09:00' }, now);
    expect(get('A', 'backup_lastAutomaticBackupDate')).toBe('2026-11-09');

    state.settings.clear();
    await backupSchedulerService.applySettings('A', { enabled: true, maxBackups: 7, backupTime: '23:30' }, now);
    expect(get('A', 'backup_lastAutomaticBackupDate')).toBeUndefined();
    await run(at(2026, 11, 9, 23, 30), { A: live('A') });
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it('a disabled save writes the values and leaves the guard alone', async () => {
    await backupSchedulerService.applySettings('A', { enabled: false, maxBackups: 3, backupTime: '01:00' }, at(2026, 11, 9, 10, 15));
    expect(get('A', 'backup_enabled')).toBe('false');
    expect(get('A', 'backup_maxBackups')).toBe('3');
    expect(get('A', 'backup_lastAutomaticBackupDate')).toBeUndefined();
  });

  it('readSettings returns defaults and the last result', async () => {
    expect(await backupSchedulerService.readSettings('A')).toMatchObject({ enabled: false, maxBackups: 7, backupTime: '02:00', lastAutomaticBackupError: null });
    set('A', 'backup_lastAutomaticBackupError', 'SOURCE_NOT_CONNECTED');
    expect((await backupSchedulerService.readSettings('A')).lastAutomaticBackupError).toBe('SOURCE_NOT_CONNECTED');
  });
});
