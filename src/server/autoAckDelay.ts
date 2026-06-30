/**
 * Auto-acknowledge pre-send delay (#3876).
 *
 * When the sender is (or is reached via) a repeater, an auto-ack fired the
 * instant the trigger message arrives can land while that repeater is still
 * finishing its own transmission — so a zero-hop reply is dropped. An optional
 * pre-send delay lets the path settle before we reply. Mirrors the
 * `autoWelcomeDelay` precedent, but defaults to 0 (off) so existing installs
 * keep their current immediate-send behavior until a delay is configured.
 *
 * Used by both the Meshtastic (`autoAckPreSendDelaySeconds`) and MeshCore
 * (`meshcoreAutoAckPreSendDelaySeconds`) auto-ack handlers.
 */
export const AUTO_ACK_PRESEND_DELAY_DEFAULT_SECONDS = 0;
export const AUTO_ACK_PRESEND_DELAY_MAX_SECONDS = 120;

/**
 * Resolve a stored auto-ack pre-send delay setting to a clamped number of
 * seconds. Absent / empty / invalid / negative values mean "no delay" (0);
 * values are capped at 120s.
 */
export function resolveAutoAckPreSendDelaySeconds(raw: string | null | undefined): number {
  if (raw == null || raw === '') return AUTO_ACK_PRESEND_DELAY_DEFAULT_SECONDS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return AUTO_ACK_PRESEND_DELAY_DEFAULT_SECONDS;
  return Math.min(n, AUTO_ACK_PRESEND_DELAY_MAX_SECONDS);
}
