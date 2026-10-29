/** Helpers for TelemetryTriggerNotice (kept out of the .tsx for react-refresh). */

export const TELEMETRY_TRIGGER_NOTICE_KEY = 'automations.telemetryTriggerNotice.dismissed';

export interface NoticeAutomation {
  id: string;
  name: string;
  enabled: boolean;
  config: string;
}

/** True when the automation's trigger block is `trigger.telemetry`. */
export function usesTelemetryTrigger(config: string): boolean {
  try {
    const nodes = (JSON.parse(config) as { nodes?: Array<{ type?: unknown }> }).nodes ?? [];
    return nodes.some((n) => n?.type === 'trigger.telemetry');
  } catch {
    return false;
  }
}
