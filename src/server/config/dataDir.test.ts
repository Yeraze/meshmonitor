import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_DATA_DIR,
  getDataDir,
  dataPath,
  getDefaultDatabasePath,
  getDefaultAccessLogPath,
  getBackupDir,
  getSystemBackupDir,
  getRestoreMarkerFile,
  getAppriseConfigDir,
} from './dataDir.js';
import { getEnvironmentConfig, resetEnvironmentConfig } from './environment.js';

const KEYS = [
  'DATA_DIR',
  'DATABASE_PATH',
  'ACCESS_LOG_PATH',
  'BACKUP_DIR',
  'SYSTEM_BACKUP_DIR',
  'APPRISE_CONFIG_DIR',
] as const;

describe('dataDir (#5889)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetEnvironmentConfig();
  });

  describe('DATA_DIR unset (Docker default)', () => {
    it('keeps every path under /data, byte-for-byte as before', () => {
      expect(DEFAULT_DATA_DIR).toBe('/data');
      expect(getDataDir()).toBe('/data');
      expect(dataPath('firmware-backups')).toBe('/data/firmware-backups');
      expect(getDefaultDatabasePath()).toBe('/data/meshmonitor.db');
      expect(getDefaultAccessLogPath()).toBe('/data/logs/access.log');
      expect(getBackupDir()).toBe('/data/backups');
      expect(getSystemBackupDir()).toBe('/data/system-backups');
      expect(getRestoreMarkerFile()).toBe('/data/.restore-completed');
      expect(getAppriseConfigDir()).toBe('/data/apprise-config');
    });

    it('treats an empty DATA_DIR as unset', () => {
      process.env.DATA_DIR = '';
      expect(getDataDir()).toBe('/data');
    });
  });

  describe('DATA_DIR set (baremetal / desktop)', () => {
    beforeEach(() => {
      process.env.DATA_DIR = '/var/lib/meshmonitor/data';
    });

    it('derives every default from DATA_DIR', () => {
      expect(getDataDir()).toBe('/var/lib/meshmonitor/data');
      expect(dataPath('geojson')).toBe('/var/lib/meshmonitor/data/geojson');
      expect(getDefaultDatabasePath()).toBe('/var/lib/meshmonitor/data/meshmonitor.db');
      expect(getDefaultAccessLogPath()).toBe('/var/lib/meshmonitor/data/logs/access.log');
      expect(getBackupDir()).toBe('/var/lib/meshmonitor/data/backups');
      expect(getSystemBackupDir()).toBe('/var/lib/meshmonitor/data/system-backups');
      expect(getRestoreMarkerFile()).toBe('/var/lib/meshmonitor/data/.restore-completed');
      expect(getAppriseConfigDir()).toBe('/var/lib/meshmonitor/data/apprise-config');
    });

    it('lets a path-specific env var win over the derived default', () => {
      process.env.BACKUP_DIR = '/srv/bk';
      process.env.SYSTEM_BACKUP_DIR = '/srv/sys-bk';
      process.env.APPRISE_CONFIG_DIR = '/etc/apprise';
      expect(getBackupDir()).toBe('/srv/bk');
      expect(getSystemBackupDir()).toBe('/srv/sys-bk');
      expect(getAppriseConfigDir()).toBe('/etc/apprise');
    });

    it('reads DATA_DIR at call time, not at import', () => {
      process.env.DATA_DIR = '/first';
      expect(getBackupDir()).toBe('/first/backups');
      process.env.DATA_DIR = '/second';
      expect(getBackupDir()).toBe('/second/backups');
    });
  });

  describe('environment config', () => {
    it('defaults databasePath and accessLogPath from DATA_DIR', () => {
      process.env.DATA_DIR = '/opt/mm';
      resetEnvironmentConfig();
      const env = getEnvironmentConfig();
      expect(env.databasePath).toBe('/opt/mm/meshmonitor.db');
      expect(env.accessLogPath).toBe('/opt/mm/logs/access.log');
    });

    it('keeps explicit DATABASE_PATH / ACCESS_LOG_PATH over DATA_DIR', () => {
      process.env.DATA_DIR = '/opt/mm';
      process.env.DATABASE_PATH = '/elsewhere/db.sqlite';
      process.env.ACCESS_LOG_PATH = '/var/log/mm/access.log';
      resetEnvironmentConfig();
      const env = getEnvironmentConfig();
      expect(env.databasePath).toBe('/elsewhere/db.sqlite');
      expect(env.accessLogPath).toBe('/var/log/mm/access.log');
    });

    it('falls back to the DATA_DIR access log on an invalid ACCESS_LOG_PATH', () => {
      process.env.DATA_DIR = '/opt/mm';
      process.env.ACCESS_LOG_PATH = 'relative/access.log';
      resetEnvironmentConfig();
      expect(getEnvironmentConfig().accessLogPath).toBe('/opt/mm/logs/access.log');
    });

    it('keeps /data defaults when DATA_DIR is unset', () => {
      resetEnvironmentConfig();
      const env = getEnvironmentConfig();
      expect(env.databasePath).toBe('/data/meshmonitor.db');
      expect(env.accessLogPath).toBe('/data/logs/access.log');
    });
  });
});
