/**
 * MQTT packet filter
 *
 * Pure filter functions that decide whether a Meshtastic ServiceEnvelope
 * (decoded from an MQTT message) should pass through a bridge or be
 * dropped. Supports topic patterns (MQTT wildcards), channel/node/portnum
 * allow-block lists, and geographic bounding boxes for position payloads.
 */

import { PortNum } from './constants/meshtastic.js';

export interface MqttFilterConfig {
  topics?: { allow?: string[]; block?: string[] };
  channels?: { allow?: string[]; block?: string[] };
  nodes?: { allow?: string[]; block?: string[] };
  portnums?: { allow?: number[]; block?: number[] };
  geo?: { minLat?: number; maxLat?: number; minLng?: number; maxLng?: number };
}

export interface MqttFilterDropCounters {
  topic: number;
  channel: number;
  node: number;
  portnum: number;
  geo: number;
}

export interface MeshPacketShape {
  id?: number;
  from?: number;
  to?: number;
  channel?: number;
  rxTime?: number;
  rxSnr?: number;
  rxRssi?: number;
  hopLimit?: number;
  hopStart?: number;
  decoded?: { portnum?: number; payload?: Uint8Array; bitfield?: number };
  encrypted?: Uint8Array;
}

export interface ServiceEnvelopeShape {
  channelId?: string;
  gatewayId?: string;
  packet?: MeshPacketShape;
}

export interface PositionShape {
  latitudeI?: number;
  longitudeI?: number;
  latitude_i?: number;
  longitude_i?: number;
}

/**
 * Per-node bbox membership decision, cached the first time we see a
 * position for that nodeNum and refreshed on every subsequent position.
 *
 * Used by `passesMembership` to apply the bbox to *all* portnums (not just
 * POSITION_APP). Nodes we've never seen a position for are treated as
 * unknown and rejected — see "fail-closed" semantics in the class doc.
 */
type GeoMembership = 'in' | 'out';

const MEMBERSHIP_MAX = 10_000;

export class MqttPacketFilter {
  private readonly topicAllow: RegExp[];
  private readonly topicBlock: RegExp[];
  private readonly channelAllow: Set<string> | null;
  private readonly channelBlock: Set<string>;
  private readonly nodeAllow: Set<string> | null;
  private readonly nodeBlock: Set<string>;
  private readonly portAllow: Set<number> | null;
  private readonly portBlock: Set<number>;
  private readonly geo: MqttFilterConfig['geo'] | null;
  private readonly membership = new Map<number, GeoMembership>();
  private readonly drops: MqttFilterDropCounters = {
    topic: 0,
    channel: 0,
    node: 0,
    portnum: 0,
    geo: 0,
  };

  constructor(config?: MqttFilterConfig) {
    const c = config ?? {};
    this.topicAllow = (c.topics?.allow ?? []).map(mqttPatternToRegExp);
    this.topicBlock = (c.topics?.block ?? []).map(mqttPatternToRegExp);
    this.channelAllow = c.channels?.allow?.length ? new Set(c.channels.allow) : null;
    this.channelBlock = new Set(c.channels?.block ?? []);
    this.nodeAllow = c.nodes?.allow?.length
      ? new Set(c.nodes.allow.map(normalizeNodeId))
      : null;
    this.nodeBlock = new Set((c.nodes?.block ?? []).map(normalizeNodeId));
    this.portAllow = c.portnums?.allow?.length ? new Set(c.portnums.allow) : null;
    this.portBlock = new Set(c.portnums?.block ?? []);
    this.geo = c.geo ?? null;
  }

