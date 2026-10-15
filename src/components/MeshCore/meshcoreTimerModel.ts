/**
 * MeshCore Timer Trigger shape and rules (#5812).
 *
 * The validation is what the old section applied: a new trigger needs a name
 * (the old Add card's rule), a cron schedule must parse, and an interval must
 * be a positive number of minutes.
 */
import { isValidCron } from 'cron-validator';
import type { ScopeMode } from './ScopeSelectField';
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
  channelIndex?: number;
  contactPublicKey?: string;
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
  channelIndex: 0,
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

type TFn = (key: string, fallback: string) => string;

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
  return errs;
}

export function hasMeshCoreTimerErrors(errs: MeshCoreTimerErrors): boolean {
  return Object.values(errs).some(Boolean);
}
