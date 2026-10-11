/**
 * Start/end window of a `trigger.schedule` automation (#5515, Timed Events).
 *
 * The window is stored as wall-clock strings (`YYYY-MM-DDTHH:MM`, what an
 * `<input type="datetime-local">` emits) plus an IANA time zone, because a
 * person plans an event in local time: "Oct 3, 8:00 to 12:00". The cron runs
 * in the same zone. Shared by the server (validation, the engine) and the
 * builder, so it has no dependencies.
 */

/** Fastest a scheduled automation may fire. A save below this is rejected. */
export const SCHEDULE_MIN_INTERVAL_MS = 5 * 60_000;
export const SCHEDULE_MIN_INTERVAL_MINUTES = SCHEDULE_MIN_INTERVAL_MS / 60_000;

/**
 * The one exception: a rule whose only actions are `action.tracePathSchedule`
 * (#5723). That step is built to be polled each minute and decides for itself
 * what is due, under its own stored limits (10 minutes per path, 12 traces per
 * source per hour), so a tick that finds nothing due sends nothing.
 */
export const SCHEDULE_SELF_PACED_MIN_INTERVAL_MS = 60_000;

/** Minimum fire interval for a scheduled graph, by what its actions are. */
export function scheduleMinIntervalMs(nodes: Array<{ type: string }>): number {
  const actions = nodes.filter((n) => n.type.startsWith('action.'));
  const selfPaced = actions.length > 0 && actions.every((n) => n.type === 'action.tracePathSchedule');
  return selfPaced ? SCHEDULE_SELF_PACED_MIN_INTERVAL_MS : SCHEDULE_MIN_INTERVAL_MS;
}

const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timeZone` from UTC at an instant, in ms (east is positive). */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Epoch ms of a wall-clock time in a zone, or null when the string is not a
 * real `YYYY-MM-DDTHH:MM` date or the zone is unknown. A time that a
 * daylight-saving jump skips resolves to the instant just after the jump.
 */
export function zonedWallTimeToEpochMs(local: string, timeZone: string): number | null {
  const m = LOCAL_DATETIME_RE.exec(local.trim());
  if (!m || !isValidTimeZone(timeZone)) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  // Reject 2026-02-31 and 25:00: Date.UTC rolls them over silently.
  const back = new Date(guess);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
      || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) return null;
  const first = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(first, timeZone);
  return second;
}

export interface ScheduleWindow {
  /** IANA zone the cron and the window run in; null = the server's zone, no window. */
  timeZone: string | null;
  /** First instant the rule may fire, or null for "no start". */
  startMs: number | null;
  /** Instant the rule ends (it does not fire at or after it), or null for "no end". */
  endMs: number | null;
  errors: string[];
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Read the window off a schedule trigger's params. A rule with no start, end
 * or zone has none, which is every rule saved before #5515.
 */
export function readScheduleWindow(params: Record<string, unknown> | undefined | null): ScheduleWindow {
  const startAt = text(params?.startAt);
  const endAt = text(params?.endAt);
  const timeZone = text(params?.timezone);
  const errors: string[] = [];
  if (timeZone && !isValidTimeZone(timeZone)) {
    errors.push(`time zone "${timeZone}" is not a known IANA zone (for example America/New_York)`);
    return { timeZone: null, startMs: null, endMs: null, errors };
  }
  if ((startAt || endAt) && !timeZone) {
    errors.push('a start or end date needs a time zone');
    return { timeZone: null, startMs: null, endMs: null, errors };
  }
  let startMs: number | null = null;
  let endMs: number | null = null;
  if (startAt) {
    startMs = zonedWallTimeToEpochMs(startAt, timeZone);
    if (startMs === null) errors.push(`start "${startAt}" is not a date and time (YYYY-MM-DDTHH:MM)`);
  }
  if (endAt) {
    endMs = zonedWallTimeToEpochMs(endAt, timeZone);
    if (endMs === null) errors.push(`end "${endAt}" is not a date and time (YYYY-MM-DDTHH:MM)`);
  }
  if (startMs !== null && endMs !== null && endMs <= startMs) errors.push('the end must be after the start');
  return { timeZone: timeZone || null, startMs, endMs, errors };
}

/** True when the rule's end has passed: it will not fire again until the dates change. */
export function scheduleHasEnded(params: Record<string, unknown> | undefined | null, now: number): boolean {
  const w = readScheduleWindow(params);
  return w.errors.length === 0 && w.endMs !== null && w.endMs <= now;
}