  /**
   * Cheap filter run before payload decode. Returns true if the packet
   * should pass through, false to drop. Increments the matching drop
   * counter on a reject.
   */
  preFilter(topic: string, envelope: ServiceEnvelopeShape | null): boolean {
    if (this.topicBlock.some((r) => r.test(topic))) {
      this.drops.topic++;
      return false;
    }
    if (this.topicAllow.length > 0 && !this.topicAllow.some((r) => r.test(topic))) {
      this.drops.topic++;
      return false;
    }

    const channelId = envelope?.channelId;
    if (channelId && this.channelBlock.has(channelId)) {
      this.drops.channel++;
      return false;
    }
    if (this.channelAllow) {
      if (!channelId || !this.channelAllow.has(channelId)) {
        this.drops.channel++;
        return false;
      }
    }

    const from = envelope?.packet?.from;
    const to = envelope?.packet?.to;
    const fromId = typeof from === 'number' ? nodeNumToId(from) : null;
    const toId = typeof to === 'number' ? nodeNumToId(to) : null;
    if ((fromId && this.nodeBlock.has(fromId)) || (toId && this.nodeBlock.has(toId))) {
      this.drops.node++;
      return false;
    }
    if (this.nodeAllow) {
      const fromOk = fromId !== null && this.nodeAllow.has(fromId);
      const toOk = toId !== null && this.nodeAllow.has(toId);
      if (!fromOk && !toOk) {
        this.drops.node++;
        return false;
      }
    }

    const portnum = envelope?.packet?.decoded?.portnum;
    if (typeof portnum === 'number') {
      if (this.portBlock.has(portnum)) {
        this.drops.portnum++;
        return false;
      }
      if (this.portAllow && !this.portAllow.has(portnum)) {
        this.drops.portnum++;
        return false;
      }
    } else if (this.portAllow) {
      // Allow-list set but packet has no decoded portnum (encrypted) — drop.
      this.drops.portnum++;
      return false;
    }

    return true;
  }

  /**
   * Geographic bounding box filter applied after decoding a Position
   * payload. Returns true if the position is inside the configured
   * bbox (or no bbox configured), false to drop.
   *
   * If `fromNum` is provided AND the bbox is enabled AND the position
   * carries valid coordinates, the result is cached as the node's
   * membership (in / out). `passesMembership` then uses that cache to
   * decide non-position portnums.
   */
  postFilterPosition(position: PositionShape | null, fromNum?: number): boolean {
    if (!this.geo || !position) return true;
    const latI = position.latitudeI ?? position.latitude_i;
    const lngI = position.longitudeI ?? position.longitude_i;
    if (typeof latI !== 'number' || typeof lngI !== 'number') return true;
    const lat = latI / 1e7;
    const lng = lngI / 1e7;
    const { minLat, maxLat, minLng, maxLng } = this.geo;
    const inside =
      (typeof minLat !== 'number' || lat >= minLat) &&
      (typeof maxLat !== 'number' || lat <= maxLat) &&
      (typeof minLng !== 'number' || lng >= minLng) &&
      (typeof maxLng !== 'number' || lng <= maxLng);

    if (typeof fromNum === 'number' && this.hasGeoBounds()) {
      this.recordMembership(fromNum >>> 0, inside ? 'in' : 'out');
    }

    if (!inside) {
      this.drops.geo++;
      return false;
    }
    return true;
  }

  /**
   * Non-position fail-closed membership check.
   *
   * When the bbox is enabled, every packet (TEXT, TELEMETRY, NODEINFO,
   * NEIGHBORINFO, encrypted, ...) is gated on the sender having a
   * known-inside-the-bbox membership. Senders we've never decoded a
   * position for, or that last reported a position outside the bbox,
   * are dropped — increments `drops.geo`.
   *
   * No-op (passes everything) when the bbox is not configured.
   */
  passesMembership(fromNum: number | null | undefined): boolean {
    if (!this.hasGeoBounds()) return true;
    if (typeof fromNum !== 'number') {
      this.drops.geo++;
      return false;
    }
    const status = this.membership.get(fromNum >>> 0);
    if (status === 'in') return true;
    this.drops.geo++;
    return false;
  }

  /** Test/debug helper — current membership cache size. */
  getMembershipSize(): number {
    return this.membership.size;
  }

