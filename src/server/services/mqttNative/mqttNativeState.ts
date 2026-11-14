/**
 * In-memory state for MQTT-native send (#4305) that hot paths read
 * synchronously. No database import, so `utils/ownNodes.ts` and the MQTT
 * ingest path can use it without pulling in the send service.
 *
 * - Identity cache: sourceId -> generated node number. Read by
 *   `getOwnNodeNums()`, so the #3914 self-origin guard (automations, push
 *   notifications, node discovery) treats our MQTT-native node as ours on
 *   every source that hears it.
 * - Echo tracker: the (source, from, id) of every packet we published in the
 *   last few minutes, so our own publish coming back from the broker on the
 *   same source is recognised and dropped before ingest.
 */

const identityNodeNums = new Map<string, number>();

/** Remember (or replace) a source's MQTT-native node number. */
export function rememberMqttNativeIdentity(sourceId: string, nodeNum: number): void {
  identityNodeNums.set(sourceId, nodeNum >>> 0);
}

/** Forget a source's identity (source deleted). */
export function forgetMqttNativeIdentity(sourceId: string): void {
  identityNodeNums.delete(sourceId);
  for (const key of echoes.keys()) {
    if (key.startsWith(`${sourceId}:`)) echoes.delete(key);
  }
}

/** Every MQTT-native node number MeshMonitor owns, across sources. */
export function getMqttNativeNodeNums(): number[] {
  return [...new Set(identityNodeNums.values())];
}

/** The MQTT-native node number of one source, if it has an identity. */
export function getMqttNativeNodeNum(sourceId: string): number | null {
  return identityNodeNums.get(sourceId) ?? null;
}

// ─── Echo tracker ─────────────────────────────────────────────────────────

/** How long a published packet is remembered as ours. */
export const ECHO_TTL_MS = 10 * 60_000;
/** Cap on remembered packets; the hourly send cap keeps real use far below it. */
const ECHO_MAX_ENTRIES = 2_000;

const echoes = new Map<string, number>();

function echoKey(sourceId: string, fromNum: number, packetId: number): string {
  return `${sourceId}:${fromNum >>> 0}:${packetId >>> 0}`;
}

/** Record a packet this source is about to publish. */
export function trackMqttNativePublish(sourceId: string, fromNum: number, packetId: number, now = Date.now()): void {
  if (echoes.size >= ECHO_MAX_ENTRIES) {
    for (const [k, until] of echoes) if (until <= now) echoes.delete(k);
    while (echoes.size >= ECHO_MAX_ENTRIES) {
      const oldest = echoes.keys().next().value;
      if (oldest === undefined) break;
      echoes.delete(oldest);
    }
  }
  echoes.set(echoKey(sourceId, fromNum, packetId), now + ECHO_TTL_MS);
}

/** Forget a tracked packet (its publish failed, so no echo will come). */
export function untrackMqttNativePublish(sourceId: string, fromNum: number, packetId: number): void {
  echoes.delete(echoKey(sourceId, fromNum, packetId));
}

/**
 * True when `(fromNum, packetId)` arriving on `sourceId` is a packet this same
 * source published as its MQTT-native identity.
 */
export function isMqttNativeEcho(
  sourceId: string,
  fromNum: number | null | undefined,
  packetId: number | null | undefined,
  now = Date.now(),
): boolean {
  if (fromNum == null || packetId == null) return false;
  const own = identityNodeNums.get(sourceId);
  if (own === undefined || own !== (fromNum >>> 0)) return false;
  const until = echoes.get(echoKey(sourceId, fromNum, packetId));
  return until !== undefined && until > now;
}

/** Test hook. */
export function resetMqttNativeStateForTesting(): void {
  identityNodeNums.clear();
  echoes.clear();
}
