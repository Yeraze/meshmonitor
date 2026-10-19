/**
 * #5892: the maintenance run prunes meshcore_cli_history with its own
 * retention (default 90 days), and reports it in the stats and status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = new Map<string, string>();
const db = vi.hoisted(() => ({
  pruneOlderThan: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'postgres',
    settings: {
      getSetting: vi.fn(async (k: string) => settings.get(k) ?? null),
      setSetting: vi.fn(async (k: string, v: string) => { settings.set(k, v); }),
    },
    getDatabaseSizeAsync: vi.fn().mockResolvedValue(1000),
    cleanupOldMessagesAsync: vi.fn().mockResolvedValue(0),
    cleanupOldTraceroutesAsync: vi.fn().mockResolvedValue(0),
    cleanupOldRouteSegmentsAsync: vi.fn().mockResolvedValue(0),
    cleanupOldNeighborInfoAsync: vi.fn().mockResolvedValue(0),
    cleanupAuditLogsAsync: vi.fn().mockResolvedValue(0),
    meshcoreCliHistory: { pruneOlderThan: db.pruneOlderThan },
    deadDrop: { purgeExpired: vi.fn().mockResolvedValue(0) },
    vacuumAsync: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./waypointService.js', () => ({ waypointService: { expireSweep: vi.fn().mockResolvedValue(0) } }));

import { databaseMaintenanceService } from './databaseMaintenanceService.js';
import { DEFAULT_MESHCORE_CLI_HISTORY_RETENTION_DAYS } from './meshcoreCliHistoryService.js';

describe('database maintenance: MeshCore CLI history retention (#5892)', () => {
  beforeEach(() => {
    settings.clear();
    db.pruneOlderThan.mockReset().mockResolvedValue(4);
  });

  it('defaults to 90 days and counts the deleted rows', async () => {
    expect(DEFAULT_MESHCORE_CLI_HISTORY_RETENTION_DAYS).toBe(90);
    const stats = await databaseMaintenanceService.runMaintenance();
    expect(db.pruneOlderThan).toHaveBeenCalledWith(90);
    expect(stats.meshcoreCliHistoryDeleted).toBe(4);
  });

  it('uses the saved setting', async () => {
    settings.set('meshcoreCliHistoryRetentionDays', '14');
    await databaseMaintenanceService.runMaintenance();
    expect(db.pruneOlderThan).toHaveBeenCalledWith(14);
    const status = await databaseMaintenanceService.getStatus();
    expect(status.settings.meshcoreCliHistoryRetentionDays).toBe(14);
  });

  it('a failed prune does not fail the run', async () => {
    db.pruneOlderThan.mockRejectedValueOnce(new Error('boom'));
    const stats = await databaseMaintenanceService.runMaintenance();
    expect(stats.meshcoreCliHistoryDeleted).toBe(0);
  });
});
