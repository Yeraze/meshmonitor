/**
 * Local-node impersonation / spoofing detection (issue #2584).
 *
 * Meshtastic channel (broadcast) messages carry NO cryptographic sender
 * authentication — anyone holding the channel PSK can transmit a packet with a
 * forged `from` field. The most damaging case for a monitor is a packet that
 * spoofs OUR locally-connected node's number: without a guard, MeshMonitor
 * treats it as one of our own *outgoing* messages.
 *
 * The discriminators are purely structural (see meshtastic-expert brief for
 * issue #2584):
 *
 *   - A genuinely self-originated packet reaches the host as an INTERNAL/API
 *     transport with NO reception metadata (rx_snr / rx_rssi / rx_time are
 *     "never sent over the radio link") and a fresh hop count (hop_start ==
 *     hop_limit).
 *   - A packet that arrived over the air carries reception metadata and/or a
 *     decremented hop count (hop_start > hop_limit) and a radio transport
 *     (LORA / MQTT / MULTICAST_UDP).
 *
 * The one trap: our OWN packet, rebroadcast by a neighbour and overheard back
 * (or echoed by the MQTT bridge, or replayed by store-and-forward), looks
 * structurally identical to a spoof — same RF markers, `from == us`. The
 * discriminator there is the packet `id`: an overheard echo carries an `id`
 * *we* originated. Callers pass `wasRecentlySentByUs` from a short-TTL ring
 * buffer of locally-originated packet ids ({@link SentPacketIdCache}) so those
 * benign echoes are not flagged.
 *
 * This module is intentionally pure and dependency-free so it is trivially
 * unit-testable; the manager supplies the runtime inputs.
 */

import { TransportMechanism } from '../constants/meshtastic.js';

export interface SpoofDetectionInput {
  /** `from` field of the packet (the claimed origin node number). */
  fromNum: number;
  /** This source's locally-connected node number, or null if unknown. */
  localNodeNum: number | null;
  /** MeshPacket.transport_mechanism (field 21); may be undefined on older firmware. */
  transportMechanism?: number | null;
  /** Initial hop limit set by the originator. */
  hopStart?: number | null;
  /** Remaining hop limit when received. */
  hopLimit?: number | null;
  /** Receive SNR — "never sent over the radio link"; present only on RF reception. */
  rxSnr?: number | null;
  /** Receive RSSI — present only on RF reception. */
  rxRssi?: number | null;
  /** Whether the packet arrived via the MQTT bridge. */
  viaMqtt?: boolean;
  /** The packet id (for caller bookkeeping; the cache lookup result is passed via wasRecentlySentByUs). */
  packetId?: number | null;
  /**
   * True when this packet's id matches one we recently originated — i.e. it is
   * our own packet overheard / echoed / replayed, NOT a spoof.
   */
  wasRecentlySentByUs?: boolean;
}

export interface SpoofDetectionResult {
  /**
   * True only when the packet is genuinely our own local transmission as seen
   * by the host (INTERNAL/API transport, no RX metadata, fresh hop count).
   * This is the *only* case that should be classified as a `tx` direction.
   */
  isGenuineLocalTx: boolean;
  /**
   * True when the packet claims `from == localNodeNum` but bears RF-reception
   * markers and was not recently sent by us — a likely impersonation of our
   * local node.
   */
  spoofSuspected: boolean;
}

/** Transports that represent a genuine local origin (not received over the air). */
function isLocalOriginTransport(transportMechanism: number | null | undefined): boolean {
  // proto3 default is 0 (INTERNAL); treat undefined as INTERNAL too. API (7) is
  // a host-injected packet, which is also locally originated.
  return (
    transportMechanism === undefined ||
    transportMechanism === null ||
    transportMechanism === TransportMechanism.INTERNAL ||
    transportMechanism === TransportMechanism.API
  );
}

/**
 * Whether a packet bears any marker proving it was received over the air rather
 * than originated locally. Conservative: a marker must be unambiguously present
 * (rx SNR/RSSI default to 0 on self-origin, so 0 is NOT treated as a marker).
 */
