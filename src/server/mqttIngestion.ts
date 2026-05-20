/**
 * Shared MQTT-source packet ingestion.
 *
 * Decodes a Meshtastic ServiceEnvelope payload into rows in the
 * nodes/messages/positions/telemetry tables, attributed to the caller's
 * `sourceId`. Used by both MqttBrokerManager (ingesting packets from
 * locally-connected devices) and MqttBridgeManager (ingesting packets
 * pulled down from an upstream broker).
 *
 * v1 handles: NODEINFO_APP, POSITION_APP, TEXT_MESSAGE_APP, TELEMETRY_APP.
 * Other port numbers are skipped.
 */

import meshtasticProtobufService from './meshtasticProtobufService.js';
import { channelDecryptionService } from './services/channelDecryptionService.js';
import databaseService from '../services/database.js';

/**
 * Public Meshtastic channels that ship with the default key. Used to
 * bootstrap the channel_database for newly-created MQTT sources so the
 * decryption service can decode their traffic out of the box. Users can
 * still add/remove rows via the UI; this only inserts when no matching
 * name+psk row exists, so manual edits aren't clobbered.
 *
 * Format: `name` + 1-byte shorthand PSK (expanded by `expandShorthandPsk`
 * at cache load time — see channelDecryptionService.refreshChannelCache).
 *   0x01 → LongFast (the Meshtastic public default)
 */
const DEFAULT_MQTT_CHANNELS: ReadonlyArray<{ name: string; psk: string; pskLength: number }> = [
  { name: 'LongFast', psk: 'AQ==', pskLength: 1 },
];

/**
 * Ensure each well-known default-key channel exists in the channel_database
 * so the server-side decryption service can decrypt MQTT-relayed traffic
 * for newly added MQTT sources. Attribution is by sourceId — first MQTT
 * source to bootstrap a channel owns it. Subsequent calls are no-ops when
 * a matching row (by name, case-insensitive) already exists in any scope.
 */
export async function bootstrapMqttChannelDatabase(sourceId: string): Promise<void> {
  try {
    const existing = await databaseService.channelDatabase.getAllAsync();
    const haveName = new Set(existing.map((c) => (c.name ?? '').toLowerCase()));
    for (const ch of DEFAULT_MQTT_CHANNELS) {
      if (haveName.has(ch.name.toLowerCase())) continue;
      await databaseService.channelDatabase.createAsync({
        name: ch.name,
        psk: ch.psk,
        pskLength: ch.pskLength,
        isEnabled: true,
        enforceNameValidation: false,
        description: `Auto-seeded for MQTT decryption (default Meshtastic key)`,
        createdBy: null,
      });
      logger.info(
        `MQTT source ${sourceId} bootstrapped channel_database entry "${ch.name}" with default key`,
      );
    }
    // Pick up the new row(s) on the next decryption attempt.
    await channelDecryptionService.refreshChannelCache();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    logger.warn(`MQTT source ${sourceId} channel_database bootstrap failed: ${m}`);
  }
}
import type {
  DbNode,
  DbMessage,
  DbTelemetry,
  DbTraceroute,
  DbRouteSegment,
  DbNeighborInfo,
} from '../services/database.js';
import {
  PortNum,
  StoreForwardRequestResponse,
  getStoreForwardRequestResponseName,
  CHANNEL_DB_OFFSET,
} from './constants/meshtastic.js';
import { calculateDistance } from '../utils/distance.js';
import { logger } from '../utils/logger.js';
import {
  nodeNumToId,
  type ServiceEnvelopeShape,
  type PositionShape,
  MqttPacketFilter,
} from './mqttPacketFilter.js';

export interface MqttIngestionInput {
  sourceId: string;
  envelope: ServiceEnvelopeShape;
  /**
   * Geo filter applied to POSITION_APP payloads after decode. Pass the
   * same MqttPacketFilter instance used for preFilter so its drop counter
   * stays consistent.
   */
  filter?: MqttPacketFilter;
}

export interface MqttIngestionResult {
  ingested: boolean;
  reason?: 'no-packet' | 'no-decoded' | 'encrypted' | 'unsupported-portnum' | 'geo-filtered' | 'decode-error';
  portnum?: number;
}

