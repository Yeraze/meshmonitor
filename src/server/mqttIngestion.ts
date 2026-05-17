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
import databaseService from '../services/database.js';
import type { DbNode, DbMessage, DbTelemetry } from '../services/database.js';
import { PortNum } from './constants/meshtastic.js';
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

export function ingestServiceEnvelope(input: MqttIngestionInput): MqttIngestionResult {
  const { sourceId, envelope, filter } = input;
  const packet = envelope.packet;
  if (!packet) return { ingested: false, reason: 'no-packet' };

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
      if (filter && !filter.postFilterPosition(position)) {
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
      const msg: DbMessage = {
        id: `${sourceId}-${packetId || nowMs}-${fromNum}`,
        fromNodeNum: fromNum,
        toNodeNum: toNum ?? 0xffffffff,
        fromNodeId,
        toNodeId,
        text,
        channel: typeof packet.channel === 'number' ? packet.channel : 0,
        portnum,
        timestamp: nowMs,
        rxTime: typeof packet.rxTime === 'number' ? packet.rxTime * 1000 : undefined,
        rxSnr: typeof packet.rxSnr === 'number' ? packet.rxSnr : undefined,
        rxRssi: typeof packet.rxRssi === 'number' ? packet.rxRssi : undefined,
        viaMqtt: true,
        createdAt: nowMs,
      } as DbMessage;
      (msg as any).sourceId = sourceId;
      databaseService.insertMessage(msg);
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

    default:
      return { ingested: false, reason: 'unsupported-portnum', portnum };
  }
}

function bytesToHex(buf: Uint8Array | ArrayLike<number>): string {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
