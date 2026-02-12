/**
 * Checks if the current server-local time falls within a time window.
 *
 * @param startTime - Start time in "HH:MM" format (24-hour)
 * @param endTime - End time in "HH:MM" format (24-hour)
 * @returns true if the current time is within the window
 *
 * Same-day window (e.g., 08:00-17:00): current >= start && current < end
 * Overnight window (e.g., 22:00-06:00): current >= start || current < end
 * Equal start/end: always active (24h window)
 */
export function isWithinTimeWindow(startTime: string, endTime: string): boolean {
  if (startTime === endTime) return true;

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM] = endTime.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes < endMinutes) {
    // Same-day window: e.g. 08:00-17:00
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight window: e.g. 22:00-06:00
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}
