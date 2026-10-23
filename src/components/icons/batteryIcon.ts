import type { UiIconName } from './UiIcon';

/** Meshtastic reports external power as battery level 101. */
export const PLUGGED_IN_BATTERY_LEVEL = 101;

/**
 * Pick a battery icon that shows the charge at a glance (#5946).
 * Thresholds from the requester: <10 empty, 10–50 low, 50–85 medium, >85 full.
 * An unknown level keeps the plain outline.
 */
export function batteryIconName(level: number | null | undefined): UiIconName {
  if (level == null || !Number.isFinite(level)) return 'battery';
  if (level >= PLUGGED_IN_BATTERY_LEVEL) return 'batteryCharging';
  if (level > 85) return 'batteryFull';
  if (level >= 50) return 'batteryMedium';
  if (level >= 10) return 'batteryLow';
  return 'batteryEmpty';
}
