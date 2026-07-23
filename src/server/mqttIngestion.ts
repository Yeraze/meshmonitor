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
import mqttPacketLogService from './services/mqttPacketLogService.js';
import { autoDeleteByDistanceService } from './services/autoDeleteByDistanceService.js';
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
        // Intentionally NOT enforcing name validation. Enforcing it would make
        // this seed a HARD skip for any packet whose channel hash doesn't match
        // hash("LongFast", defaultKey) — which silently drops default-channel
        // traffic on non-LongFast modem presets (the default channel hashes as
        // "MediumSlow", "ShortFast", etc.). Correct attribution among same-key
        // channels (e.g. this seed vs a custom AQ== channel) is instead handled
        // by channelDecryptionService.tryDecrypt(), which PREFERS the
        // hash-matching channel while still falling back, so nothing is ever
        // left undecrypted. See channelDecryptionService hash-aware attribution.
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
  TransportMechanism,
} from './constants/meshtastic.js';
import { calculateDistance } from '../utils/distance.js';
import { getEffectiveDbNodePosition } from './utils/nodeEnhancer.js';
import { canonicalTelemetryType, canonicalTelemetryUnit } from './utils/telemetryKeys.js';
import { resolveLastHeardSec } from './utils/replayGuard.js';
import { plausibleRxTime } from './utils/messageTime.js';
import { shouldDiscardPosition } from '../utils/nullIsland.js';
import { getDiscardInvalidPositions } from '../utils/positionIngestConfig.js';
import { logger } from '../utils/logger.js';
/** #4240: unix-seconds stamp for `transportLastMqtt`. Every row written by
 *  this module was, by definition, just heard over MQTT. */
const mqttSeenAt = (): number => Math.floor(Date.now() / 1000);
import {
  nodeNumToId,
  type ServiceEnvelopeShape,
  type PositionShape,
  MqttPacketFilter,
} from './mqttPacketFilter.js';

/**
 * First-drop-per-node tracker for ignore/geo-ignore noise suppression (see
 * `ingestServiceEnvelope`). Bounded so a source with many rotating/spoofed
 * node numbers can't leak memory; on overflow we simply clear and restart
 * logging at info for the next drop per node — this is a best-effort
 * logging aid, not correctness state.
 */
const droppedOnce = new Set<string>();
const DROPPED_ONCE_MAX = 10_000;
/** true the first time this (source,node) pair is dropped since process start.
 *  Best-effort noise suppression, not correctness state — on overflow the set
 *  is simply cleared and logging restarts. */
export function firstDropForNode(sourceId: string, nodeNum: number): boolean {
  const key = `${sourceId}:${nodeNum}`;
  if (droppedOnce.has(key)) return false;
  if (droppedOnce.size >= DROPPED_ONCE_MAX) droppedOnce.clear();
  droppedOnce.add(key);
  return true;
}
/** Exposed for tests to reset between cases. */
export function __resetFirstDropCacheForTest(): void {
  droppedOnce.clear();
}

export interface MqttIngestionInput {
  sourceId: string;
  envelope: ServiceEnvelopeShape;
  /**
   * Geo filter used to classify POSITION_APP payloads after decode. Pass the
   * same MqttPacketFilter instance used for preFilter. `filter.classifyPosition`
   * performs a pure bbox classification ('in' | 'out' | 'unknown' | 'no-geo')
   * against the decoded position — it no longer tracks membership or drop
   * counters; ignore/lift/purge state lives in the `ignored_nodes` table via
   * `databaseService.ignoredNodes` instead.
   */
  filter?: MqttPacketFilter;
}

export interface MqttIngestionResult {
  ingested: boolean;
  reason?: 'no-packet' | 'no-decoded' | 'encrypted' | 'unsupported-portnum' | 'ignored' | 'geo-ignored' | 'distance' | 'decode-error';
  portnum?: number;
}

/**
 * Decode a Meshtastic ServiceEnvelope into rows in the nodes/messages/
 * positions/telemetry tables, attributed to `input.sourceId`. Has ~15
 * early-return paths, one per ingest outcome — see `MqttIngestionResult`.
 *
 * Renamed from the former exported `ingestServiceEnvelope` (body unchanged)
 * so the exported wrapper below can log every outcome from a single return
 * point instead of touching each early return. See
 * docs/internal/dev-notes/MQTT_PACKET_MONITOR_PHASE1_SPEC.md §2.10.
 */
