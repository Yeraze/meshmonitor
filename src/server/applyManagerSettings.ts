/**
 * Apply per-source (fallback global) scheduler settings to a MeshtasticManager
 * before it starts connecting. Without this, additional source managers stay at
 * class-field defaults and ignore both per-source and global user settings —
 * which manifests as only one source firing auto-traceroute / LocalStats /
 * key-repair on a multi-source install.
 *
 * Called from `server.ts` once per source, before `sourceManagerRegistry.addManager`
 * triggers `start*Scheduler`.
 *
 * Globally-scoped schedulers (Announce, Timer, DistanceDelete, RemoteAdminScanner,
 * TimeSync) self-bootstrap inside their own `start*Scheduler` methods via
 * `getSettingForSource(this.sourceId, ...)`, so this helper intentionally does
 * NOT duplicate that work.
 */
import type { MeshtasticManager } from './meshtasticManager.js';
import type databaseService from '../services/database.js';

type DatabaseService = typeof databaseService;

export async function applyManagerSettings(
  manager: MeshtasticManager,
  sourceId: string,
  db: DatabaseService
): Promise<void> {
  const trInterval = await db.settings.getSettingForSource(sourceId, 'tracerouteIntervalMinutes');
  if (trInterval !== null) {
    const n = parseInt(trInterval, 10);
    if (!isNaN(n) && n >= 0 && n <= 60) manager.setTracerouteInterval(n);
  }

  const lsInterval = await db.settings.getSettingForSource(sourceId, 'localStatsIntervalMinutes');
  if (lsInterval !== null) {
    const n = parseInt(lsInterval, 10);
    if (!isNaN(n) && n >= 0 && n <= 60) manager.setLocalStatsInterval(n);
  }

  const [
    keyRepairEnabled,
    keyRepairInterval,
    keyRepairMaxExchanges,
    keyRepairAutoPurge,
    keyRepairImmediatePurge,
  ] = await Promise.all([
    db.settings.getSetting('autoKeyManagementEnabled'),
    db.settings.getSetting('autoKeyManagementIntervalMinutes'),
    db.settings.getSetting('autoKeyManagementMaxExchanges'),
    db.settings.getSetting('autoKeyManagementAutoPurge'),
    db.settings.getSetting('autoKeyManagementImmediatePurge'),
  ]);

  manager.setKeyRepairSettings({
    enabled: keyRepairEnabled === 'true',
    intervalMinutes: keyRepairInterval ? parseInt(keyRepairInterval) : 5,
    maxExchanges: keyRepairMaxExchanges ? parseInt(keyRepairMaxExchanges) : 3,
    autoPurge: keyRepairAutoPurge === 'true',
    immediatePurge: keyRepairImmediatePurge === 'true',
  });
}
