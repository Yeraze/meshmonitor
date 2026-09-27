/**
 * Automation-originated packet tracker (#5414).
 *
 * Records the packet ids MeshMonitor puts on the wire on behalf of an
 * automation (auto-ack tapbacks, auto-responder replies, auto-announce, timer
 * and geofence triggers, Automation Engine actions, auto-ping, scheduled
 * requests, ...). An `mqtt_bridge` with `dropAutomationUplinks` enabled asks
 * this tracker whether an uplink packet is one of ours and, if so, does not
 * publish it upstream.
 *
 * Why: firmware ORs `config.lora.config_ok_to_mqtt` into every phone-API
 * packet (meshtastic/firmware#11994), so MeshMonitor cannot clear the
 * ok_to_mqtt bit on a single automated send. The bridge uplink is the one
 * path MeshMonitor controls.
 *
 * Keying: one map per sending source (`sourceId`), each entry holding the
 * node number that originated it. A match needs BOTH the packet id and the
 * `from` node number, so an automation send on source A can only ever match
 * a packet that A's own node originated — never a packet from another source's
 * node that happens to share the 32-bit id.
 *
 * Bounds: entries expire after {@link AUTOMATION_PACKET_TTL_MS} and each source
 * holds at most {@link AUTOMATION_PACKET_MAX_PER_SOURCE}. Eviction is lazy (on
 * record and on lookup); there is no interval timer.
 *
 * Direction of the default: sends are MANUAL unless the caller says otherwise.
 * An untagged new automation leaks upstream (today's behaviour) rather than a
 * user's own message silently vanishing.
 */

import { randomInt } from 'node:crypto';

/** Who asked for an outbound send. Absent ⇒ `'manual'`. */
export type SendOrigin = 'automation' | 'manual';

/** An outbound packet either reaches the bridge within this window or never will. */
export const AUTOMATION_PACKET_TTL_MS = 30_000;

/** Hard cap per source. At the TTL above this is ~17 automated sends per second. */
export const AUTOMATION_PACKET_MAX_PER_SOURCE = 512;

/**
 * A fresh non-zero 32-bit packet id, for sends whose builder would otherwise
 * leave the id to the firmware (traceroutes). Zero means "firmware, pick one".
 */
export function randomPacketId(): number {
  return randomInt(1, 0x1_0000_0000);
}

interface Entry {
  fromNodeNum: number;
  expiresAt: number;
}

export class AutomationPacketTracker {
  private readonly ttlMs: number;
  private readonly maxPerSource: number;
  private readonly now: () => number;
  /** sourceId → (packetId → entry). Map insertion order = age order. */
  private readonly bySource = new Map<string, Map<number, Entry>>();

  constructor(opts?: { ttlMs?: number; maxPerSource?: number; now?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? AUTOMATION_PACKET_TTL_MS;
    this.maxPerSource = opts?.maxPerSource ?? AUTOMATION_PACKET_MAX_PER_SOURCE;
    this.now = opts?.now ?? (() => Date.now());
  }

  /**
   * Record a packet an automation on `sourceId` just sent from `fromNodeNum`.
   * Ignores id 0 (firmware-assigned, unknowable) and non-numeric input.
   */
  record(sourceId: string, fromNodeNum: number | null | undefined, packetId: number | null | undefined): void {
    if (!sourceId) return;
    if (typeof fromNodeNum !== 'number' || !Number.isFinite(fromNodeNum)) return;
    if (typeof packetId !== 'number' || !Number.isFinite(packetId)) return;
    const id = packetId >>> 0;
    if (id === 0) return;

    let map = this.bySource.get(sourceId);
    if (!map) {
      map = new Map();
      this.bySource.set(sourceId, map);
    }
    const now = this.now();
    this.evictExpired(map, now);
    // Re-insert so a re-recorded id moves to the young end.
    map.delete(id);
    map.set(id, { fromNodeNum: fromNodeNum >>> 0, expiresAt: now + this.ttlMs });
    while (map.size > this.maxPerSource) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /**
   * True when `packetId` from node `fromNodeNum` is a live automation send on
   * any source. Not one-shot: several local gateways can uplink copies of the
   * same packet, and every copy should drop.
   */
  isAutomationPacket(fromNodeNum: number | null | undefined, packetId: number | null | undefined): boolean {
    if (typeof fromNodeNum !== 'number' || !Number.isFinite(fromNodeNum)) return false;
    if (typeof packetId !== 'number' || !Number.isFinite(packetId)) return false;
    const id = packetId >>> 0;
    if (id === 0) return false;
    const from = fromNodeNum >>> 0;
    const now = this.now();
    for (const [sourceId, map] of this.bySource) {
      const entry = map.get(id);
      if (!entry) continue;
      if (entry.expiresAt <= now) {
        map.delete(id);
        if (map.size === 0) this.bySource.delete(sourceId);
        continue;
      }
      if (entry.fromNodeNum === from) return true;
    }
    return false;
  }

  /** Forget every entry for a source (e.g. when its manager is removed). */
  clearSource(sourceId: string): void {
    this.bySource.delete(sourceId);
  }

  /** Test/diagnostic helper: live + not-yet-evicted entries for a source. */
  size(sourceId: string): number {
    return this.bySource.get(sourceId)?.size ?? 0;
  }

  /** Test helper. */
  clear(): void {
    this.bySource.clear();
  }

  private evictExpired(map: Map<number, Entry>, now: number): void {
    // Oldest first; entries share one TTL, so stop at the first live one.
    for (const [id, entry] of map) {
      if (entry.expiresAt > now) break;
      map.delete(id);
    }
  }
}

/** Process-wide instance shared by the source managers and the MQTT bridges. */
export const automationPacketTracker = new AutomationPacketTracker();