export async function ingestServiceEnvelope(input: MqttIngestionInput): Promise<MqttIngestionResult> {
  const { sourceId, envelope, filter } = input;
  const packet = envelope.packet;
  if (!packet) return { ingested: false, reason: 'no-packet' };

  // Server-side channel decryption — mirror the TCP path in
  // `meshtasticManager.processMeshPacket`. Public MQTT brokers republish
  // packets in their on-wire encrypted form (`packet.encrypted` set, no
  // `packet.decoded`). If any PSK in the channel_database matches, we
  // synthesize the `decoded` field and continue with normal ingest.
  if (!packet.decoded && packet.encrypted && packet.encrypted.length > 0 && channelDecryptionService.isEnabled()) {
    const fromNum = typeof packet.from === 'number' ? packet.from >>> 0 : 0;
    const pid = typeof packet.id === 'number' ? packet.id >>> 0 : 0;
    try {
      const r = await channelDecryptionService.tryDecrypt(
        packet.encrypted,
        pid,
        fromNum,
        typeof packet.channel === 'number' ? packet.channel : undefined,
      );
      if (r.success) {
        // Carry tapback metadata (emoji, replyId) onto the synthesized
        // decoded shape so TEXT_MESSAGE_APP ingest can preserve it —
        // reactions otherwise lose their grouping in the unified view.
        // `channelDatabaseId` rides along too so the channel-resolution
        // step below can pick it up without re-running the cache scan.
        (packet as {
          decoded?: {
            portnum?: number;
            payload?: Uint8Array;
            emoji?: number;
            replyId?: number;
            channelDatabaseId?: number;
          };
        }).decoded = {
          portnum: r.portnum,
          payload: r.payload,
          emoji: r.emoji,
          replyId: r.replyId,
          channelDatabaseId: r.channelDatabaseId,
        };
      }
    } catch (err) {
      logger.debug(`MQTT ingest: server decryption error for packet from ${fromNum}: ${err}`);
    }
  }

  const decoded = packet.decoded;
  if (!decoded) return { ingested: false, reason: 'encrypted' };

  const portnum = typeof decoded.portnum === 'number' ? decoded.portnum : undefined;
  if (portnum === undefined) return { ingested: false, reason: 'no-decoded' };

  const fromNum = typeof packet.from === 'number' ? packet.from >>> 0 : null;
  const toNum = typeof packet.to === 'number' ? packet.to >>> 0 : null;
  if (fromNum === null) return { ingested: false, reason: 'no-packet' };
  const fromNodeId = nodeNumToId(fromNum);
  const toNodeId = toNum !== null ? nodeNumToId(toNum) : '!ffffffff';
  const nowMs = Date.now();

  let payload: unknown;
  try {
    payload = meshtasticProtobufService.processPayload(portnum, decoded.payload ?? new Uint8Array());
  } catch (err) {
    logger.warn(`MQTT ingest: failed to decode portnum ${portnum}: ${err}`);
    return { ingested: false, reason: 'decode-error', portnum };
  }

  // Surface the channel this packet came in on so the unified channel
  // picker shows it. Fire-and-forget: a failed upsert just means the
  // picker won't surface this channel for this source — the packet
  // ingest itself is unaffected.
  recordChannelFromEnvelope(sourceId, envelope, packet);

  // Resolve the channel_database row for this packet so downstream rows are
  // permission-keyed via channel_database_permissions instead of the raw
  // sender slot (which collides across senders on a shared MQTT broker).
  // The encoding is the same `CHANNEL_DB_OFFSET + id` convention nodeEnhancer
  // already enforces, so no schema migration is required. Falls back to the
  // raw slot if nothing resolves (e.g. an unencrypted packet on a broker
  // that strips channelId from its republished topic).
  const channelDatabaseId = await resolveChannelDatabaseIdForMqtt(envelope, packet);
  const rawSlot = typeof packet.channel === 'number' ? packet.channel : 0;
  const effectiveChannel =
    channelDatabaseId !== null ? CHANNEL_DB_OFFSET + channelDatabaseId : rawSlot;

  // Fail-closed geo membership: when a bbox is configured on the filter,
  // only allow packets from senders we've previously decoded a position
  // for AND that position was inside the bbox. POSITION_APP is exempt
  // here because the bbox check on the position payload (below) is what
  // populates the membership cache in the first place.
  if (filter && portnum !== PortNum.POSITION_APP && !filter.passesMembership(fromNum)) {
    return { ingested: false, reason: 'geo-filtered', portnum };
  }

  switch (portnum) {
    case PortNum.NODEINFO_APP: {
      const user = payload as Record<string, any>;
      const node: Partial<DbNode> = {
        nodeNum: fromNum,
        nodeId: fromNodeId,
        longName: user.longName ?? user.long_name ?? '',
        shortName: user.shortName ?? user.short_name ?? '',
        hwModel: typeof user.hwModel === 'number' ? user.hwModel : (user.hw_model ?? 0),
        role: typeof user.role === 'number' ? user.role : undefined,
        viaMqtt: true,
        macaddr: user.macaddr ? bytesToHex(user.macaddr) : undefined,
        publicKey: user.publicKey ? bytesToHex(user.publicKey) : (user.public_key ? bytesToHex(user.public_key) : undefined),
        lastHeard: Math.floor(nowMs / 1000),
        sourceId,
        createdAt: nowMs,
        updatedAt: nowMs,
      };
      databaseService.upsertNode(node);
      return { ingested: true, portnum };
    }

    case PortNum.POSITION_APP: {
      const position = payload as PositionShape & Record<string, any>;
      if (filter && !filter.postFilterPosition(position, fromNum)) {
        return { ingested: false, reason: 'geo-filtered', portnum };
      }
      const latI = position.latitudeI ?? position.latitude_i;
      const lngI = position.longitudeI ?? position.longitude_i;
      const alt = position.altitude;
      const node: Partial<DbNode> = {
        nodeNum: fromNum,
        nodeId: fromNodeId,
        longName: '',
        shortName: '',
        hwModel: 0,
        latitude: typeof latI === 'number' ? latI / 1e7 : undefined,
        longitude: typeof lngI === 'number' ? lngI / 1e7 : undefined,
        altitude: typeof alt === 'number' ? alt : undefined,
        viaMqtt: true,
        lastHeard: Math.floor(nowMs / 1000),
        sourceId,
        createdAt: nowMs,
        updatedAt: nowMs,
      };
      databaseService.upsertNode(node);
      return { ingested: true, portnum };
    }

    case PortNum.TEXT_MESSAGE_APP: {
      const text = typeof payload === 'string' ? payload : '';
      if (!text) return { ingested: false, reason: 'decode-error', portnum };
      const packetId = typeof packet.id === 'number' ? packet.id >>> 0 : 0;
      // Tapback metadata. `emoji=1` flags reactions; `reply_id` points at
      // the parent packet id. Both live as siblings of `payload` on the
      // decoded Data protobuf. When the bridge published an already-decoded
      // packet they're on `packet.decoded`; when we server-decrypted via
      // channel_database, channelDecryptionService now surfaces them on
      // the synthesized `decoded` object (see `DecryptionResult`).
      // Without these fields the unified view's `isReactionMessage` test
      // fails for MQTT-sourced reactions and they render as full inline
      // messages instead of grouping under the parent — see
      // https://github.com/Yeraze/meshmonitor/issues/3092 follow-up.
      const decodedAny = decoded as Record<string, unknown>;
      const rawEmoji =
        (decodedAny.emoji as number | undefined) ?? undefined;
      const emoji = typeof rawEmoji === 'number' && rawEmoji > 0 ? rawEmoji : undefined;
      const rawReplyId =
        (decodedAny.replyId as number | undefined) ??
        (decodedAny.reply_id as number | undefined);
      const replyId =
        typeof rawReplyId === 'number' && rawReplyId > 0 ? rawReplyId >>> 0 : undefined;
      const msg: DbMessage = {
        // Row ID uses the TCP convention `${sourceId}_${fromNum}_${packetId}`
        // — underscores, fromNum middle, packetId last — so the unified
        // dedup parser (extractPacketIdFromRowId in unifiedRoutes.ts) can
        // recover the packet ID and collapse TCP/MQTT receptions of the
        // same mesh packet into one entry with a multi-source receptions
        // array. Diverging from this format makes the same packet appear
        // N times in the unified view (one per receiving source).
        id: `${sourceId}_${fromNum}_${packetId || nowMs}`,
        fromNodeNum: fromNum,
        toNodeNum: toNum ?? 0xffffffff,
        fromNodeId,
        toNodeId,
        text,
        channel: effectiveChannel,
        portnum,
        timestamp: nowMs,
        rxTime: typeof packet.rxTime === 'number' ? packet.rxTime * 1000 : undefined,
        rxSnr: typeof packet.rxSnr === 'number' ? packet.rxSnr : undefined,
        rxRssi: typeof packet.rxRssi === 'number' ? packet.rxRssi : undefined,
        viaMqtt: true,
        emoji,
        replyId,
        createdAt: nowMs,
      } as DbMessage;
      (msg as any).sourceId = sourceId;
      // Use the repo's per-source insert — the `databaseService.insertMessage`
      // facade drops the sourceId, leaving rows orphaned (`sourceId=NULL`)
      // and invisible to source-scoped queries like /api/unified/messages.
      databaseService.messages.insertMessage(msg, sourceId);
      // Refresh lastHeard for the sender.
      databaseService.upsertNode({
        nodeNum: fromNum,
        nodeId: fromNodeId,
        longName: '',
        shortName: '',
        hwModel: 0,
        lastHeard: Math.floor(nowMs / 1000),
        viaMqtt: true,
        sourceId,
        createdAt: nowMs,
        updatedAt: nowMs,
      });
      return { ingested: true, portnum };
    }

    case PortNum.TELEMETRY_APP: {
      const t = payload as Record<string, any>;
      const ts = nowMs;
      const packetId = typeof packet.id === 'number' ? packet.id >>> 0 : undefined;
      const metricsGroups: Array<[string, any]> = [
        ['device', t.deviceMetrics ?? t.device_metrics],
        ['environment', t.environmentMetrics ?? t.environment_metrics],
        ['airQuality', t.airQualityMetrics ?? t.air_quality_metrics],
        ['power', t.powerMetrics ?? t.power_metrics],
        ['health', t.healthMetrics ?? t.health_metrics],
      ];
      let any = false;
      for (const [groupName, metrics] of metricsGroups) {
        if (!metrics || typeof metrics !== 'object') continue;
        for (const [key, val] of Object.entries(metrics)) {
          if (typeof val !== 'number') continue;
          const tel: DbTelemetry = {
            nodeId: fromNodeId,
            nodeNum: fromNum,
            telemetryType: `${groupName}.${key}`,
            timestamp: ts,
            value: val,
            createdAt: ts,
            packetId,
            packetTimestamp: typeof t.time === 'number' ? t.time * 1000 : undefined,
          };
          databaseService.insertTelemetry(tel, sourceId);
          any = true;
        }
      }
      databaseService.upsertNode({
        nodeNum: fromNum,
        nodeId: fromNodeId,
        longName: '',
        shortName: '',
        hwModel: 0,
        lastHeard: Math.floor(nowMs / 1000),
        viaMqtt: true,
        sourceId,
        createdAt: nowMs,
        updatedAt: nowMs,
      });
      return any ? { ingested: true, portnum } : { ingested: false, reason: 'decode-error', portnum };
    }

    case PortNum.TRACEROUTE_APP: {
      await ingestTraceroute(sourceId, packet, payload as Record<string, any>, fromNum, fromNodeId, toNum, toNodeId, nowMs, effectiveChannel);
      return { ingested: true, portnum };
    }

    case PortNum.NEIGHBORINFO_APP: {
      const ok = await ingestNeighborInfo(sourceId, payload as Record<string, any>, fromNum, fromNodeId, nowMs);
      return ok ? { ingested: true, portnum } : { ingested: false, reason: 'decode-error', portnum };
    }

    case PortNum.PAXCOUNTER_APP: {
      const ok = ingestPaxcounter(sourceId, packet, payload as Record<string, any>, fromNum, fromNodeId, nowMs);
      return ok ? { ingested: true, portnum } : { ingested: false, reason: 'decode-error', portnum };
    }

    case PortNum.STORE_FORWARD_APP: {
      const ok = await ingestStoreForward(sourceId, packet, payload as Record<string, any>, fromNum, fromNodeId, toNum, toNodeId, nowMs, effectiveChannel);
      return ok ? { ingested: true, portnum } : { ingested: false, reason: 'unsupported-portnum', portnum };
    }

    default:
      return { ingested: false, reason: 'unsupported-portnum', portnum };
  }
}

