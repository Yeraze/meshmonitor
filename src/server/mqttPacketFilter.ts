/**
 * Filter pipeline for MQTT-ingested Meshtastic ServiceEnvelopes.
 *
 * Two passes:
 *   preFilter()  — cheap checks done against topic + envelope metadata before
 *                  inner-payload decode (topic regex, channel, nodes, portnum)
 *   postFilter() — only for filters that need decoded payload (geo bbox on Position)
 *
 * Each dropped dimension is counted so the source's `getStatus()` can report
 * what's being filtered.
 */

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

export interface ServiceEnvelopeShape {
  packet?: {
    from?: number | bigint;
    to?: number | bigint;
    decoded?: {
      portnum?: number;
    };
  };
  channelId?: string;
  gatewayId?: string;
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
  private readonly channelAllow: Set<string>;
  private readonly channelBlock: Set<string>;
  private readonly nodeAllow: Set<string>;
  private readonly nodeBlock: Set<string>;
  private readonly portnumAllow: Set<number>;
  private readonly portnumBlock: Set<number>;
  private readonly geo: MqttFilterConfig['geo'];

  private readonly dropped: MqttFilterDropCounters = {
    topic: 0,
    channel: 0,
    node: 0,
    portnum: 0,
    geo: 0,
  };

  constructor(config: MqttFilterConfig = {}) {
    this.topicAllow = (config.topics?.allow ?? []).map(mqttPatternToRegExp);
    this.topicBlock = (config.topics?.block ?? []).map(mqttPatternToRegExp);
    this.channelAllow = new Set(config.channels?.allow ?? []);
    this.channelBlock = new Set(config.channels?.block ?? []);
    this.nodeAllow = new Set((config.nodes?.allow ?? []).map(normalizeNodeId));
    this.nodeBlock = new Set((config.nodes?.block ?? []).map(normalizeNodeId));
    this.portnumAllow = new Set(config.portnums?.allow ?? []);
    this.portnumBlock = new Set(config.portnums?.block ?? []);
    this.geo = config.geo;
  }

  /**
   * Returns true if the topic + envelope passes all pre-decode filters.
   * Increments drop counters for the dimension that caused rejection.
   */
  preFilter(topic: string, envelope: ServiceEnvelopeShape | null | undefined): boolean {
    if (this.topicBlock.some((rx) => rx.test(topic))) {
      this.dropped.topic++;
      return false;
    }
    if (this.topicAllow.length > 0 && !this.topicAllow.some((rx) => rx.test(topic))) {
      this.dropped.topic++;
      return false;
    }

    const channelId = envelope?.channelId;
    if (channelId) {
      if (this.channelBlock.has(channelId)) {
        this.dropped.channel++;
        return false;
      }
      if (this.channelAllow.size > 0 && !this.channelAllow.has(channelId)) {
        this.dropped.channel++;
        return false;
      }
    } else if (this.channelAllow.size > 0) {
      // envelope had no channelId but the user wants to allow only certain channels
      this.dropped.channel++;
      return false;
    }

    const fromNum = envelope?.packet?.from !== undefined ? Number(envelope.packet.from) : undefined;
    const toNum = envelope?.packet?.to !== undefined ? Number(envelope.packet.to) : undefined;
    const fromId = fromNum ? nodeNumToId(fromNum) : undefined;
    const toId = toNum ? nodeNumToId(toNum) : undefined;
    if (fromId && this.nodeBlock.has(fromId)) { this.dropped.node++; return false; }
    if (toId && this.nodeBlock.has(toId)) { this.dropped.node++; return false; }
    if (this.nodeAllow.size > 0) {
      const fromAllowed = !!(fromId && this.nodeAllow.has(fromId));
      const toAllowed = !!(toId && this.nodeAllow.has(toId));
      if (!fromAllowed && !toAllowed) {
        this.dropped.node++;
        return false;
      }
    }

    const portnum = envelope?.packet?.decoded?.portnum;
    if (typeof portnum === 'number') {
      if (this.portnumBlock.has(portnum)) {
        this.dropped.portnum++;
        return false;
      }
      if (this.portnumAllow.size > 0 && !this.portnumAllow.has(portnum)) {
        this.dropped.portnum++;
        return false;
      }
    } else if (this.portnumAllow.size > 0) {
      // No portnum (encrypted/unknown) but user wants a specific allow-list
      this.dropped.portnum++;
      return false;
    }

    return true;
  }

  /**
   * Geo bounding-box check for decoded Position payloads.
   * If no geo filter is configured, always passes.
   * If a geo filter is configured but the packet has no position, always passes
   * (geo filter only constrains positions, not other packet types).
   */
  postFilterPosition(position: PositionShape | null | undefined): boolean {
    if (!this.geo) return true;
    if (!position) return true;
    const latI = position.latitudeI ?? position.latitude_i;
    const lonI = position.longitudeI ?? position.longitude_i;
    if (typeof latI !== 'number' || typeof lonI !== 'number') return true;
    const lat = latI / 1e7;
    const lon = lonI / 1e7;
    const { minLat, maxLat, minLng, maxLng } = this.geo;
    if (typeof minLat === 'number' && lat < minLat) { this.dropped.geo++; return false; }
    if (typeof maxLat === 'number' && lat > maxLat) { this.dropped.geo++; return false; }
    if (typeof minLng === 'number' && lon < minLng) { this.dropped.geo++; return false; }
    if (typeof maxLng === 'number' && lon > maxLng) { this.dropped.geo++; return false; }
    return true;
  }

  /** Snapshot of drop counters (defensive copy). */
  getDropCounters(): MqttFilterDropCounters {
    return { ...this.dropped };
  }

  resetCounters(): void {
    this.dropped.topic = 0;
    this.dropped.channel = 0;
    this.dropped.node = 0;
    this.dropped.portnum = 0;
    this.dropped.geo = 0;
  }
}

/**
 * MQTT topic patterns use `+` (single level) and `#` (multi-level tail).
 * Convert to a JS regex with anchors. Topic levels are separated by `/`.
 */
export function mqttPatternToRegExp(pattern: string): RegExp {
  // Escape regex special chars except for our wildcards
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '+') {
      regex += '[^/]+';
    } else if (ch === '#') {
      // # must be the final character and matches everything remaining (incl. empty)
      regex += '.*';
      break;
    } else if (/[.*?^${}()|[\]\\]/.test(ch)) {
      regex += '\\' + ch;
    } else {
      regex += ch;
    }
  }
  return new RegExp('^' + regex + '$');
}

function nodeNumToId(num: number): string {
  return `!${(num >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeNodeId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('!') ? trimmed.toLowerCase() : `!${trimmed.toLowerCase()}`;
}
