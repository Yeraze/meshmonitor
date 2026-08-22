/**
 * Time formatters for the Unified Messages view, extracted so they can be
 * unit-tested without rendering the page (same pattern as unifiedSenderLabels).
 */

/** Message-card timestamp — minute precision (seconds would be visual noise). */
export function formatTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Reception "Heard" column time — second-level precision (#4869). Relay-delay
 * and telemetry-correlation analysis needs seconds, which `formatTime`
 * deliberately omits for the message list.
 */
export function formatTimeWithSeconds(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
