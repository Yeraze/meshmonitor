/**
 * Pure credit rules for Walkabout capture (#5891 Phase 1). Spec §2.6.
 * WP0 SKELETON: bodies land in WP2.
 */
import type { MeshtasticDirectRfPacket } from '../services/directRfContactRecorder.js';
import type { LastHopCandidate } from './lastHop.js';
import type { DecodedAdvert } from '../../utils/meshcorePacketDecode.js';

export type WalkaboutSkip =
  | 'no-local-node' | 'replayed' | 'own-packet' | 'via-mqtt' | 'not-rf' | 'no-packet-id'
  | 'not-live' | 'nodedb-replay' | 'unknown-hops' | 'relay-none' | 'relay-unknown' | 'relay-ambiguous'
  | 'decode-failed' | 'no-sender' | 'direct-route-ambiguous' | 'own-advert';

export interface WalkaboutCredit {
  protocol: 'meshtastic' | 'meshcore';
  /** `!xxxxxxxx` or lowercased 64-hex key. */
  creditedKey: string;
  creditedNodeNum: number | null;
  creditKind: 'direct' | 'relay';
  hopsAway: number;
  packetKey: string;
  snr: number | null;
  rssi: number | null;
}

export function evaluateWalkaboutMeshtastic(_input: {
  localNodeNum: number | null;
  packet: MeshtasticDirectRfPacket & { relayNode?: number | null };
  replayed: boolean;
  nowMs: number;
  candidates: LastHopCandidate[];
}): { skip: WalkaboutSkip } | { skip: null; credit: WalkaboutCredit } {
  throw new Error('not implemented');
}

export function evaluateWalkaboutMeshCore(_input: {
  localPubKey: string | null;
  event: { raw_hex?: string | null; snr?: number | null; rssi?: number | null };
  knownKeys: string[];
}): { skip: WalkaboutSkip } | { skip: null; credit: WalkaboutCredit; verifyAdvert?: DecodedAdvert } {
  throw new Error('not implemented');
}