async function ingestServiceEnvelopeInner(input: MqttIngestionInput): Promise<MqttIngestionResult> {
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
  // Replay guard: resolve the lastHeard stamp once for this packet. Returns
  // undefined for a replayed/retained frame (rxTime far in the past), so the
  // node-upsert merges below preserve the node's existing lastHeard instead of
  // resurrecting an offline node. See utils/replayGuard.ts.
  const lastHeardSec = resolveLastHeardSec(packet.rxTime, nowMs);

  let payload: unknown;
  try {
    payload = meshtasticProtobufService.processPayload(portnum, decoded.payload ?? new Uint8Array());
  } catch (err) {
    logger.warn(`MQTT ingest: failed to decode portnum ${portnum}: ${err}`);
    return { ingested: false, reason: 'decode-error', portnum };
  }

  // NOTE: we intentionally do NOT write a slot/hash-keyed row to the `channels`
  // table here. On MQTT `packet.channel` is a per-sender channel *hash* (0-255),
  // not a stable 0-7 slot, so doing so split one logical channel (e.g. LongFast)
  // into many rows keyed by whatever hash each gateway used. The channel instead
  // surfaces by NAME through its channel_database row (resolved just below) — as
  // message rows on `CHANNEL_DB_OFFSET + dbId` and as a virtual channel in
  // /api/unified/channels. See docs/internal/dev-notes/MQTT_CHANNEL_CONSOLIDATION.md.

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

  // Defense-in-depth ignore gate. Ignored senders' non-POSITION traffic never
  // ingests — covers the broker-manager caller (which shares this function and
  // has no handleDownlink pre-gate) and any encrypted packet that decrypted to
  // a non-position payload. POSITION flows through to its case below so the
  // node can reappear (lift) or be re-evaluated. Applies to BOTH reasons
  // (manual + geo).
  if (portnum !== PortNum.POSITION_APP &&
      databaseService.ignoredNodes.isIgnoredCached(fromNum, sourceId)) {
    return { ingested: false, reason: 'ignored', portnum };
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
        transportMechanism: TransportMechanism.MQTT, transportLastMqtt: mqttSeenAt(),
        // Stamp the channel-database-encoded channel so
        // `filterNodesByChannelPermission` can gate map visibility on
        // the Virtual Channel Permissions the #3108 UI directs admins
        // toward. Without this the row's `channel` stays NULL → the
        // filter falls back to `channel_0` (a slot grant the UI hides
        // for MQTT scopes), so non-admins can never see MQTT nodes on
        // the map regardless of what they grant.
        channel: effectiveChannel,
        macaddr: user.macaddr ? bytesToHex(user.macaddr) : undefined,
        // publicKey is stored base64 across the rest of the codebase
        // (see meshtasticManager.ts:5546 and the security-config save
        // path at 3594). Using bytesToHex here would diverge from those
        // paths and trip the false-positive "key mismatch" warning every
        // time a node first ingested via MQTT later sends NodeInfo over
        // the direct radio link. Cleanup of existing hex rows happens in
        // migration 069.
        publicKey: user.publicKey
          ? Buffer.from(user.publicKey).toString('base64')
          : (user.public_key ? Buffer.from(user.public_key).toString('base64') : undefined),
        lastHeard: lastHeardSec,
        sourceId,
        createdAt: nowMs,
        updatedAt: nowMs,
      };
      void databaseService.upsertNodeAsync(node).catch(err => logger.error('MQTT upsertNode failed:', err));
      return { ingested: true, portnum };
    }

    case PortNum.POSITION_APP: {
      const position = payload as PositionShape & Record<string, any>;
      const geo = filter ? filter.classifyPosition(position) : 'no-geo';

      if (geo === 'out') {
        // Outside the boundary. Capture display names before purge so the
        // ignore-list UI shows a real name, then geo-ignore (insert-if-absent)
        // and purge ONCE on the transition. Never clobbers a manual ignore.
        const existing = await databaseService.nodes.getNode(fromNum, sourceId);
        const inserted = await databaseService.ignoredNodes.addGeoIgnoreAsync(
          fromNum, sourceId, fromNodeId,
          // A node whose first-ever packet is an out-of-bbox POSITION has no
          // stored NodeInfo — fall back to the same stub naming the
          // traceroute path uses so the ignore-list UI never shows a blank.
          existing?.longName ?? `Node ${fromNodeId}`,
          existing?.shortName ?? fromNodeId.slice(-4),
        );
        if (inserted) {
          // Fire-and-forget full purge (messages incl. broadcasts, telemetry,
          // traceroutes, neighbors, packet logs, node row). Ingestion must not
          // block the packet loop on a multi-table cascade. The ignore-cache
          // entry is already live (awaited above), so the gate drops the
          // node's subsequent traffic while the purge runs; a write racing
          // the cascade is last-writer-wins on the node row, which the next
          // packet's gate makes moot.
          void databaseService.deleteNodeAsync(fromNum, sourceId).catch((err) =>
            logger.warn(`Geo-purge failed for ${fromNodeId}@${sourceId}: ${err}`));
        }
        return { ingested: false, reason: 'geo-ignored', portnum };
      }

      if (geo === 'in') {
        // Inside → node reappears. Lift a geo-ignore if one exists (no-op for
        // manual / absent). liftGeoIgnoreAsync is TOCTOU-safe.
        await databaseService.ignoredNodes.liftGeoIgnoreAsync(fromNum, sourceId);
      }

      // After any lift attempt, a still-ignored sender must NOT ingest — this
      // catches manual ignores with an in-bounds position, a geo lift that lost
      // the race to a manual upgrade, and coordless ('unknown') positions from
      // an ignored node. A never-ignored node (or one just lifted) passes.
      if (databaseService.ignoredNodes.isIgnoredCached(fromNum, sourceId)) {
        return { ingested: false, reason: 'ignored', portnum };
      }

      // Fail-open ingest ('in' reappearance, 'unknown', or 'no-geo').
      const latI = position.latitudeI ?? position.latitude_i;
      const lngI = position.longitudeI ?? position.longitude_i;
      const alt = position.altitude;
      const lat = typeof latI === 'number' ? latI / 1e7 : undefined;
      const lng = typeof lngI === 'number' ? lngI / 1e7 : undefined;
      // Reject bogus fixes before they reach the node row — Null Island (0,0),
      // a position-precision-obscured (0,0) that arrives re-centered as
      // (offset, offset), and out-of-range junk (issue #3763). The geo-bbox
      // classifier above does NOT catch these: with no bbox configured ('no-geo')
      // or a bbox spanning the equator/prime meridian, (0,0) sails through. MQTT
      // relays Meshtastic packets, so pass the sender's precision_bits to enable
      // the de-offset. A bogus fix still refreshes lastHeard; undefined lat/lon is
      // preserved by upsertNode's `?? existing` merge, so it never overwrites a
      // previously stored good position with garbage. The (0,0) discard honors the
      // global `discardInvalidPositions` setting; out-of-range junk is always dropped.
      const precisionBits = position.precisionBits ?? position.precision_bits ?? undefined;
      const positionIsBogus = shouldDiscardPosition(lat, lng, precisionBits, getDiscardInvalidPositions());
      if (positionIsBogus) {
        logger.debug(`MQTT: dropping bogus position (${lat}, ${lng}) precisionBits=${precisionBits} from ${fromNodeId}`);
      }

      // Inline auto-delete-by-distance (#3900): when this MQTT source has the
      // feature enabled, evaluate the fix as it arrives so a node beyond the
      // configured radius never touches the nodeDB / map — rather than waiting
      // for the next periodic sweep. Only on a trustworthy (non-bogus) fix; a
      // bogus position is not a reliable basis for a distance decision.
      if (!positionIsBogus && lat != null && lng != null) {
        const outcome = await autoDeleteByDistanceService.applyInlineDistanceCheck(sourceId, fromNum, lat, lng);
        if (outcome !== 'kept') {
          return { ingested: false, reason: 'distance', portnum };
        }
      }

      const node: Partial<DbNode> = {
        nodeNum: fromNum,
        nodeId: fromNodeId,
        // Intentionally omit longName/shortName/hwModel: this upsert only
        // refreshes lastHeard. Passing '' / 0 would clobber names previously
        // saved from a NODEINFO_APP packet, because the upsert merge treats
        // an empty string / 0 as a provided value and overwrites. This was the
        // root cause of MQTT nodes appearing nameless after their NodeInfo.
        // See NODEINFO_APP above — `node.channel` must carry the
        // CHANNEL_DB_OFFSET-encoded virtual-channel id for the map
        // filter to honor Virtual Channel Permissions.
        channel: effectiveChannel,
        latitude: positionIsBogus ? undefined : lat,
        longitude: positionIsBogus ? undefined : lng,
        // Drop altitude too on a bogus fix — an altitude with no trustworthy
        // horizontal position is not worth persisting.
        altitude: positionIsBogus ? undefined : (typeof alt === 'number' ? alt : undefined),
        viaMqtt: true,
        transportMechanism: TransportMechanism.MQTT, transportLastMqtt: mqttSeenAt(),
        lastHeard: lastHeardSec,
        sourceId,
        createdAt: nowMs,
        updatedAt: nowMs,
      };
      void databaseService.upsertNodeAsync(node).catch(err => logger.error('MQTT upsertNode failed:', err));
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
      // A message directed at a specific node (not broadcast / ^all) belongs in
      // the direct-message view, not a channel. Mirror the TCP/radio path
      // (meshtasticManager.processTextMessageProtobuf forces channelIndex = -1 for
      // toNum !== 4294967295, independent of PKI status). Without this, an
      // MQTT-sourced directed message is bucketed into its channel and renders as
      // an ordinary broadcast in both per-source chat and Unified Messages (#4152).
      const isDirectMessage = toNum !== null && toNum !== 0xffffffff;
      const messageChannel = isDirectMessage ? -1 : effectiveChannel;
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
        channel: messageChannel,
        portnum,
        timestamp: nowMs,
        // Guard against an implausible rxTime: MQTT gateway packets frequently
        // arrive with an unset (0) receive time, and unsynced-RTC nodes report
        // a small nonzero boot-uptime value instead. Either would make the
        // unified view's canonical resolve land on an early-1970 date, so
        // plausibleRxTime (shared with canonicalMessageTime, #4206) filters
        // both out at ingestion rather than only at display time.
        rxTime: plausibleRxTime(typeof packet.rxTime === 'number' ? packet.rxTime * 1000 : undefined) ?? undefined,
        rxSnr: typeof packet.rxSnr === 'number' ? packet.rxSnr : undefined,
        rxRssi: typeof packet.rxRssi === 'number' ? packet.rxRssi : undefined,
        viaMqtt: true,
        emoji,
        replyId,
        createdAt: nowMs,
        sourcePath: 'mqtt_bridge',
      } as DbMessage;
      (msg as any).sourceId = sourceId;
      // Use the repo's per-source insert — the `databaseService.insertMessage`
      // facade drops the sourceId, leaving rows orphaned (`sourceId=NULL`)
      // and invisible to source-scoped queries like /api/unified/messages.
      databaseService.messages.insertMessage(msg, sourceId).catch(err => logger.error('Failed to insert MQTT message:', err));
      // Refresh lastHeard for the sender.
      void databaseService.upsertNodeAsync({
        nodeNum: fromNum,
        nodeId: fromNodeId,
        // Intentionally omit longName/shortName/hwModel: this upsert only
        // refreshes lastHeard. Passing '' / 0 would clobber names previously
        // saved from a NODEINFO_APP packet, because the upsert merge treats
        // an empty string / 0 as a provided value and overwrites. This was the
        // root cause of MQTT nodes appearing nameless after their NodeInfo.
        lastHeard: lastHeardSec,
        viaMqtt: true,
        transportMechanism: TransportMechanism.MQTT, transportLastMqtt: mqttSeenAt(),
        createdAt: nowMs,
        updatedAt: nowMs,
      }, sourceId).catch(err => logger.error('MQTT upsertNode failed:', err));
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
          // Normalize to the canonical key serial ingestion uses (issue #3314),
          // so MQTT-sourced environment/device metrics match the UI's expected
          // keys instead of dotted forms like `environment.barometricPressure`.
          const telemetryType = canonicalTelemetryType(groupName, key);
          const tel: DbTelemetry = {
            nodeId: fromNodeId,
            nodeNum: fromNum,
            telemetryType,
            timestamp: ts,
            value: val,
            unit: canonicalTelemetryUnit(telemetryType),
            createdAt: ts,
            packetId,
            packetTimestamp: typeof t.time === 'number' ? t.time * 1000 : undefined,
          };
          void databaseService.insertTelemetryAsync(tel, sourceId).catch(err => logger.error('MQTT insertTelemetry failed:', err));
          any = true;
        }
      }
      void databaseService.upsertNodeAsync({
        nodeNum: fromNum,
        nodeId: fromNodeId,
        // Intentionally omit longName/shortName/hwModel: this upsert only
        // refreshes lastHeard. Passing '' / 0 would clobber names previously
        // saved from a NODEINFO_APP packet, because the upsert merge treats
        // an empty string / 0 as a provided value and overwrites. This was the
        // root cause of MQTT nodes appearing nameless after their NodeInfo.
        lastHeard: lastHeardSec,
        viaMqtt: true,
        transportMechanism: TransportMechanism.MQTT, transportLastMqtt: mqttSeenAt(),
        createdAt: nowMs,
        updatedAt: nowMs,
      }, sourceId).catch(err => logger.error('MQTT upsertNode failed:', err));
      return any ? { ingested: true, portnum } : { ingested: false, reason: 'decode-error', portnum };
    }

    case PortNum.TRACEROUTE_APP: {
      await ingestTraceroute(sourceId, packet, payload as Record<string, any>, fromNum, fromNodeId, toNum, toNodeId, nowMs, effectiveChannel);
      return { ingested: true, portnum };
    }

    case PortNum.NEIGHBORINFO_APP: {
      const ok = await ingestNeighborInfo(sourceId, payload as Record<string, any>, fromNum, fromNodeId, nowMs, lastHeardSec);
      return ok ? { ingested: true, portnum } : { ingested: false, reason: 'decode-error', portnum };
    }

    case PortNum.PAXCOUNTER_APP: {
      const ok = await ingestPaxcounter(sourceId, packet, payload as Record<string, any>, fromNum, fromNodeId, nowMs);
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
 * Public entry point — thin wrapper around `ingestServiceEnvelopeInner` that
 * logs the outcome to the MQTT Packet Monitor exactly once, from the single
 * return point here, regardless of which early return the inner function
 * took. Fire-and-forget: the packet-log write never delays or can fail the
 * ingest pipeline. Because the log call reads `packet.decoded` *after* the
 * inner run, server-decrypted copies correctly record `decryptedBy:'server'`
 * and their resolved portnum/preview.
 */
export async function ingestServiceEnvelope(input: MqttIngestionInput): Promise<MqttIngestionResult> {
  const result = await ingestServiceEnvelopeInner(input);
  void mqttPacketLogService.logEnvelope(input.sourceId, input.envelope, result);
  if (
    (result.reason === 'ignored' || result.reason === 'geo-ignored' || result.reason === 'distance') &&
    typeof input.envelope.packet?.from === 'number'
  ) {
    const fromNum = input.envelope.packet.from >>> 0;
    const nodeId = nodeNumToId(fromNum);
    if (firstDropForNode(input.sourceId, fromNum)) {
      logger.info(`MQTT ${input.sourceId}: dropping ${result.reason} node ${nodeId} (subsequent drops silenced)`);
    } else {
      logger.debug(`MQTT ${input.sourceId}: ${result.reason} drop for node ${nodeId}`);
    }
  }
  return result;
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
  // Replay guard (see utils/replayGuard.ts): undefined for a stale replay so the
  // upsert preserves the node's existing lastHeard.
  const lastHeard = resolveLastHeardSec(packet.rxTime, nowMs);
  const isValidRouteNode = (n: number): boolean => n > 3 && n !== 255 && n !== 65535;

  // Refresh sender. Don't clobber an existing name.
  const existingFrom = await databaseService.nodes.getNode(fromNum, sourceId);
  await databaseService.nodes.upsertNode(
    existingFrom
      ? { nodeNum: fromNum, nodeId: fromNodeId, lastHeard, viaMqtt: true, transportMechanism: TransportMechanism.MQTT, transportLastMqtt: mqttSeenAt() }
      : {
          nodeNum: fromNum,
          nodeId: fromNodeId,
          longName: `Node ${fromNodeId}`,
          shortName: fromNodeId.slice(-4),
          hwModel: 0,
          viaMqtt: true,
          transportMechanism: TransportMechanism.MQTT, transportLastMqtt: mqttSeenAt(),
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
        ? { nodeNum: toNum, nodeId: toNodeId, lastHeard, viaMqtt: true, transportMechanism: TransportMechanism.MQTT, transportLastMqtt: mqttSeenAt() }
        : {
            nodeNum: toNum,
            nodeId: toNodeId,
            longName: `Node ${toNodeId}`,
            shortName: toNodeId.slice(-4),
            hwModel: 0,
            viaMqtt: true,
            transportMechanism: TransportMechanism.MQTT, transportLastMqtt: mqttSeenAt(),
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
        transportMechanism: TransportMechanism.MQTT, transportLastMqtt: mqttSeenAt(),
        createdAt: nowMs,
        updatedAt: nowMs,
      },
      sourceId,
    );
  }

  // Position snapshot for every hop in the route (mirrors TCP path in
  // meshtasticManager.ts). The dashboard map and TracerouteWidget rely on
  // this to draw lines that survive a hop node going stale / un-positioned
  // after the traceroute was recorded. Uses the effective (override-aware)
  // position so user-pinned coordinates render correctly.
  const routePositions: Record<number, { lat: number; lng: number; alt?: number }> = {};
  const pathNodes = new Set<number>([fromNum, ...route, ...routeBack]);
  if (toNum !== null && toNum !== BROADCAST_ADDR) pathNodes.add(toNum);
  for (const nodeNum of pathNodes) {
    const node = await databaseService.nodes.getNode(nodeNum, sourceId);
    const eff = getEffectiveDbNodePosition(node);
    if (eff.latitude != null && eff.longitude != null) {
      routePositions[nodeNum] = {
        lat: eff.latitude,
        lng: eff.longitude,
        ...(eff.altitude != null ? { alt: eff.altitude } : {}),
      };
    }
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
    routePositions: JSON.stringify(routePositions),
    // Originating packet id enables correlating this trace with the same packet
    // heard on another source (e.g. a direct TCP listener) — issue #3623.
    packetId: typeof packet.id === 'number' ? packet.id >>> 0 : null,
    timestamp: nowMs,
    createdAt: nowMs,
  };
  if (effectiveChannel >= 0) (record as any).channel = effectiveChannel;
  await databaseService.insertTracerouteAsync(record, sourceId);

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
  void databaseService.insertTelemetryAsync(hopTel, sourceId).catch(err => logger.error('MQTT insertTelemetry (hops) failed:', err));

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
    await databaseService.insertRouteSegmentAsync(seg, sourceId);
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
  // Replay guard: undefined for a stale replay so the reporter's lastHeard is
  // preserved rather than refreshed. See utils/replayGuard.ts.
  lastHeardSec: number | undefined,
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
        transportMechanism: TransportMechanism.MQTT, transportLastMqtt: mqttSeenAt(),
        lastHeard: lastHeardSec,
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
        transportMechanism: TransportMechanism.MQTT, transportLastMqtt: mqttSeenAt(),
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
async function ingestPaxcounter(
  sourceId: string,
  packet: any,
  paxcount: Record<string, any>,
  fromNum: number,
  fromNodeId: string,
  nowMs: number,
): Promise<boolean> {
  const packetId = typeof packet.id === 'number' ? packet.id >>> 0 : undefined;
  let any = false;
  const tryInsert = async (telemetryType: string, value: unknown, unit: string): Promise<void> => {
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
    await databaseService.insertTelemetryAsync(tel, sourceId);
    any = true;
  };
  await tryInsert('paxcounterWifi', paxcount.wifi, 'devices');
  await tryInsert('paxcounterBle', paxcount.ble, 'devices');
  await tryInsert('paxcounterUptime', paxcount.uptime, 's');

  // Replay guard (see utils/replayGuard.ts): undefined for a stale replay.
  const lastHeardSec = resolveLastHeardSec(packet.rxTime, nowMs);
  await databaseService.upsertNodeAsync({
    nodeNum: fromNum,
    nodeId: fromNodeId,
    // Omit longName/shortName/hwModel — lastHeard refresh only. Passing '' / 0
    // would clobber names saved from a NODEINFO_APP packet (the merge treats an
    // empty string / 0 as a provided value and overwrites).
    lastHeard: lastHeardSec,
    viaMqtt: true,
    transportMechanism: TransportMechanism.MQTT, transportLastMqtt: mqttSeenAt(),
    createdAt: nowMs,
    updatedAt: nowMs,
  }, sourceId);
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
      // See TEXT_MESSAGE_APP case: drop an implausible rxTime (unset gateway
      // time, or an unsynced-RTC node's boot-uptime value) so it doesn't
      // render as an early-1970 date via the unified view's canonical timestamp.
      rxTime: plausibleRxTime(typeof packet.rxTime === 'number' ? packet.rxTime * 1000 : undefined) ?? undefined,
      rxSnr: typeof packet.rxSnr === 'number' ? packet.rxSnr : undefined,
      rxRssi: typeof packet.rxRssi === 'number' ? packet.rxRssi : undefined,
      viaMqtt: true,
      createdAt: nowMs,
      sourcePath: 'mqtt_bridge',
    } as DbMessage;
    (msg as any).sourceId = sourceId;
    (msg as any).viaStoreForward = true;
    // Same per-source insert path as the TEXT_MESSAGE_APP case above —
    // the facade drops sourceId; the repo accepts it.
    databaseService.messages.insertMessage(msg, sourceId).catch(err => logger.error('Failed to insert MQTT message:', err));
    return true;
  }

  if (rr === StoreForwardRequestResponse.ROUTER_HEARTBEAT) {
    // Replay guard (see utils/replayGuard.ts): undefined for a stale replay.
    const lastHeardSec = resolveLastHeardSec(packet.rxTime, nowMs);
    void databaseService.upsertNodeAsync({
      nodeNum: fromNum,
      nodeId: fromNodeId,
      // Omit longName/shortName/hwModel — lastHeard refresh only. Passing '' / 0
      // would clobber names saved from a NODEINFO_APP packet (the merge treats an
      // empty string / 0 as a provided value and overwrites).
      lastHeard: lastHeardSec,
      viaMqtt: true,
      transportMechanism: TransportMechanism.MQTT, transportLastMqtt: mqttSeenAt(),
      sourceId,
      createdAt: nowMs,
      updatedAt: nowMs,
      // isStoreForwardServer is in the schema but not on DbNode (Migration 056-ish).
      ...({ isStoreForwardServer: true } as any),
    } as Partial<DbNode>).catch(err => logger.error('MQTT upsertNode failed:', err));
    return true;
  }

  // STATS / HISTORY / PING / PONG / BUSY / etc. — log-only on TCP, mirrored here.
  logger.debug(`📦 MQTT S&F ${rrName} (rr=${rr}) from ${fromNodeId}`);
  return false;
}

