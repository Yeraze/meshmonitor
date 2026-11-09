/**
 * Source scoping, 0600 permissions, collision suffix and per-source purge for
 * the backup file service (#6285). Real files in a temp dir; in-memory history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { statSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Row = {
  id: number; sourceId: string | null; protocol: string; filename: string; filePath: string;
  fileSize: number; backupType: string; timestamp: number; createdAt: number;
};
const state = vi.hoisted(() => ({ rows: [] as any[], nextId: 1, settings: {} as Record<string, string>, sources: new Set<string>() }));

vi.mock('../../services/database.js', () => {
  const unowned = (r: Row) => r.sourceId === null || !state.sources.has(r.sourceId);
  return {
    default: {
      insertBackupHistoryAsync: async (b: any) => {
        state.rows.push({ id: state.nextId++, sourceId: null, protocol: 'meshtastic', ...b, createdAt: Date.now() });
      },
      settings: { getSetting: async (k: string) => state.settings[k] ?? null },
      backupHistory: {
        getBackupHistoryList: async (sid: string) => state.rows.filter((r: Row) => r.sourceId === sid).sort((a: Row, b: Row) => b.timestamp - a.timestamp),
        listUnowned: async (p?: string) => state.rows.filter((r: Row) => unowned(r) && (!p || r.protocol === p)),
        getBackupByFilename: async (sid: string, f: string) => state.rows.find((r: Row) => r.sourceId === sid && r.filename === f) ?? null,
        getUnownedByFilename: async (f: string) => state.rows.find((r: Row) => unowned(r) && r.filename === f) ?? null,
        deleteBackupHistoryById: async (id: number) => { state.rows = state.rows.filter((r: Row) => r.id !== id); },
        countBackups: async (sid: string) => state.rows.filter((r: Row) => r.sourceId === sid).length,
        getOldestBackups: async (sid: string, n: number) =>
          state.rows.filter((r: Row) => r.sourceId === sid).sort((a: Row, b: Row) => a.timestamp - b.timestamp).slice(0, n),
      },
    },
  };
});

import { backupFileService, BackupNotFoundError } from './backupFileService.js';

let dir: string;
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'mm-bk-')), 'backups');
  process.env.BACKUP_DIR = dir;
  state.rows = []; state.nextId = 1; state.settings = {}; state.sources = new Set(['A', 'B']);
});
afterEach(async () => {
  delete process.env.BACKUP_DIR;
  await rm(join(dir, '..'), { recursive: true, force: true });
  vi.useRealTimers();
});

const save = (sourceId: string, protocol: 'meshtastic' | 'meshcore' = 'meshtastic', nodeId = '!abc123') =>
  backupFileService.saveBackup({ content: 'secret: yes\n', type: 'manual', sourceId, protocol, nodeId });

describe('saveBackup', () => {
  it('writes the file 0600 in a 0700 directory with a protocol-tagged UTC name', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T01:02:03.000Z'));
    const mt = await save('A');
    const mc = await save('B', 'meshcore', 'ab12cd');
    expect(mt).toBe('mt-abc123-2026-11-09-01-02-03.yaml');
    expect(mc).toBe('mc-ab12cd-2026-11-09-01-02-03.yaml');
    expect(mt).toMatch(/^[a-zA-Z0-9\-_]+\.yaml$/);
    expect(statSync(join(dir, mt)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(state.rows[0]).toMatchObject({ sourceId: 'A', protocol: 'meshtastic', nodeId: '!abc123' });
  });

  it('never overwrites: a same-second collision gets -2, -3', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T01:02:03.000Z'));
    const a = await save('A');
    const b = await save('A');
    const c = await save('A');
    expect([a, b, c]).toEqual([
      'mt-abc123-2026-11-09-01-02-03.yaml',
      'mt-abc123-2026-11-09-01-02-03-2.yaml',
      'mt-abc123-2026-11-09-01-02-03-3.yaml',
    ]);
  });
});

describe('initializeBackupDirectory', () => {
  it('tightens pre-existing world-readable yaml files once', async () => {
    await save('A'); // creates dir
    const old = join(dir, 'old-node.yaml');
    writeFileSync(old, 'x');
    chmodSync(old, 0o644);
    // a fresh service instance would re-run; the singleton already ran, so reload the module
    vi.resetModules();
    const { backupFileService: fresh } = await import('./backupFileService.js');
    fresh.initializeBackupDirectory();
    expect(statSync(old).mode & 0o777).toBe(0o600);
  });
});

describe('source scoping', () => {
  it('another source cannot get or delete a file; same name resolves per source', async () => {
    const f = await save('A');
    await expect(backupFileService.getBackup('B', f)).rejects.toBeInstanceOf(BackupNotFoundError);
    await expect(backupFileService.deleteBackup('B', f)).rejects.toBeInstanceOf(BackupNotFoundError);
    expect(existsSync(join(dir, f))).toBe(true);
    await expect(backupFileService.getBackup('A', f)).resolves.toBe('secret: yes\n');
  });

  it('unowned rows need includeUnowned', async () => {
    const f = await save('A');
    state.sources.delete('A'); // source deleted -> orphan
    await expect(backupFileService.getBackup('B', f)).rejects.toBeInstanceOf(BackupNotFoundError);
    await expect(backupFileService.getBackup('B', f, { includeUnowned: true })).resolves.toContain('secret');
    const list = await backupFileService.listBackups('B', { includeUnowned: true, protocol: 'meshtastic' });
    expect(list.map(x => [x.filename, x.legacy])).toEqual([[f, true]]);
    expect(await backupFileService.listBackups('B')).toEqual([]);
  });
});

describe('purgeOldBackups', () => {
  it('keeps the per-source limit, ignores other sources and unowned rows', async () => {
    state.settings['source:A:backup_maxBackups'] = '2';
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-11-09T01:00:00.000Z').getTime();
    const mk = async (sid: string, i: number) => {
      vi.setSystemTime(t0 + i * 1000);
      return save(sid);
    };
    await mk('B', 0); await mk('B', 1); await mk('B', 2);
    state.rows.push({ id: 99, sourceId: null, protocol: 'meshtastic', filename: 'legacy.yaml', filePath: join(dir, 'legacy.yaml'), timestamp: 0, backupType: 'manual', createdAt: 0 });
    const a1 = await mk('A', 3); const a2 = await mk('A', 4); const a3 = await mk('A', 5);
    const aNames = state.rows.filter((r: Row) => r.sourceId === 'A').map((r: Row) => r.filename).sort();
    expect(aNames).toEqual([a2, a3].sort());
    expect(existsSync(join(dir, a1))).toBe(false);
    expect(state.rows.filter((r: Row) => r.sourceId === 'B')).toHaveLength(3); // default 7
    expect(state.rows.some((r: Row) => r.id === 99)).toBe(true);
  });
});
