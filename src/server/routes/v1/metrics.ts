/**
 * v1 API — Prometheus metrics endpoint (deployment-global).
 *
 * GET /api/v1/metrics
 *
 * Exposes current mesh health in Prometheus text exposition format so a
 * Prometheus-compatible scraper can alert on it: per-node RF telemetry
 * (channel utilization, battery, voltage, SNR/RSSI, last-heard), per-source
 * node counts, recent message volume, and gateway link state.
 *
 * Deployment-global like `/solar` — one scrape covers every source, with the
 * source as a label. A source is included only when the token has `nodes`
 * read permission on it (admin tokens see every enabled source), mirroring
 * `/api/v1/sources`; the message-volume gauge additionally requires
 * `messages` read on that source.
 *
 * Everything here is read straight from the nodes table, which stores the
 * latest device-metrics telemetry inline — there is no history walk, so a
 * scrape is a handful of queries per source.
 *
 * Cardinality: per-node series are limited to nodes heard within `window`
 * seconds (default 24h, clamp 1min–7d via `?window=`). On MQTT firehose
 * sources the node table can hold thousands of rows; the window keeps a
 * scrape from exporting every node ever seen. Ignored nodes are skipped —
 * a user who ignored a node does not want to alert on it either.
 *
 * Prometheus scrape config needs the API token as a bearer credential:
 *
 *   authorization:
 *     credentials: mm_v1_...
 */

import express, { Request, Response } from 'express';
import { Registry, Gauge } from 'prom-client';
import { createRequire } from 'module';
import databaseService from '../../../services/database.js';
import { sourceManagerRegistry } from '../../sourceManagerRegistry.js';
import { logger } from '../../../utils/logger.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../../../package.json');

const router = express.Router();

/** Per-node export window bounds (seconds). */
const WINDOW_DEFAULT = 86400;
const WINDOW_MIN = 60;
const WINDOW_MAX = 604800;

/**
 * Window for the "active nodes" gauge (seconds). Matches the dashboard
 * sidebar activity badge (getActiveNodeCount default) so the metric and the
 * UI agree on what "active" means.
 */
const ACTIVE_WINDOW_SECONDS = 7200;

/**
 * Hard cap on the number of per-node series exported per source per scrape.
 * getActiveNodes returns nodes ordered by lastHeard desc, so the cap keeps the
 * N most-recently-heard nodes — an MQTT-firehose source with thousands of rows
 * inside the window can't explode Prometheus cardinality (~8 series/node). The
 * `meshmonitor_nodes_total` gauge still reports the true count, so truncation
 * stays visible (exported < total).
 */
const MAX_NODE_SERIES_PER_SOURCE = 1000;

