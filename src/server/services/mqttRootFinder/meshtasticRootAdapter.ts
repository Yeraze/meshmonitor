/**
 * Meshtastic adapter for the root sampler (#6287, design#167 R2).
 *
 * Subscribes to `<region>/2/map/` and `<region>/2/e/+/+`, plus the same pair
 * one to three `+` levels below the region: 8 filters. Never `#`.
 *
 * Payloads are never stored and never decrypted. Only a map report is
 * decoded, to read the reporting node's position for distance ranking.
 */

import { rootFromTopic, gatewayFromTopic } from '../../../utils/mqttRootTopic.js';
import { getProtobufRoot } from '../../protobufLoader.js';
import { MeshtasticProtobufService } from '../../meshtasticProtobufService.js';
import { PortNum } from '../../constants/meshtastic.js';
import type { RootAdapter, RootObservation } from './rootAdapter.js';

const MAX_PLUS_LEVELS = 3;

function nodeKeyFromNum(num: number): string {
  return '!' + (num >>> 0).toString(16).padStart(8, '0');
}

function decodeMapReportPosition(payload: Buffer): RootObservation | null {
  const envelope = MeshtasticProtobufService.getInstance().decodeServiceEnvelope(payload, {
    quiet: true,
  });
  const packet = envelope?.packet;
  if (!packet?.decoded || packet.encrypted?.length) return null;
  if (Number(packet.decoded.portnum) !== PortNum.MAP_REPORT_APP) return null;
  const root = getProtobufRoot();
  if (!root) return null;
  try {
    const MapReport = root.lookupType('meshtastic.MapReport');
    const report = MapReport.decode(packet.decoded.payload) as unknown as {
      latitudeI?: number;
      longitudeI?: number;
    };
    const latI = Number(report.latitudeI ?? 0);
    const lonI = Number(report.longitudeI ?? 0);
    const from = typeof packet.from === 'number' ? packet.from : undefined;
    const base = from !== undefined ? { nodeKey: nodeKeyFromNum(from) } : {};
    if (latI === 0 && lonI === 0) return { root: '', stream: 'map', ...base };
    return {
      root: '',
      stream: 'map',
      ...base,
      pos: { lat: latI * 1e-7, lon: lonI * 1e-7 },
    };
  } catch {
    return null;
  }
}

export const meshtasticRootAdapter: RootAdapter = {
  filters(regionRoot: string): string[] {
    const out: string[] = [];
    for (let plus = 0; plus <= MAX_PLUS_LEVELS; plus++) {
      const base = [regionRoot, ...Array(plus).fill('+')].join('/');
      out.push(`${base}/2/map/`, `${base}/2/e/+/+`);
    }
    return out;
  },

  cappedFilter(regionRoot: string): string {
    return `${regionRoot}/2/e/+/+`;
  },

  classify(topic: string, payload: Buffer): RootObservation | null {
    const root = rootFromTopic(topic);
    if (!root) return null;
    if (/\/2\/map\/?$/.test(topic)) {
      const obs = decodeMapReportPosition(payload);
      // An undecodable map report still proves the root is active.
      return obs ? { ...obs, root } : { root, stream: 'map' };
    }
    const gateway = gatewayFromTopic(topic);
    return { root, stream: 'e', ...(gateway ? { nodeKey: gateway } : {}) };
  },
};
