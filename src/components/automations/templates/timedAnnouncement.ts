/**
 * Timed Announcement template (#5515, Timed Events). Quick-creates one
 * scheduled automation that posts a message to the chosen channels on the
 * chosen sources (Meshtastic and MeshCore can be mixed) every N minutes
 * between a start and an end, then turns itself off.
 *
 * It is `trigger.schedule` with a start/end window plus one
 * `action.sendMessage`, built via the shared `compile()` so the result opens
 * in the builder like any hand-made rule.
 *
 * AIRTIME: one fire sends to every chosen channel on every chosen source. The
 * interval choices start at the engine's 5-minute minimum
 * (SCHEDULE_MIN_INTERVAL_MINUTES in src/types/scheduleWindow.ts).
 */
import { compile, type WorkflowForm } from '../compile';
import { readScheduleWindow } from '../../../types/scheduleWindow';
import type { AutomationTemplate, BuiltAutomation, ParamSpec } from './types';

/** Interval choice → cron. Every option divides the hour, so fires land on round times. */
const INTERVAL_CRON: Record<string, string> = {
  '5': '*/5 * * * *',
  '10': '*/10 * * * *',
  '15': '*/15 * * * *',
  '30': '*/30 * * * *',
  '60': '0 * * * *',
  '120': '0 */2 * * *',
  '360': '0 */6 * * *',
  '1440': '0 9 * * *',
};
const DEFAULT_INTERVAL = '30';

function asSourceIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

function asChannelSelection(v: unknown): Array<{ name: string; protocol?: string }> {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is { name: string; protocol?: string } =>
    !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).name === 'string');
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

const PARAMS: ParamSpec[] = [
  { name: 'text', label: 'Message', kind: 'textarea', placeholder: 'Net check-in is open on this channel until noon.' },
  { name: 'sourceIds', label: 'Send via sources', kind: 'sendSourceMulti', help: 'Which radios send it. MQTT sources are receive-only and excluded.' },
  { name: 'channels', label: 'On channels', kind: 'channelMulti', help: 'Every chosen channel gets the message on every chosen source that has it.' },
  {
    // '30' MUST stay first: the form seeds a select from options[0].
    name: 'interval', label: 'Repeat', kind: 'select',
    options: [
      { value: '30', label: 'Every 30 minutes' },
      { value: '5', label: 'Every 5 minutes' },
      { value: '10', label: 'Every 10 minutes' },
      { value: '15', label: 'Every 15 minutes' },
      { value: '60', label: 'Every hour' },
      { value: '120', label: 'Every 2 hours' },
      { value: '360', label: 'Every 6 hours' },
      { value: '1440', label: 'Once a day at 09:00' },
    ],
    help: 'Each repeat sends one message per channel per source. A short repeat on many channels uses a lot of airtime.',
  },
  { name: 'startAt', label: 'Start', kind: 'datetimeLocal', help: 'Leave blank to start now.' },
  { name: 'endAt', label: 'End', kind: 'datetimeLocal', help: 'The automation turns itself off at this time. Leave blank to run until you turn it off.' },
  { name: 'timezone', label: 'Time zone', kind: 'timeZone', help: 'Zone the times above are in. Blank = your browser\'s zone.' },
];

function build(values: Record<string, unknown>): BuiltAutomation {
  const cron = INTERVAL_CRON[text(values.interval)] ?? INTERVAL_CRON[DEFAULT_INTERVAL];
  const triggerParams: Record<string, unknown> = { cron };

  // Keep only a window that validates: a half-typed date must not produce an
  // automation the server rejects.
  const candidate = {
    startAt: text(values.startAt),
    endAt: text(values.endAt),
    timezone: text(values.timezone) || browserTimeZone(),
  };
  const window = readScheduleWindow(candidate);
  if (window.errors.length === 0) {
    if (candidate.startAt) triggerParams.startAt = candidate.startAt;
    if (candidate.endAt) triggerParams.endAt = candidate.endAt;
    if (candidate.startAt || candidate.endAt || text(values.timezone)) triggerParams.timezone = candidate.timezone;
  }

  const sendParams: Record<string, unknown> = { text: text(values.text) };
  const sourceIds = asSourceIds(values.sourceIds);
  const channels = asChannelSelection(values.channels);
  if (sourceIds.length > 0) sendParams.sourceIds = sourceIds;
  if (channels.length > 0) sendParams.channels = channels;

  const form: WorkflowForm = {
    trigger: { type: 'trigger.schedule', params: triggerParams },
    rules: [{ conditions: [], actions: [{ type: 'action.sendMessage', params: sendParams }] }],
    combine: null,
  };

  return {
    name: 'Timed Announcement',
    description: 'Posts a message to the chosen channels on a repeat, between a start and an end time.',
    config: compile(form),
  };
}

export const timedAnnouncementTemplate: AutomationTemplate = {
  id: 'timed-announcement',
  name: 'Timed Announcement',
  description: 'Post a message to several Meshtastic and MeshCore channels on a repeat, from a start time to an end time. It turns itself off when the event ends.',
  icon: 'timer',
  tags: ['Schedule', 'Announcement'],
  params: PARAMS,
  build,
};
