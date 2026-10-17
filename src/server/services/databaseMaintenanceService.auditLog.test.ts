/**
 * #5870: the maintenance run prunes audit_log with its own retention
 * (default 90 days), and reports it in the stats and status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = new Map<string, string>();
const db = vi.hoisted(() => ({
  cleanupAuditLogsAsync: vi.fn(),
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
    cleanupAuditLogsAsync: db.cleanupAuditLogsAsync,
    deadDrop: { purgeExpired: vi.fn().mockResolvedValue(0) },
    vacuumAsync: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./waypointService.js', () => ({ waypointService: { expireSweep: vi.fn().mockResolvedValue(0) } }));

import { databaseMaintenanceService, DEFAULT_AUDIT_LOG_RETENTION_DAYS } from './databaseMaintenanceService.js';

describe('database maintenance: audit log retention (#5870)', () => {
  beforeEach(() => {
    settings.clear();
    db.cleanupAuditLogsAsync.mockReset().mockResolvedValue(12);
  });

  it('defaults to 90 days and counts the deleted rows', async () => {
    expect(DEFAULT_AUDIT_LOG_RETENTION_DAYS).toBe(90);
    const stats = await databaseMaintenanceService.runMaintenance();
    expect(db.cleanupAuditLogsAsync).toHaveBeenCalledWith(90);
    expect(stats.auditLogDeleted).toBe(12);
  });

  it('uses the saved setting', async () => {
    settings.set('auditLogRetentionDays', '30');
    await databaseMaintenanceService.runMaintenance();
    expect(db.cleanupAuditLogsAsync).toHaveBeenCalledWith(30);
    const status = await databaseMaintenanceService.getStatus();
    expect(status.settings.auditLogRetentionDays).toBe(30);
    expect(status.databaseType).toBe('postgres');
  });
});