/**
 * Process-lifetime cache mapping `lower(name)::hash` keys to channel_database
 * row IDs. Avoids hitting the DB on every MQTT packet for the same channel
 * identity. The key includes the packet channel hash so two same-name /
 * different-key channels don't collide; lookups for unknown identities still
 * go through findOrCreateByNameAndHash so admin-curated entries are picked up
 * automatically.
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

  // `packet.channel` on MQTT is the Meshtastic 1-byte channel *hash*
  // (xorHash(name) ^ xorHash(psk)), not a stable 0-7 slot. We use it as a
  // second identity dimension so two same-name/different-key undecryptable
  // channels resolve to distinct channel_database rows. Missing/0 ⇒ null
  // (name-only path).
  const rawHash = typeof packet.channel === 'number' ? Number(packet.channel) : null;
  const hash = rawHash != null && Number.isFinite(rawHash) && rawHash > 0 ? rawHash & 0xff : null;

  // Cache key includes the hash so different-key same-name channels don't
  // collide in the cache.
  const cacheKey = `${name.toLowerCase()}::${hash ?? 'null'}`;
  const cached = channelNameToDbIdCache.get(cacheKey);
  if (typeof cached === 'number') return cached;

  try {
    const id = await databaseService.channelDatabase.findOrCreateByNameAndHashAsync(name, hash);
    if (typeof id === 'number') {
      channelNameToDbIdCache.set(cacheKey, id);
      return id;
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    logger.debug(`MQTT ingest: channel_database resolve failed for name="${name}" hash=${hash}: ${m}`);
  }
  return null;
}

/** Exposed for tests to reset between cases. */
export function _resetMqttIngestCachesForTest(): void {
  channelNameToDbIdCache.clear();
}

function bytesToHex(buf: Uint8Array | ArrayLike<number>): string {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
