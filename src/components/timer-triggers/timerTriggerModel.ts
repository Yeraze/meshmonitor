/**
 * Meshtastic Timer Trigger rules (#5812): defaults, validation and the shape a
 * timer is saved in.
 *
 * The rules are the ones the old "Add New Timer" form and the inline edit form
 * applied; they moved here when both forms became the one expanded
 * TriggerCard editor.
 */
import { isValidCron } from 'cron-validator';
import type { TimerTrigger, TimerResponseType } from '../auto-responder/types';
import { newTriggerId } from '../shared/automation/triggerList';
import { normalizeTimerChannels } from '../../utils/autoResponderUtils';

type TFn = (key: string, fallback: string) => string;

/** The schedule a new timer starts with (every 6 hours). */
export const DEFAULT_TIMER_CRON = '0 */6 * * *';

/** Longest text message the editor counts toward. */
export const TIMER_MESSAGE_LIMIT = 200;

/** Per-field errors for one timer; empty when the timer is valid. */
export interface TimerTriggerErrors {
  name?: string;
  cronExpression?: string;
  scriptPath?: string;
  response?: string;
  channels?: string;
}

/**
 * The channels a timer edits as (#6230). Reads the new `channels` array when it
 * is authoritative (legacy `channel` cleared), otherwise coerces the old scalar
 * via {@link normalizeTimerChannels}. Reading `channels` directly once it is set
 * lets the editor show an empty selection as the user unchecks boxes.
 */
export function editableTimerChannels(tr: TimerTrigger): Array<number | 'none'> {
  return Array.isArray(tr.channels) && tr.channel === undefined
    ? tr.channels
    : normalizeTimerChannels(tr);
}

/** Same options the old forms passed. */
export function isValidTimerCron(expr: string | undefined | null): boolean {
  const s = (expr ?? '').trim();
  return !!s && isValidCron(s, { seconds: false, alias: true, allowBlankDay: true });
}

export function timerResponseType(tr: TimerTrigger): TimerResponseType {
  return tr.responseType || 'script';
}

export function newTimerTrigger(): TimerTrigger {
  return {
    id: newTriggerId(),
    name: '',
    cronExpression: DEFAULT_TIMER_CRON,
    responseType: 'script',
    scriptPath: '',
    channels: [0],
    enabled: true,
  };
}

export function validateTimerTrigger(tr: TimerTrigger, t: TFn): TimerTriggerErrors {
  const errs: TimerTriggerErrors = {};
  if (!tr.name.trim()) errs.name = t('automation.timer_triggers.name_required', 'Name is required');
  if (!tr.cronExpression.trim()) {
    errs.cronExpression = t('automation.timer_triggers.valid_cron_required', 'Valid cron expression is required');
  } else if (!isValidTimerCron(tr.cronExpression)) {
    errs.cronExpression = t('automation.timer_triggers.invalid_cron', 'Invalid cron expression');
  }
  const type = timerResponseType(tr);
  if (type === 'script' && !tr.scriptPath) {
    errs.scriptPath = t('automation.timer_triggers.script_required', 'Script is required');
  }
  if (type === 'text' && !(tr.response ?? '').trim()) {
    errs.response = t('automation.timer_triggers.message_required', 'Message is required');
  }
  // A text timer must target at least one real channel (#6230); 'none' is a
  // script-only "no mesh output" choice. A script timer may pick 'none'.
  const chans = editableTimerChannels(tr);
  if (type === 'text' && !chans.some((c) => c !== 'none')) {
    errs.channels = t('automation.timer_triggers.no_channels_selected', 'Select at least one channel');
  }
  return errs;
}

export function hasTimerErrors(errs: TimerTriggerErrors): boolean {
  return Object.values(errs).some(Boolean);
}

/** First error message, for a toast. */
export function firstTimerError(errs: TimerTriggerErrors): string | undefined {
  return errs.name || errs.cronExpression || errs.scriptPath || errs.response;
}

/**
 * The shape the old forms saved: trimmed name and cron, only the fields the
 * response type uses, and script args only when not blank.
 *
 * Channels (#6230) are stored in the `channels` array and the legacy single
 * `channel` is cleared, so saved timers read back through the new field. A text
 * timer cannot use the script-only "none" channel, so 'none' is dropped and an
 * empty selection falls back to channel 0.
 */
export function finalizeTimerTrigger(tr: TimerTrigger): TimerTrigger {
  const type = timerResponseType(tr);
  const args = (tr.scriptArgs ?? '').trim();
  const edited = editableTimerChannels(tr);
  const channels = type === 'text'
    ? (() => {
        const real = edited.filter((c): c is number => c !== 'none');
        return real.length > 0 ? real : [0];
      })()
    : (edited.length > 0 ? edited : [0]);
  return {
    ...tr,
    name: tr.name.trim(),
    cronExpression: tr.cronExpression.trim(),
    responseType: type,
    scriptPath: type === 'script' ? tr.scriptPath : undefined,
    scriptArgs: type === 'script' && args ? args : undefined,
    response: type === 'text' ? (tr.response ?? '').trim() : undefined,
    channels,
    channel: undefined,
    // No mesh output, nothing to split (#6330).
    multiline: tr.multiline === true && !(channels.length === 1 && channels[0] === 'none') ? true : undefined,
  };
}
