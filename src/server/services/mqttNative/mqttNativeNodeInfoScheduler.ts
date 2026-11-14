/**
 * NodeInfo announce cadence for MQTT-native send (#4305).
 *
 * Once when the feature is first enabled on a source, then every 3 hours.
 * Every check is due-based against `mqtt_native_identities.lastNodeInfoAt`,
 * which only a real send writes:
 *   - starting (or restarting) the scheduler is not a trigger: the first tick
 *     runs a full interval after start and sends only when the stored time
 *     says it is due;
 *   - saving settings calls {@link checkMqttNativeNodeInfoNow}, which is the
 *     same due check, so a save sends nothing unless an announce is due, and
 *     no save path writes or clears the timestamp;
 *   - turning the feature off and on again inside 3 hours sends nothing (the
 *     last announce is still fresh), so toggling cannot spam NodeInfo.
 * A failed publish (nothing went out) backs off for 10 minutes per source.
 */
import { logger } from '../../../utils/logger.js';
import { sourceManagerRegistry } from '../../sourceManagerRegistry.js';
import { isMqttConnectionStatusManager } from '../../sourceManagerTypes.js';
import { sendMqttNativeNodeInfoIfDue, type NodeInfoOutcome } from './mqttNativeSendService.js';

export const MQTT_NATIVE_SCHEDULER_TICK_MS = 60_000;
export const MQTT_NATIVE_FAILURE_BACKOFF_MS = 10 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
const backoffUntil = new Map<string, number>();

async function checkSource(sourceId: string, now: () => number): Promise<NodeInfoOutcome | 'backoff'> {
  const until = backoffUntil.get(sourceId);
  if (until !== undefined && until > now()) return 'backoff';
  const outcome = await sendMqttNativeNodeInfoIfDue(sourceId, now);
  if (outcome === 'failed') backoffUntil.set(sourceId, now() + MQTT_NATIVE_FAILURE_BACKOFF_MS);
  else backoffUntil.delete(sourceId);
  return outcome;
}

/** One pass over every MQTT source. Exported for tests. */
export async function runMqttNativeNodeInfoTick(now: () => number = Date.now): Promise<Record<string, NodeInfoOutcome | 'backoff'>> {
  const results: Record<string, NodeInfoOutcome | 'backoff'> = {};
  for (const manager of sourceManagerRegistry.getAllManagers()) {
    if (!isMqttConnectionStatusManager(manager)) continue;
    try {
      results[manager.sourceId] = await checkSource(manager.sourceId, now);
    } catch (err) {
      logger.warn(`[MqttNative] NodeInfo check failed for ${manager.sourceId}:`, err);
    }
  }
  return results;
}

/** Due-check one source right now (after the feature is enabled or saved). */
export async function checkMqttNativeNodeInfoNow(sourceId: string, now: () => number = Date.now): Promise<NodeInfoOutcome | 'backoff'> {
  try {
    return await checkSource(sourceId, now);
  } catch (err) {
    logger.warn(`[MqttNative] NodeInfo check failed for ${sourceId}:`, err);
    return 'failed';
  }
}

export function startMqttNativeNodeInfoScheduler(): void {
  if (timer) return;
  timer = setInterval(() => { void runMqttNativeNodeInfoTick(); }, MQTT_NATIVE_SCHEDULER_TICK_MS);
  timer.unref?.();
}

export function stopMqttNativeNodeInfoScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  backoffUntil.clear();
}

/** Test hook. */
export function resetMqttNativeNodeInfoSchedulerForTesting(): void {
  stopMqttNativeNodeInfoScheduler();
}
