/**
 * MeshCore Timer Trigger shape and rules (#5812).
 *
 * The validation is what the old section applied: a new trigger needs a name
 * (the old Add card's rule), a cron schedule must parse, and an interval must
 * be a positive number of minutes.
 */
import { isValidCron } from 'cron-validator';
import type { ScopeMode } from './ScopeSelectField';
import { MESHCORE_SPLIT_TIMER_MIN_INTERVAL_MINUTES } from '../../utils/meshcoreMessageLimits';
import { newTriggerId } from '../shared/automation/triggerList';
import {
  DEFAULT_MESHCORE_ADVERT_MODE,
  type MeshCoreAdvertMode,
} from '../../types/meshcoreAdvert';

/**
 * Mirrors the backend `MeshCoreTimerTrigger` shape exactly. Kept client-side
 * because the type isn't exported to the client bundle — it's a server-only
 * interface that crosses the wire as JSON.
 */
export interface MeshCoreTimerTrigger {
  id: string;
  name: string;
  enabled: boolean;
  scheduleType: 'cron' | 'interval';
  cronExpression?: string;
  intervalMinutes?: number;
  responseType: 'text' | 'advert' | 'script';
  response?: string;
  /** Advert reach for `advert` triggers. Absent on older triggers = flood. */
  advertMode?: MeshCoreAdvertMode;
  scriptPath?: string;
  scriptArgs?: string;
  destination?: 'channel' | 'dm';
  /** Channel indexes to send to when `destination === 'channel'` (#6230). */
  channelIndexes?: number[];
  /** @deprecated Use channelIndexes. Kept so old single-channel timers keep working (#6230). */
  channelIndex?: number;
  contactPublicKey?: string;
  /** Split a long message into up to 3 marked parts (#6316). Interval timers need >= 5 min. */
  multiline?: boolean;
  /** MeshCore scope/region for the sent message (#3833). */
  scopeMode?: ScopeMode;
  scopeName?: string;
  lastRun?: number;
  lastResult?: 'success' | 'error';
  lastError?: string;
}

export interface MeshCoreContactRow {
  publicKey: string;
  name: string;
}

export const DEFAULT_MESHCORE_TIMER_CRON = '0 */6 * * *';

/**
 * Back-compat reader for a MeshCore timer's target channels (#6230).
 *
 * New timers store `channelIndexes`; old ones a single `channelIndex`. A reader
 * coerces the old scalar into a one-item array so saved timers keep working
 * without a destructive migration.
 */
export function meshCoreTimerChannelIndexes(
  tr: Pick<MeshCoreTimerTrigger, 'channelIndexes' | 'channelIndex'>,
): number[] {
  if (Array.isArray(tr.channelIndexes) && tr.channelIndexes.length > 0) {
    return tr.channelIndexes;
  }
  if (typeof tr.channelIndex === 'number') {
    return [tr.channelIndex];
  }
  return [];
}

export const newMeshCoreTimerTrigger = (): MeshCoreTimerTrigger => ({
  id: newTriggerId(),
  name: '',
  enabled: true,
  scheduleType: 'cron',
  cronExpression: DEFAULT_MESHCORE_TIMER_CRON,
  intervalMinutes: 60,
  responseType: 'text',
  response: '',
  advertMode: DEFAULT_MESHCORE_ADVERT_MODE,
  destination: 'channel',
  channelIndexes: [0],
  scopeMode: 'inherit',
  scopeName: '',
});

export function isValidMeshCoreTimerCron(expr: string | undefined): boolean {
  return isValidCron(expr || '', { seconds: false, alias: true, allowBlankDay: true });
}

export interface MeshCoreTimerErrors {
  name?: string;
  cronExpression?: string;
  intervalMinutes?: string;
}

type TFn = (key: string, fallback: string, options?: Record<string, unknown>) => string;

/**
 * Errors for one trigger. `isNew` adds the name rule, which only the old Add
 * card applied; a saved trigger keeps whatever name it has.
 */
export function validateMeshCoreTimer(tr: MeshCoreTimerTrigger, isNew: boolean, t: TFn): MeshCoreTimerErrors {
  const errs: MeshCoreTimerErrors = {};
  if (isNew && !tr.name.trim()) {
    errs.name = t('meshcore.automation.timers.name_required', 'Name is required');
  }
  if (tr.scheduleType === 'cron' && !isValidMeshCoreTimerCron(tr.cronExpression)) {
    errs.cronExpression = t('meshcore.automation.timers.invalid_cron_draft', 'Invalid cron expression');
  }
  if (tr.scheduleType === 'interval' && (!Number.isFinite(tr.intervalMinutes) || (tr.intervalMinutes ?? 0) <= 0)) {
    errs.intervalMinutes = t('meshcore.automation.timers.invalid_interval_short', 'Interval must be at least 1 minute');
  }
  if (
    tr.multiline === true &&
    tr.responseType !== 'advert' &&
    tr.scheduleType === 'interval' &&
    !errs.intervalMinutes &&
    (tr.intervalMinutes ?? 0) < MESHCORE_SPLIT_TIMER_MIN_INTERVAL_MINUTES
  ) {
    errs.intervalMinutes = t(
      'automation.split_long.timer_min_interval',
      'A timer that splits long messages needs an interval of at least {{minutes}} minutes.',
      { minutes: MESHCORE_SPLIT_TIMER_MIN_INTERVAL_MINUTES },
    );
  }
  return errs;
}

export function hasMeshCoreTimerErrors(errs: MeshCoreTimerErrors): boolean {
  return Object.values(errs).some(Boolean);
}
