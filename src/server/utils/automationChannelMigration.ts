/**
 * Migrate automation channel references when channels move/swap positions.
 *
 * Automations (auto-responder, timer, geofence triggers), autoAckChannels,
 * and notification preferences all store channel indexes (0-7). When channels
 * are rearranged (via config import, swap, or external app), these references
 * must be updated to match.
 *
 * Related: https://github.com/Yeraze/meshmonitor/issues/2425
 */
import { logger } from '../../utils/logger.js';
import type { AutoResponderTrigger, TimerTrigger, GeofenceTrigger } from '../../components/auto-responder/types.js';

type ChannelMove = { from: number; to: number };

/**
 * Build a channel index remapping from a list of moves.
 * Handles swaps correctly: if 2→3 and 3→2, both are remapped simultaneously.
 */
function buildChannelMap(moves: ChannelMove[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const move of moves) {
    map.set(move.from, move.to);
  }
  return map;
}

/**
 * Remap a single channel value using the move map.
 * Non-numeric values ('dm', 'none') pass through unchanged.
 */
function remapChannel<T extends number | string>(channel: T, map: Map<number, number>): T {
  if (typeof channel === 'number') {
    return (map.get(channel) ?? channel) as T;
  }
  return channel;
}

/**
 * Migrate all automation settings for a set of channel moves.
 * This is the main entry point — call it wherever messages are migrated.
 */
export async function migrateAutomationChannels(
  moves: ChannelMove[],
  settingsGet: (key: string) => Promise<string | null>,
  settingsSet: (key: string, value: string) => Promise<void>,
  getAllNotificationPrefs?: () => Promise<Array<{ userId: string; enabledChannels: number[] }>>,
  updateNotificationPrefs?: (userId: string, enabledChannels: number[]) => Promise<void>
): Promise<void> {
  if (moves.length === 0) return;

  const map = buildChannelMap(moves);
  const moveDesc = moves.map(m => `${m.from}→${m.to}`).join(', ');
  logger.info(`🔄 Migrating automation channel references for moves: ${moveDesc}`);

  // 1. Auto-responder triggers
  try {
    const raw = await settingsGet('autoResponderTriggers');
    if (raw) {
      const triggers: AutoResponderTrigger[] = JSON.parse(raw);
      let changed = false;
      for (const t of triggers) {
        if (t.channels) {
          const newChannels = t.channels.map(ch => remapChannel(ch, map));
          if (JSON.stringify(newChannels) !== JSON.stringify(t.channels)) {
            t.channels = newChannels;
            changed = true;
          }
        }
        if (t.channel !== undefined) {
          const newCh = remapChannel(t.channel, map);
          if (newCh !== t.channel) {
            t.channel = newCh;
            changed = true;
          }
        }
      }
      if (changed) {
        await settingsSet('autoResponderTriggers', JSON.stringify(triggers));
        logger.info('  ✅ Updated auto-responder trigger channels');
      }
    }
  } catch (error) {
    logger.error('  ❌ Failed to migrate auto-responder triggers:', error);
  }

  // 2. Timer triggers
  try {
    const raw = await settingsGet('timerTriggers');
    if (raw) {
      const triggers: TimerTrigger[] = JSON.parse(raw);
      let changed = false;
      for (const t of triggers) {
        const newCh = remapChannel(t.channel, map);
        if (newCh !== t.channel) {
          t.channel = newCh;
          changed = true;
        }
      }
      if (changed) {
        await settingsSet('timerTriggers', JSON.stringify(triggers));
        logger.info('  ✅ Updated timer trigger channels');
      }
    }
  } catch (error) {
    logger.error('  ❌ Failed to migrate timer triggers:', error);
  }

  // 3. Geofence triggers
  try {
    const raw = await settingsGet('geofenceTriggers');
    if (raw) {
      const triggers: GeofenceTrigger[] = JSON.parse(raw);
      let changed = false;
      for (const t of triggers) {
        const newCh = remapChannel(t.channel, map);
        if (newCh !== t.channel) {
          t.channel = newCh;
          changed = true;
        }
      }
      if (changed) {
        await settingsSet('geofenceTriggers', JSON.stringify(triggers));
        logger.info('  ✅ Updated geofence trigger channels');
      }
    }
  } catch (error) {
    logger.error('  ❌ Failed to migrate geofence triggers:', error);
  }

  // 4. Auto-ack channels (comma-separated string of indexes)
  try {
    const raw = await settingsGet('autoAckChannels');
    if (raw && raw.trim()) {
      const channels = raw.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      const newChannels = channels.map(ch => map.get(ch) ?? ch);
      if (JSON.stringify(newChannels) !== JSON.stringify(channels)) {
        await settingsSet('autoAckChannels', newChannels.join(','));
        logger.info('  ✅ Updated auto-ack channels');
      }
    }
  } catch (error) {
    logger.error('  ❌ Failed to migrate auto-ack channels:', error);
  }

  // 5. Notification preferences per user
  if (getAllNotificationPrefs && updateNotificationPrefs) {
    try {
      const allPrefs = await getAllNotificationPrefs();
      for (const pref of allPrefs) {
        if (pref.enabledChannels && pref.enabledChannels.length > 0) {
          const newChannels = pref.enabledChannels.map(ch => map.get(ch) ?? ch);
          if (JSON.stringify(newChannels) !== JSON.stringify(pref.enabledChannels)) {
            await updateNotificationPrefs(pref.userId, newChannels);
            logger.info(`  ✅ Updated notification channels for user ${pref.userId}`);
          }
        }
      }
    } catch (error) {
      logger.error('  ❌ Failed to migrate notification preferences:', error);
    }
  }

  logger.info('🔄 Automation channel migration complete');
}
