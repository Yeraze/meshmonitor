import { readScheduleWindow } from '../../types/scheduleWindow';

/**
 * One-line state of a scheduled automation's start/end window (#5515), for the
 * list: "Ended …", "Starts …" or "Until …". Null when the rule is not on a
 * schedule or has no window.
 */
export function scheduleStatus(configJson: string, now: number): string | null {
  let params: Record<string, unknown> | undefined;
  try {
    const graph = JSON.parse(configJson) as { nodes?: Array<{ type?: string; params?: Record<string, unknown> }> };
    params = graph.nodes?.find((n) => n.type === 'trigger.schedule')?.params;
  } catch {
    return null;
  }
  if (!params) return null;
  const window = readScheduleWindow(params);
  if (window.errors.length > 0 || !window.timeZone) return null;
  const at = (ms: number) => new Date(ms).toLocaleString(undefined, {
    timeZone: window.timeZone ?? undefined, dateStyle: 'medium', timeStyle: 'short',
  });
  if (window.endMs !== null && window.endMs <= now) return `Ended ${at(window.endMs)}`;
  if (window.startMs !== null && window.startMs > now) return `Starts ${at(window.startMs)}`;
  if (window.endMs !== null) return `Until ${at(window.endMs)}`;
  return null;
}