  /**
   * Pre-seed the membership cache with "trusted" nodes — those we know
   * belong to the operator's mesh regardless of whether we have a stored
   * position for them. Used to flow MQTT-relayed packets from nodes that
   * our TCP/Meshcore sources have heard directly but whose position
   * hasn't been decoded yet (e.g. a base station with GPS disabled).
   *
   * Bypasses the bbox check on purpose: if a node is part of the local
   * mesh, its MQTT-relayed traffic should land regardless of geometry.
   * No-op when no bbox is configured (everything already passes).
   */
  seedTrustedNodes(nodeNums: Iterable<number>): number {
    if (!this.hasGeoBounds()) return 0;
    let seeded = 0;
    for (const num of nodeNums) {
      if (!Number.isFinite(num)) continue;
      this.recordMembership(num >>> 0, 'in');
      seeded++;
    }
    return seeded;
  }

  /**
   * Pre-seed the membership cache with nodes whose persisted positions are
   * inside the bbox. Used by MqttBridgeManager on start so that nodes
   * already known to be in-region don't have to re-broadcast a POSITION_APP
   * packet before their TEXT/TELEMETRY/NODEINFO traffic is accepted.
   *
   * Only seeds 'in' — never 'out'. An out-of-region node may have moved,
   * so we leave it unknown and let the next POSITION_APP packet update it.
   * Returns the number of entries actually marked. No-op when no bbox is
   * configured or for entries with invalid/zero coords.
   */
  seedMembership(
    entries: Array<{ nodeNum: number; latitudeDeg: number; longitudeDeg: number }>,
  ): number {
    if (!this.hasGeoBounds()) return 0;
    const { minLat, maxLat, minLng, maxLng } = this.geo!;
    let seeded = 0;
    for (const e of entries) {
      const lat = e.latitudeDeg;
      const lng = e.longitudeDeg;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      // 0,0 is the sentinel for "no position" elsewhere in the codebase.
      if (lat === 0 && lng === 0) continue;
      const inside =
        (typeof minLat !== 'number' || lat >= minLat) &&
        (typeof maxLat !== 'number' || lat <= maxLat) &&
        (typeof minLng !== 'number' || lng >= minLng) &&
        (typeof maxLng !== 'number' || lng <= maxLng);
      if (!inside) continue;
      this.recordMembership(e.nodeNum >>> 0, 'in');
      seeded++;
    }
    return seeded;
  }

  getDropCounters(): MqttFilterDropCounters {
    return { ...this.drops };
  }

  resetCounters(): void {
    this.drops.topic = 0;
    this.drops.channel = 0;
    this.drops.node = 0;
    this.drops.portnum = 0;
    this.drops.geo = 0;
  }

  private hasGeoBounds(): boolean {
    if (!this.geo) return false;
    return (
      typeof this.geo.minLat === 'number' ||
      typeof this.geo.maxLat === 'number' ||
      typeof this.geo.minLng === 'number' ||
      typeof this.geo.maxLng === 'number'
    );
  }

  private recordMembership(nodeNum: number, status: GeoMembership): void {
    // FIFO eviction at MEMBERSHIP_MAX. Re-inserting a key bumps it to the
    // end of insertion order, which makes refreshed nodes effectively MRU.
    if (this.membership.has(nodeNum)) {
      this.membership.delete(nodeNum);
    } else if (this.membership.size >= MEMBERSHIP_MAX) {
      const oldest = this.membership.keys().next().value;
      if (oldest !== undefined) this.membership.delete(oldest);
    }
    this.membership.set(nodeNum, status);
  }
}

// MQTT topic wildcard: `+` matches one path segment, `#` matches the rest.
// Escape regex metacharacters EXCEPT `+` and `#`, then substitute the
// wildcards. `#` is not a JS regex metachar so we handle it explicitly.
export function mqttPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*?^${}()|[\]\\]/g, '\\$&');
  const expanded = escaped.replace(/\+/g, '[^/]+').replace(/#/g, '.*');
  return new RegExp('^' + expanded + '$');
}

export function nodeNumToId(num: number): string {
  const u = (num >>> 0).toString(16).padStart(8, '0');
  return '!' + u;
}

export function normalizeNodeId(id: string): string {
  const trimmed = id.trim().toLowerCase();
  return trimmed.startsWith('!') ? trimmed : '!' + trimmed;
}

// Re-export PortNum for callers that need to build allow/block lists.
export { PortNum };