export function hasRfReceptionMarkers(input: SpoofDetectionInput): boolean {
  const { transportMechanism, hopStart, hopLimit, rxSnr, rxRssi, viaMqtt } = input;

  // Reception signal metadata — only sent to the host for RF receptions.
  if (rxSnr !== undefined && rxSnr !== null && rxSnr !== 0) return true;
  if (rxRssi !== undefined && rxRssi !== null && rxRssi !== 0) return true;

  // Travelled at least one hop (originator set hop_start, relays decremented hop_limit).
  if (
    hopStart !== undefined && hopStart !== null &&
    hopLimit !== undefined && hopLimit !== null &&
    hopStart > hopLimit
  ) {
    return true;
  }

  // Arrived via the MQTT bridge.
  if (viaMqtt === true) return true;

  // A radio transport mechanism (anything that isn't INTERNAL/API). Per the
  // protocol brief this field is recent, so it is only ever an *additional*
  // positive signal here — its absence never clears the markers above.
  if (
    transportMechanism !== undefined && transportMechanism !== null &&
    !isLocalOriginTransport(transportMechanism)
  ) {
    return true;
  }

  return false;
}

/**
 * Classify a packet's relationship to our local node.
 *
 * Only concerns itself with packets claiming `from == localNodeNum` (Phase 1 of
 * #2584 — self-node spoofing). Packets from any other node return all-false.
 */
export function detectLocalNodeSpoof(input: SpoofDetectionInput): SpoofDetectionResult {
  const { fromNum, localNodeNum } = input;

  // Unknown local node, or not claiming to be us → out of scope for self-spoofing.
  if (localNodeNum === null || localNodeNum === undefined || fromNum !== localNodeNum) {
    return { isGenuineLocalTx: false, spoofSuspected: false };
  }

  // Claims to be us. Is it a genuine local transmission (internal, fresh, no RX)?
  if (isLocalOriginTransport(input.transportMechanism) && !hasRfReceptionMarkers(input)) {
    return { isGenuineLocalTx: true, spoofSuspected: false };
  }

  // It claims to be us but arrived over the air. If it's a packet we originated
  // (overheard rebroadcast / MQTT echo / S&F replay), it's benign.
  if (input.wasRecentlySentByUs) {
    return { isGenuineLocalTx: false, spoofSuspected: false };
  }

  // Claims to be us, has RF markers, and we never sent it → spoof candidate.
  if (hasRfReceptionMarkers(input)) {
    return { isGenuineLocalTx: false, spoofSuspected: true };
  }

  // Claims to be us, non-internal transport but no concrete RF markers and not
  // in our sent buffer — ambiguous (e.g. odd firmware). Don't claim genuine,
  // don't raise a false alarm.
  return { isGenuineLocalTx: false, spoofSuspected: false };
}

/**
 * Short-TTL set of packet ids we recently originated, used to recognise our own
 * packets when they are overheard rebroadcast, echoed by MQTT, or replayed by
 * store-and-forward — so they are not mistaken for spoofs.
 *
 * One instance per source manager. Bounded by both age and size; both are
 * cheap caps, not exact LRU. `now()` is injectable for deterministic tests.
 */
export class SentPacketIdCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** packetId → expiry timestamp (ms). */
  private readonly entries = new Map<number, number>();

  constructor(opts?: { ttlMs?: number; maxEntries?: number; now?: () => number }) {
    // Meshtastic packet ids are "unique on a per-sender basis for a few
    // minutes"; 10 minutes comfortably covers rebroadcast/echo/replay windows.
    this.ttlMs = opts?.ttlMs ?? 10 * 60 * 1000;
    this.maxEntries = opts?.maxEntries ?? 2000;
    this.now = opts?.now ?? (() => Date.now());
  }

  /** Record a packet id we just originated. id 0 / null is ignored. */
  record(packetId: number | null | undefined): void {
    if (packetId === null || packetId === undefined || packetId === 0) return;
    const expiry = this.now() + this.ttlMs;
    // Re-insert so the key keeps roughly-insertion order for the size-cap evict.
    this.entries.delete(packetId);
    this.entries.set(packetId, expiry);
    if (this.entries.size > this.maxEntries) {
      // Evict oldest insertion (Map preserves insertion order).
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** True if we recently originated this packet id (and it hasn't expired). */
  has(packetId: number | null | undefined): boolean {
    if (packetId === null || packetId === undefined || packetId === 0) return false;
    const expiry = this.entries.get(packetId);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      this.entries.delete(packetId);
      return false;
    }
    return true;
  }

  /** Test/diagnostic helper. */
  get size(): number {
    return this.entries.size;
  }
}