/**
 * TRACEROUTE_APP — persist the traceroute record, a hop-count telemetry
 * datum, and any route segments we can compute from known node positions.
 * Mirrors the TCP path's storage side (skipping presentation-only steps
 * like human-readable route text generation and the autoresponder
 * delivery hook, which don't apply to MQTT-sourced traceroutes).
 */
async function ingestTraceroute(
  sourceId: string,
  packet: any,
  routeDiscovery: Record<string, any>,
  fromNum: number,
  fromNodeId: string,
  toNum: number | null,
  toNodeId: string,
  nowMs: number,
  effectiveChannel: number,
): Promise<void> {
  const BROADCAST_ADDR = 4294967295;
  const lastHeard = Math.floor(nowMs / 1000);
  const isValidRouteNode = (n: number): boolean => n > 3 && n !== 255 && n !== 65535;

  // Refresh sender. Don't clobber an existing name.
  const existingFrom = await databaseService.nodes.getNode(fromNum, sourceId);
  await databaseService.nodes.upsertNode(
    existingFrom
      ? { nodeNum: fromNum, nodeId: fromNodeId, lastHeard, viaMqtt: true }
      : {
          nodeNum: fromNum,
          nodeId: fromNodeId,
          longName: `Node ${fromNodeId}`,
          shortName: fromNodeId.slice(-4),
          hwModel: 0,
          viaMqtt: true,
          lastHeard,
          createdAt: nowMs,
          updatedAt: nowMs,
        },
    sourceId,
  );

  if (toNum !== null && toNum !== BROADCAST_ADDR) {
    const existingTo = await databaseService.nodes.getNode(toNum, sourceId);
    await databaseService.nodes.upsertNode(
      existingTo
        ? { nodeNum: toNum, nodeId: toNodeId, lastHeard, viaMqtt: true }
        : {
            nodeNum: toNum,
            nodeId: toNodeId,
            longName: `Node ${toNodeId}`,
            shortName: toNodeId.slice(-4),
            hwModel: 0,
            viaMqtt: true,
            lastHeard,
            createdAt: nowMs,
            updatedAt: nowMs,
          },
      sourceId,
    );
  }

  const rawRoute: number[] = Array.isArray(routeDiscovery.route) ? routeDiscovery.route : [];
  const rawRouteBack: number[] = Array.isArray(routeDiscovery.routeBack) ? routeDiscovery.routeBack : [];
  const rawSnrTowards: number[] = Array.isArray(routeDiscovery.snrTowards) ? routeDiscovery.snrTowards : [];
  const rawSnrBack: number[] = Array.isArray(routeDiscovery.snrBack) ? routeDiscovery.snrBack : [];

  const route: number[] = [];
  const snrTowards: number[] = [];
  rawRoute.forEach((n, i) => {
    if (!isValidRouteNode(n)) return;
    route.push(n);
    if (rawSnrTowards[i] !== undefined) snrTowards.push(rawSnrTowards[i]);
  });
  const routeBack: number[] = [];
  const snrBack: number[] = [];
  rawRouteBack.forEach((n, i) => {
    if (!isValidRouteNode(n)) return;
    routeBack.push(n);
    if (rawSnrBack[i] !== undefined) snrBack.push(rawSnrBack[i]);
  });
  if (rawSnrTowards.length > rawRoute.length) snrTowards.push(rawSnrTowards[rawRoute.length]);
  if (rawSnrBack.length > rawRouteBack.length) snrBack.push(rawSnrBack[rawRouteBack.length]);

  // Stub rows for intermediate hops we haven't seen NodeInfo for. No
  // lastHeard — we haven't directly heard from them, only learned of them
  // via the relay. Matches the TCP path's anti-zombie behavior (issue #2602).
  const intermediates = new Set<number>();
  for (const n of route) intermediates.add(n);
  for (const n of routeBack) intermediates.add(n);
  intermediates.delete(fromNum);
  if (toNum !== null) intermediates.delete(toNum);
  intermediates.delete(BROADCAST_ADDR);
  for (const hop of intermediates) {
    const hopId = nodeNumToId(hop);
    const existing = await databaseService.nodes.getNode(hop, sourceId);
    if (existing) continue;
    await databaseService.nodes.upsertNode(
      {
        nodeNum: hop,
        nodeId: hopId,
        longName: `Node ${hopId}`,
        shortName: hopId.slice(-4),
        hwModel: 0,
        viaMqtt: true,
        createdAt: nowMs,
        updatedAt: nowMs,
      },
      sourceId,
    );
  }

  const record: DbTraceroute = {
    fromNodeNum: fromNum,
    toNodeNum: toNum ?? 0,
    fromNodeId,
    toNodeId,
    route: JSON.stringify(route),
    routeBack: JSON.stringify(routeBack),
    snrTowards: JSON.stringify(snrTowards),
    snrBack: JSON.stringify(snrBack),
    timestamp: nowMs,
    createdAt: nowMs,
  };
  if (effectiveChannel >= 0) (record as any).channel = effectiveChannel;
  databaseService.insertTraceroute(record, sourceId);

  // Hop count → telemetry, matches TCP's Smart Hops feed.
  const packetId = typeof packet.id === 'number' ? packet.id >>> 0 : undefined;
  const hops = route.length + 1;
  const hopTel: DbTelemetry = {
    nodeId: fromNodeId,
    nodeNum: fromNum,
    telemetryType: 'messageHops',
    timestamp: nowMs,
    value: hops,
    createdAt: nowMs,
    packetId,
    ...({ unit: 'hops' } as any),
  };
  databaseService.insertTelemetry(hopTel, sourceId);

  // Route segments — one row per adjacent pair with known positions.
  if (toNum !== null) {
    const fullForward = [toNum, ...route, fromNum];
    await persistRouteSegments(sourceId, fullForward, nowMs);
    if (routeBack.length > 0) {
      const fullReturn = [fromNum, ...routeBack, toNum];
      await persistRouteSegments(sourceId, fullReturn, nowMs);
    }
  }
}

