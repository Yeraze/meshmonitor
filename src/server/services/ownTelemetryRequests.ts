/**
 * Telemetry requests WE sent, kept so a reading that answers one can be told
 * apart from a reading the node sent on its own.
 *
 * Why it exists: `trigger.telemetry` → `action.requestData` (op telemetry,
 * target = the triggering node) → the node replies with telemetry → the trigger
 * fires again → another request. The reply comes from a remote node, so the
 * #3914 self-origin guard does not stop it. A reading that answers one of our
 * own requests must not fire a telemetry trigger.
 *
 * Firmware echoes the request's MeshPacket id as the reply's `decoded.requestId`,
 * so we key by the request packet id.
 *
 * Process-wide (not per manager) on purpose: a request sent through a TCP
 * source can be answered on an MQTT source that hears the same mesh, and the
 * TCP manager's own pending map is per manager and is cleared as soon as its
 * copy of the reply lands, so it can't answer for the MQTT copy.
 *
 * In-memory only. That is fine here: after a restart there are no requests in
 * flight, so no stored state is needed. Bounded by TTL and a size cap.
 */

/** How long a request id stays recognised. A reply after this is treated as unsolicited. */
export const OWN_TELEMETRY_REQUEST_TTL_MS = 10 * 60 * 1000;
/** Hard cap on remembered ids; the oldest go first. */
export const OWN_TELEMETRY_REQUEST_MAX = 1024;

const sentAt = new Map<number, number>();

function prune(now: number): void {
  for (const [id, ts] of sentAt) {
    if (now - ts > OWN_TELEMETRY_REQUEST_TTL_MS) sentAt.delete(id);
    else break; // insertion order = send order, so the rest are newer
  }
  while (sentAt.size > OWN_TELEMETRY_REQUEST_MAX) {
    const oldest = sentAt.keys().next().value;
    if (oldest === undefined) break;
    sentAt.delete(oldest);
  }
}

/** Remember the packet id of a telemetry request we just sent. */
export function recordOwnTelemetryRequest(packetId: number | null | undefined, now: number = Date.now()): void {
  const id = Number(packetId);
  if (!id) return;
  sentAt.delete(id); // re-insert so it moves to the newest end
  sentAt.set(id, now);
  prune(now);
}

/** True when `requestId` (a reply's `decoded.requestId`) names a telemetry request we sent. */
export function isAnswerToOwnTelemetryRequest(requestId: number | null | undefined, now: number = Date.now()): boolean {
  const id = Number(requestId);
  if (!id) return false;
  const ts = sentAt.get(id);
  if (ts == null) return false;
  if (now - ts > OWN_TELEMETRY_REQUEST_TTL_MS) {
    sentAt.delete(id);
    return false;
  }
  return true;
}

/** Test seam. */
export function resetOwnTelemetryRequestsForTests(): void {
  sentAt.clear();
}
