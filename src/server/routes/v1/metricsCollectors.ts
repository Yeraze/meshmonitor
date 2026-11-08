/**
 * Per-source metrics collectors for GET /api/v1/metrics (#6263 WP2).
 *
 * The route owns the registry and defines every gauge once (`createMetricGauges`
 * in metrics.ts). A `SourceMetricsCollector` fills those gauges for one source:
 * one for Meshtastic-style sources (the original behaviour, unchanged) and one
 * for MeshCore sources. The route picks a collector by source type, so a new
 * protocol adds a collector, not a copy of the route.
 */

import type { Gauge } from 'prom-client';
import databaseService from '../../../services/database.js';
import { loadMeshCoreNodesForViewer } from '../../services/meshcoreNodeView.js';
import type { NodeViewAccess } from '../../utils/nodeEnhancer.js';
import { isAnyMeshCoreSourceType } from '../../../utils/nodeTypeCategory.js';

export const ACTIVE_WINDOW_SECONDS = 7200;
export const MAX_NODE_SERIES_PER_SOURCE = 1000;
/** Cap on payload-type series per MeshCore source (the wire type is 4 bits). */
export const MAX_PAYLOAD_TYPE_SERIES = 16;

type G = Gauge<string>;

/** Every gauge the metrics route exports, defined once by the route. */
export interface MetricGauges {
  nodesTotal: G;
  nodesActive: G;
  messagesLastHour: G;
  packetsByPort: G;
  /** Lazy: registered only when a MeshCore source needs it. */
  packetsByPayloadType: () => G;
  nodeChannelUtil: G;
  nodeAirUtilTx: G;
  nodeBattery: G;
  nodeVoltage: G;
  nodeSnr: G;
  nodeRssi: G;
  nodeLastHeard: G;
  nodeHopsAway: G;
  nodeLastPosition: G;
}

export interface CollectContext {
  source: { id: string; name: string; type: string };
  access: NodeViewAccess;
  windowSeconds: number;
  gauges: MetricGauges;
}

export interface SourceMetricsCollector {
  collect(ctx: CollectContext): Promise<void>;
}

export const meshtasticMetricsCollector: SourceMetricsCollector = {
  async collect({ source, access, windowSeconds, gauges }) {
    gauges.nodesTotal.labels(source.id).set(await databaseService.nodes.getNodeCount(source.id));
    gauges.nodesActive.labels(source.id).set(
      await databaseService.nodes.getActiveNodeCount(source.id, ACTIVE_WINDOW_SECONDS)
    );

    if (access.permissions.can('messages', 'read', source.id)) {
      gauges.messagesLastHour.labels(source.id).set(
        await databaseService.messages.getMessageCountSince(source.id, 3600 * 1000)
      );
    }

    // Traffic mix. Backed by the packet monitor's log, so it is empty on
    // installs that have not enabled packet logging: a config state, not an
    // error, hence no gauge rather than a zero.
    if (access.permissions.can('packetmonitor', 'read', source.id)) {
      const portCounts = await databaseService.packetLog.getPacketCountsByPortSince(
        source.id, 3600 * 1000
      );
      for (const row of portCounts) {
        const portnum = row.portnum == null ? 'unknown' : String(row.portnum);
        gauges.packetsByPort
          .labels(source.id, portnum, row.portnumName || `PORT_${portnum}`)
          .set(row.packetCount);
      }
    }

    // getActiveNodes takes days; fractional values work (cutoff arithmetic).
    // Capped to the N most-recently-heard nodes so a firehose source can't
    // blow up scrape cardinality (see MAX_NODE_SERIES_PER_SOURCE).
    const activeNodes = await databaseService.nodes.getActiveNodes(
      windowSeconds / 86400, source.id, MAX_NODE_SERIES_PER_SOURCE
    );

    for (const node of activeNodes) {
      if (node.isIgnored) continue;
      // A per-node series names the node. Only nodes the user may see on this
      // source: `viewOnMap` on the channel it was last heard on, the rule
      // GET .../nodes applies. Admins see every node.
      if (!access.canViewNode(source.id, node.channel)) continue;
      const labels = [source.id, node.nodeId, node.shortName || 'unknown'] as const;

      if (node.channelUtilization != null) gauges.nodeChannelUtil.labels(...labels).set(node.channelUtilization);
      if (node.airUtilTx != null) gauges.nodeAirUtilTx.labels(...labels).set(node.airUtilTx);
      if (node.batteryLevel != null) gauges.nodeBattery.labels(...labels).set(node.batteryLevel);
      if (node.voltage != null) gauges.nodeVoltage.labels(...labels).set(node.voltage);
      if (node.snr != null) gauges.nodeSnr.labels(...labels).set(node.snr);
      if (node.rssi != null) gauges.nodeRssi.labels(...labels).set(node.rssi);
      if (node.lastHeard != null) gauges.nodeLastHeard.labels(...labels).set(node.lastHeard);
      if (node.hopsAway != null) gauges.nodeHopsAway.labels(...labels).set(node.hopsAway);
      // Stored in ms, exported in seconds like last-heard so the two compare.
      if (node.positionTimestamp != null) {
        gauges.nodeLastPosition.labels(...labels).set(node.positionTimestamp / 1000);
      }
    }
  },
};

export const meshcoreMetricsCollector: SourceMetricsCollector = {
  async collect({ source, access, windowSeconds, gauges }) {
    const now = Date.now();
    const mc = databaseService.meshcore;

    gauges.nodesTotal.labels(source.id).set(await mc.countNodesBySource(source.id));
    gauges.nodesActive.labels(source.id).set(
      await mc.countActiveNodesBySource(source.id, now - ACTIVE_WINDOW_SECONDS * 1000)
    );

    if (access.permissions.can('messages', 'read', source.id)) {
      gauges.messagesLastHour.labels(source.id).set(
        await mc.countMessagesSince(source.id, now - 3600 * 1000)
      );
    }

    if (access.permissions.can('packetmonitor', 'read', source.id)) {
      const counts = await mc.getPacketCountsByPayloadTypeSince(source.id, now - 3600 * 1000);
      for (const row of counts.slice(0, MAX_PAYLOAD_TYPE_SERIES)) {
        gauges.packetsByPayloadType()
          .labels(source.id, String(row.payloadType), row.payloadTypeName || `TYPE_${row.payloadType}`)
          .set(row.count);
      }
    }

    // Per-node series name the node: nodes:read, and never positions.
    if (!access.permissions.can('nodes', 'read', source.id)) return;
    const nodes = await loadMeshCoreNodesForViewer(source.id, access, {
      positions: false,
      heardSinceMs: now - windowSeconds * 1000,
      limit: MAX_NODE_SERIES_PER_SOURCE,
    });
    for (const node of nodes) {
      const labels = [source.id, `mc:${node.publicKey}`, (node.name || 'unknown').slice(0, 4)] as const;
      if (node.snr != null) gauges.nodeSnr.labels(...labels).set(node.snr);
      if (node.rssi != null) gauges.nodeRssi.labels(...labels).set(node.rssi);
      if (node.lastHeard != null) gauges.nodeLastHeard.labels(...labels).set(Math.floor(node.lastHeard / 1000));
      if (node.pathLen != null) gauges.nodeHopsAway.labels(...labels).set(node.pathLen);
      if (typeof node.batteryMv === 'number') gauges.nodeVoltage.labels(...labels).set(node.batteryMv / 1000);
    }
  },
};

export function collectorForSourceType(type: string): SourceMetricsCollector {
  return isAnyMeshCoreSourceType(type) ? meshcoreMetricsCollector : meshtasticMetricsCollector;
}