async function persistRouteSegments(sourceId: string, fullRoute: number[], timestamp: number): Promise<void> {
  for (let i = 0; i < fullRoute.length - 1; i++) {
    const a = fullRoute[i];
    const b = fullRoute[i + 1];
    if (a === b) continue;
    if (a === 4294967295 || b === 4294967295) continue; // broadcast placeholder
    const n1 = await databaseService.nodes.getNode(a, sourceId);
    const n2 = await databaseService.nodes.getNode(b, sourceId);
    if (!n1?.latitude || !n1?.longitude || !n2?.latitude || !n2?.longitude) continue;
    const distKm = calculateDistance(n1.latitude, n1.longitude, n2.latitude, n2.longitude);
    const seg: DbRouteSegment = {
      fromNodeNum: a,
      toNodeNum: b,
      fromNodeId: nodeNumToId(a),
      toNodeId: nodeNumToId(b),
      distanceKm: distKm,
      isRecordHolder: false,
      timestamp,
      createdAt: Date.now(),
      ...({
        fromLatitude: n1.latitude,
        fromLongitude: n1.longitude,
        toLatitude: n2.latitude,
        toLongitude: n2.longitude,
      } as any),
    };
    databaseService.insertRouteSegment(seg, sourceId);
  }
}

/**
 * NEIGHBORINFO_APP — replace the sender's neighbor list with whatever this
 * packet contains, scoped to this source. Mirrors the TCP path's storage.
 *
 * Differs from TCP intentionally: TCP's handler skips packets flagged
 * `viaMqtt` on the wire (an MQTT-gateway-relayed packet picked up over
 * LoRa). That guard exists to avoid polluting the *local* radio's neighbor
 * graph with foreign-mesh data. Here the source IS an MQTT bridge and the
 * neighbor data is exactly what we want to persist — the sourceId scope
 * keeps it cleanly partitioned from TCP-learned neighbors.
 */
