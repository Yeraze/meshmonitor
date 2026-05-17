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
  decoded?: { portnum?: number; payload?: Uint8Array };
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
   */
  postFilterPosition(position: PositionShape | null): boolean {
    if (!this.geo || !position) return true;
    const latI = position.latitudeI ?? position.latitude_i;
    const lngI = position.longitudeI ?? position.longitude_i;
    if (typeof latI !== 'number' || typeof lngI !== 'number') return true;
    const lat = latI / 1e7;
    const lng = lngI / 1e7;
    const { minLat, maxLat, minLng, maxLng } = this.geo;
    if (typeof minLat === 'number' && lat < minLat) {
      this.drops.geo++;
      return false;
    }
    if (typeof maxLat === 'number' && lat > maxLat) {
      this.drops.geo++;
      return false;
    }
    if (typeof minLng === 'number' && lng < minLng) {
      this.drops.geo++;
      return false;
    }
    if (typeof maxLng === 'number' && lng > maxLng) {
      this.drops.geo++;
      return false;
    }
    return true;
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
