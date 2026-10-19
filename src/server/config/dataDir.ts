/**
 * Single source of truth for where MeshMonitor writes runtime data (#5889).
 *
 * `DATA_DIR` picks the root (Docker default `/data`; the desktop sidecar and
 * baremetal installs point it elsewhere). Every data path below derives from
 * it, and a path-specific env var (e.g. `BACKUP_DIR`) still wins over the
 * derived default.
 *
 * All helpers read `process.env` at CALL time, never at module load. ESM
 * hoists imports above `server.ts`'s dotenv load, so a module-level
 * `const X = process.env.DATA_DIR` captured the value before a `.env` file
 * could set it.
 */
import path from 'path';

/** Default data root when `DATA_DIR` is unset (the Docker volume). */
export const DEFAULT_DATA_DIR = '/data';

/** Root of all runtime data: `$DATA_DIR`, else `/data`. */
export function getDataDir(): string {
  return process.env.DATA_DIR || DEFAULT_DATA_DIR;
}

/** Join path segments under the data root. */
export function dataPath(...segments: string[]): string {
  return path.join(getDataDir(), ...segments);
}

/** SQLite database file: `$DATABASE_PATH`, else `$DATA_DIR/meshmonitor.db`. */
export function getDefaultDatabasePath(): string {
  return dataPath('meshmonitor.db');
}

/** HTTP access log: `$ACCESS_LOG_PATH`, else `$DATA_DIR/logs/access.log`. */
export function getDefaultAccessLogPath(): string {
  return dataPath('logs', 'access.log');
}

/** Database backup directory: `$BACKUP_DIR`, else `$DATA_DIR/backups`. */
export function getBackupDir(): string {
  return process.env.BACKUP_DIR || dataPath('backups');
}

/** System backup directory: `$SYSTEM_BACKUP_DIR`, else `$DATA_DIR/system-backups`. */
export function getSystemBackupDir(): string {
  return process.env.SYSTEM_BACKUP_DIR || dataPath('system-backups');
}

/** Marker recording the last completed system restore. */
export function getRestoreMarkerFile(): string {
  return dataPath('.restore-completed');
}

/** Apprise config directory: `$APPRISE_CONFIG_DIR`, else `$DATA_DIR/apprise-config`. */
export function getAppriseConfigDir(): string {
  return process.env.APPRISE_CONFIG_DIR || dataPath('apprise-config');
}