async function ingestNeighborInfo(
  sourceId: string,
  neighborInfo: Record<string, any>,
  fromNum: number,
  fromNodeId: string,
  nowMs: number,
): Promise<boolean> {
  const neighbors = neighborInfo.neighbors;
  if (!Array.isArray(neighbors)) return false;

  const senderNode = await databaseService.nodes.getNode(fromNum, sourceId);
  if (!senderNode) {
    await databaseService.nodes.upsertNode(
      {
        nodeNum: fromNum,
        nodeId: fromNodeId,
        longName: `Node ${fromNodeId}`,
        shortName: fromNodeId.slice(-4),
        hwModel: 0,
        viaMqtt: true,
        lastHeard: Math.floor(nowMs / 1000),
        createdAt: nowMs,
        updatedAt: nowMs,
      },
      sourceId,
    );
  }
  const senderHopsAway = senderNode?.hopsAway ?? 0;

  const valid: Array<{ nodeNum: number; snr: number | null; lastRxTime: number | null }> = [];
  for (const n of neighbors) {
    const num = Number(n.nodeId ?? n.node_id);
    if (!Number.isFinite(num) || num <= 0) continue;
    valid.push({
      nodeNum: num >>> 0,
      snr: n.snr != null ? Number(n.snr) : null,
      lastRxTime: n.lastRxTime != null ? Number(n.lastRxTime) : (n.last_rx_time != null ? Number(n.last_rx_time) : null),
    });
  }
  if (valid.length === 0) return false;

  // Create stubs for unknown neighbors. No lastHeard — only the reporter
  // has heard them. Matches the TCP path (issue #2602 zombie-row fix).
  const existing = await databaseService.nodes.getNodesByNums(valid.map((v) => v.nodeNum));
  for (const v of valid) {
    if (existing.has(v.nodeNum)) continue;
    const id = nodeNumToId(v.nodeNum);
    await databaseService.nodes.upsertNode(
      {
        nodeNum: v.nodeNum,
        nodeId: id,
        longName: `Node ${id}`,
        shortName: id.slice(-4),
        hwModel: 0,
        hopsAway: senderHopsAway + 1,
        viaMqtt: true,
        createdAt: nowMs,
        updatedAt: nowMs,
      },
      sourceId,
    );
  }

  await databaseService.neighbors.deleteNeighborInfoForNode(fromNum, sourceId);
  const records: DbNeighborInfo[] = valid.map((v) => ({
    nodeNum: fromNum,
    neighborNodeNum: v.nodeNum,
    snr: v.snr,
    lastRxTime: v.lastRxTime,
    timestamp: nowMs,
    createdAt: nowMs,
  } as DbNeighborInfo));
  await databaseService.neighbors.insertNeighborInfoBatch(records, sourceId);
  return true;
}

