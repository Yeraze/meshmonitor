/**
 * Auto-Responder Trigger Migration
 *
 * One-off startup data migration: sets `channel` to `'dm'` for any
 * `autoResponderTriggers` entries saved before the `channel` field existed.
 * Idempotent — once every trigger has a `channel`, subsequent runs are no-ops.
 *
 * Extracted verbatim from server.ts (was the top-level
 * `migrateAutoResponderTriggers` function + its `void migrateAutoResponderTriggers();`
 * call site) as part of #3502 PR3 composition-root teardown. server.ts calls
 * `migrateAutoResponderTriggers()` once at startup.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

export async function migrateAutoResponderTriggers(): Promise<void> {
  try {
    await databaseService.waitForReady();
    const triggersStr = await databaseService.settings.getSetting('autoResponderTriggers');
    if (!triggersStr) {
      return; // No triggers to migrate
    }

    const triggers = JSON.parse(triggersStr);
    if (!Array.isArray(triggers)) {
      return;
    }

    let migrationCount = 0;
    const migratedTriggers = triggers.map((trigger: any) => {
      if (trigger.channel === undefined || trigger.channel === null) {
        migrationCount++;
        return { ...trigger, channel: 'dm' };
      }
      return trigger;
    });

    if (migrationCount > 0) {
      await databaseService.settings.setSetting('autoResponderTriggers', JSON.stringify(migratedTriggers));
      logger.info(`✅ Migrated ${migrationCount} auto-responder trigger(s) to default channel 'dm'`);
    }
  } catch (error) {
    logger.error('❌ Failed to migrate auto-responder triggers:', error);
  }
}