router.get('/', async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    const windowParam = parseInt(req.query.window as string);
    const windowSeconds = isNaN(windowParam)
      ? WINDOW_DEFAULT
      : Math.min(Math.max(windowParam, WINDOW_MIN), WINDOW_MAX);

    // Fresh registry per scrape: gauges are recomputed from the database
    // each time, so nothing is retained between requests and a node that
    // ages out of the window simply stops being exported.
    const registry = new Registry();

    const info = new Gauge({
      name: 'meshmonitor_info',
      help: 'MeshMonitor build info (value is always 1)',
      labelNames: ['version'],
      registers: [registry],
    });
    const sourceInfo = new Gauge({
      name: 'meshmonitor_source_info',
      help: 'Source metadata (value is always 1); join on the source label for names',
      labelNames: ['source', 'name', 'type'],
      registers: [registry],
    });
    const sourceConnected = new Gauge({
      name: 'meshmonitor_source_connected',
      help: 'Whether the link to this source (TCP node, MQTT broker, ...) is up (1) or down (0)',
      labelNames: ['source'],
      registers: [registry],
    });
    const nodesTotal = new Gauge({
      name: 'meshmonitor_nodes_total',
      help: 'Total nodes known for this source',
      labelNames: ['source'],
      registers: [registry],
    });
    const nodesActive = new Gauge({
      name: 'meshmonitor_nodes_active',
      help: `Nodes heard in the last ${ACTIVE_WINDOW_SECONDS / 3600} hours (matches the dashboard activity badge)`,
      labelNames: ['source'],
      registers: [registry],
    });
    const messagesLastHour = new Gauge({
      name: 'meshmonitor_messages_last_hour',
      help: 'Messages received in the last hour (requires messages read permission)',
      labelNames: ['source'],
      registers: [registry],
    });
    const packetsByPort = new Gauge({
      name: 'meshmonitor_packets_by_port_last_hour',
      help: 'Packets logged in the last hour by protocol; empty unless the packet monitor is enabled (requires packetmonitor read permission)',
      labelNames: ['source', 'portnum', 'portnum_name'],
      registers: [registry],
    });

    const nodeLabels = ['source', 'node_id', 'short_name'] as const;
    const nodeChannelUtil = new Gauge({
      name: 'meshmonitor_node_channel_utilization_percent',
      help: 'Channel utilization observed by this node, percent (airtime saturation; alert on max by source)',
      labelNames: nodeLabels,
      registers: [registry],
    });
    const nodeAirUtilTx = new Gauge({
      name: 'meshmonitor_node_air_util_tx_percent',
      help: "This node's own transmit airtime duty cycle, percent",
      labelNames: nodeLabels,
      registers: [registry],
    });
    const nodeBattery = new Gauge({
      name: 'meshmonitor_node_battery_level',
      help: 'Node battery level, 0-100 (values above 100 mean externally powered)',
      labelNames: nodeLabels,
      registers: [registry],
    });
    const nodeVoltage = new Gauge({
      name: 'meshmonitor_node_voltage_volts',
      help: 'Node battery voltage in volts',
      labelNames: nodeLabels,
      registers: [registry],
    });
    const nodeSnr = new Gauge({
      name: 'meshmonitor_node_snr_db',
      help: 'SNR of the last packet received from this node, dB',
      labelNames: nodeLabels,
      registers: [registry],
    });
    const nodeRssi = new Gauge({
      name: 'meshmonitor_node_rssi_dbm',
      help: 'RSSI of the last packet received from this node, dBm',
      labelNames: nodeLabels,
      registers: [registry],
    });
    const nodeLastHeard = new Gauge({
      name: 'meshmonitor_node_last_heard_timestamp_seconds',
      help: 'Unix time this node was last heard (use to exclude stale telemetry in queries)',
      labelNames: nodeLabels,
      registers: [registry],
    });
    const nodeHopsAway = new Gauge({
      name: 'meshmonitor_node_hops_away',
      help: 'Hops between this node and the local node',
      labelNames: nodeLabels,
      registers: [registry],
    });

    info.labels(String(packageJson.version)).set(1);

    // Link state comes from the live source managers; a source with no
    // running manager (e.g. failed to start) reports as down.
    const statusBySource = new Map(
      sourceManagerRegistry.getAllManagers().map((m) => [m.sourceId, m.getStatus()])
    );

    const sources = (await databaseService.sources.getAllSources()).filter((s) => s.enabled);

    for (const source of sources) {
      if (!user.isAdmin) {
        const canReadNodes = await databaseService.checkPermissionAsync(
          user.id, 'nodes', 'read', source.id
        );
        if (!canReadNodes) {
          continue;
        }
      }

      sourceInfo.labels(source.id, source.name, source.type).set(1);
      sourceConnected.labels(source.id).set(statusBySource.get(source.id)?.connected ? 1 : 0);

      nodesTotal.labels(source.id).set(await databaseService.nodes.getNodeCount(source.id));
      nodesActive.labels(source.id).set(
        await databaseService.nodes.getActiveNodeCount(source.id, ACTIVE_WINDOW_SECONDS)
      );

      const canReadMessages =
        user.isAdmin ||
        (await databaseService.checkPermissionAsync(user.id, 'messages', 'read', source.id));
      if (canReadMessages) {
        messagesLastHour.labels(source.id).set(
          await databaseService.messages.getMessageCountSince(source.id, 3600 * 1000)
        );
      }

      // Traffic mix. Backed by the packet monitor's log, so it is empty on
      // installs that have not enabled packet logging — a config state, not
      // an error, hence no gauge rather than a zero. Mirrors the v1 packets
      // route's permission resource.
      const canReadPackets =
        user.isAdmin ||
        (await databaseService.checkPermissionAsync(user.id, 'packetmonitor', 'read', source.id));
      if (canReadPackets) {
        const portCounts = await databaseService.packetLog.getPacketCountsByPortSince(
          source.id, 3600 * 1000
        );
        for (const row of portCounts) {
          const portnum = row.portnum == null ? 'unknown' : String(row.portnum);
          packetsByPort
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
        if (node.isIgnored) {
          continue;
        }
        const labels = [source.id, node.nodeId, node.shortName || 'unknown'] as const;

        if (node.channelUtilization != null) {
          nodeChannelUtil.labels(...labels).set(node.channelUtilization);
        }
        if (node.airUtilTx != null) {
          nodeAirUtilTx.labels(...labels).set(node.airUtilTx);
        }
        if (node.batteryLevel != null) {
          nodeBattery.labels(...labels).set(node.batteryLevel);
        }
        if (node.voltage != null) {
          nodeVoltage.labels(...labels).set(node.voltage);
        }
        if (node.snr != null) {
          nodeSnr.labels(...labels).set(node.snr);
        }
        if (node.rssi != null) {
          nodeRssi.labels(...labels).set(node.rssi);
        }
        if (node.lastHeard != null) {
          nodeLastHeard.labels(...labels).set(node.lastHeard);
        }
        if (node.hopsAway != null) {
          nodeHopsAway.labels(...labels).set(node.hopsAway);
        }
      }
    }

    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  } catch (error) {
    logger.error('Error generating metrics (v1):', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to generate metrics',
    });
  }
});

export default router;