/**
 * PAXCOUNTER_APP — three telemetry rows (wifi, ble, uptime) plus a
 * lastHeard refresh. Same shape as TCP's processPaxcounterMessageProtobuf.
 */
function ingestPaxcounter(
  sourceId: string,
  packet: any,
  paxcount: Record<string, any>,
  fromNum: number,
  fromNodeId: string,
  nowMs: number,
): boolean {
  const packetId = typeof packet.id === 'number' ? packet.id >>> 0 : undefined;
  let any = false;
  const tryInsert = (telemetryType: string, value: unknown, unit: string): void => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const tel: DbTelemetry = {
      nodeId: fromNodeId,
      nodeNum: fromNum,
      telemetryType,
      timestamp: nowMs,
      value,
      createdAt: nowMs,
      packetId,
      ...({ unit } as any),
    };
    databaseService.insertTelemetry(tel, sourceId);
    any = true;
  };
  tryInsert('paxcounterWifi', paxcount.wifi, 'devices');
  tryInsert('paxcounterBle', paxcount.ble, 'devices');
  tryInsert('paxcounterUptime', paxcount.uptime, 's');

  databaseService.upsertNode({
    nodeNum: fromNum,
    nodeId: fromNodeId,
    longName: '',
    shortName: '',
    hwModel: 0,
    lastHeard: Math.floor(nowMs / 1000),
    viaMqtt: true,
    sourceId,
    createdAt: nowMs,
    updatedAt: nowMs,
  });
  return any;
}

/**
 * STORE_FORWARD_APP — replicates the storage-affecting branches of the
 * TCP processStoreForwardMessage handler:
 *   - ROUTER_HEARTBEAT: mark sender as an S&F server
 *   - ROUTER_TEXT_DIRECT / ROUTER_TEXT_BROADCAST: insert as a text message
 *     with viaStoreForward=true, deduping against the original transmission
 * The STATS / HISTORY / PING branches are log-only on TCP and are skipped
 * here (returned as unsupported).
 */
async function ingestStoreForward(
  sourceId: string,
  packet: any,
  decoded: Record<string, any>,
  fromNum: number,
  fromNodeId: string,
  toNum: number | null,
  toNodeId: string,
  nowMs: number,
  effectiveChannel: number,
): Promise<boolean> {
  const rr = decoded.rr ?? decoded.requestResponse ?? decoded.request_response ?? 0;
  const rrName = getStoreForwardRequestResponseName(rr);

  if (
    rr === StoreForwardRequestResponse.ROUTER_TEXT_DIRECT ||
    rr === StoreForwardRequestResponse.ROUTER_TEXT_BROADCAST
  ) {
    const textBytes = decoded.text;
    if (!textBytes || (textBytes.length ?? 0) === 0) {
      logger.debug(`📦 MQTT S&F ${rrName} from ${fromNodeId} — empty text, skipping`);
      return false;
    }
    const text = new TextDecoder('utf-8').decode(
      textBytes instanceof Uint8Array ? textBytes : new Uint8Array(textBytes),
    );
    const packetId = typeof packet.id === 'number' ? packet.id >>> 0 : 0;
    // Match the TEXT_MESSAGE_APP id format above — see the comment there
    // for why the TCP convention `${sourceId}_${fromNum}_${packetId}` is
    // load-bearing for cross-source dedup in the unified view.
    const id = `${sourceId}_${fromNum}_${packetId || nowMs}`;
    // Dedup: if the original transmission already landed in `messages`
    // via the regular TEXT_MESSAGE_APP path, don't double-insert.
    const existing = await databaseService.messages.getMessage(id);
    if (existing) {
      logger.debug(`📦 MQTT S&F replay duplicates existing message ${id}`);
      return false;
    }
    const msg: DbMessage = {
      id,
      fromNodeNum: fromNum,
      toNodeNum: toNum ?? 0xffffffff,
      fromNodeId,
      toNodeId,
      text,
      channel: effectiveChannel,
      portnum: PortNum.TEXT_MESSAGE_APP,
      timestamp: nowMs,
      rxTime: typeof packet.rxTime === 'number' ? packet.rxTime * 1000 : undefined,
      rxSnr: typeof packet.rxSnr === 'number' ? packet.rxSnr : undefined,
      rxRssi: typeof packet.rxRssi === 'number' ? packet.rxRssi : undefined,
      viaMqtt: true,
      createdAt: nowMs,
    } as DbMessage;
    (msg as any).sourceId = sourceId;
    (msg as any).viaStoreForward = true;
    // Same per-source insert path as the TEXT_MESSAGE_APP case above —
    // the facade drops sourceId; the repo accepts it.
    databaseService.messages.insertMessage(msg, sourceId);
    return true;
  }

  if (rr === StoreForwardRequestResponse.ROUTER_HEARTBEAT) {
    databaseService.upsertNode({
      nodeNum: fromNum,
      nodeId: fromNodeId,
      longName: '',
      shortName: '',
      hwModel: 0,
      lastHeard: Math.floor(nowMs / 1000),
      viaMqtt: true,
      sourceId,
      createdAt: nowMs,
      updatedAt: nowMs,
      // isStoreForwardServer is in the schema but not on DbNode (Migration 056-ish).
      ...({ isStoreForwardServer: true } as any),
    } as Partial<DbNode>);
    return true;
  }

  // STATS / HISTORY / PING / PONG / BUSY / etc. — log-only on TCP, mirrored here.
  logger.debug(`📦 MQTT S&F ${rrName} (rr=${rr}) from ${fromNodeId}`);
  return false;
}

/**
 * Per-source memo of (slot, channelName) pairs we've already upserted into
 * the channels table this process lifetime. Used to keep `recordChannelFromEnvelope`
 * cheap: only the first packet on a given (source, slot, name) combination
 * actually hits the DB. Names that change for an existing slot still trigger
 * a fresh upsert so the picker stays in sync.
 */
const channelMemo = new Map<string, Map<number, string>>();

/**
 * Process-lifetime cache mapping lower-cased channel names to channel_database
 * row IDs. Avoids hitting the DB on every MQTT packet for the same name. The
 * cache is invalidated for a single name on the rare write that mints a new
 * row; lookups for unknown names still go through findOrCreatePassiveByName
 * so admin-curated entries are picked up automatically.
 */
const channelNameToDbIdCache = new Map<string, number>();

/**
 * Resolve a channel_database id for an MQTT-ingested packet, in priority order:
 *   1. If server-side decryption already identified the row, trust that.
 *   2. If `envelope.channelId` (the human-readable channel name from the topic /
 *      ServiceEnvelope) is set, look up by name. Auto-register a passive
 *      (isEnabled=false, no PSK) row if no entry exists — this is the seam
 *      that lets channel_database_permissions become the single source of
 *      truth for MQTT channel access without forcing operators to pre-declare
 *      every observed channel.
 *   3. Otherwise return null and the caller falls back to the slot index.
 *
 * Errors are swallowed because the ingest pipeline must not fail just because
 * we couldn't materialize a permission target — the slot-indexed fallback
 * keeps the row visible to anyone with channel_${slot} grants.
 */
async function resolveChannelDatabaseIdForMqtt(
  envelope: ServiceEnvelopeShape,
  packet: NonNullable<ServiceEnvelopeShape['packet']>,
): Promise<number | null> {
  const decoded = packet.decoded as { channelDatabaseId?: number } | undefined;
  if (typeof decoded?.channelDatabaseId === 'number') return decoded.channelDatabaseId;

  const name = envelope.channelId?.trim();
  if (!name) return null;
  const cacheKey = name.toLowerCase();
  const cached = channelNameToDbIdCache.get(cacheKey);
  if (typeof cached === 'number') return cached;

  try {
    const id = await databaseService.channelDatabase.findOrCreatePassiveByNameAsync(name);
    if (typeof id === 'number') {
      channelNameToDbIdCache.set(cacheKey, id);
      return id;
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    logger.debug(`MQTT ingest: channel_database resolve failed for name="${name}": ${m}`);
  }
  return null;
}

/** Exposed for tests to reset between cases. */
export function _resetMqttIngestCachesForTest(): void {
  channelMemo.clear();
  channelNameToDbIdCache.clear();
}

function recordChannelFromEnvelope(
  sourceId: string,
  envelope: ServiceEnvelopeShape,
  packet: NonNullable<ServiceEnvelopeShape['packet']>,
): void {
  const name = envelope.channelId?.trim();
  if (!name) return;
  const slot = typeof packet.channel === 'number' ? packet.channel : 0;
  if (slot < 0 || slot > 255) return;

  let perSource = channelMemo.get(sourceId);
  if (!perSource) {
    perSource = new Map();
    channelMemo.set(sourceId, perSource);
  }
  if (perSource.get(slot) === name) return;
  perSource.set(slot, name);

  try {
    const result = databaseService.channels?.upsertChannel(
      {
        id: slot,
        name,
        // Slot 0 is the primary channel on Meshtastic; anything else is
        // secondary. Matches the role rules in `upsertChannel`.
        role: slot === 0 ? 1 : 2,
        uplinkEnabled: true,
        downlinkEnabled: true,
      },
      sourceId,
    );
    if (result && typeof (result as any).catch === 'function') {
      (result as Promise<unknown>).catch((err) => {
        // Clear the memo entry so a retry can run on the next packet —
        // losing a single write isn't fatal, but persistently skipping
        // it would keep the channel invisible in the picker.
        perSource!.delete(slot);
        const m = err instanceof Error ? err.message : String(err);
        logger.debug(`MQTT channel upsert skipped for source ${sourceId} slot ${slot}: ${m}`);
      });
    }
  } catch (err) {
    perSource.delete(slot);
    const m = err instanceof Error ? err.message : String(err);
    logger.debug(`MQTT channel upsert unavailable for source ${sourceId} slot ${slot}: ${m}`);
  }
}

function bytesToHex(buf: Uint8Array | ArrayLike<number>): string {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
