/**
 * Walkabout Coverage service (#5891 Phase 1). Spec §2.5.
 * Owns the live per-source GPS fix map and the session lifecycle.
 * WP0 SKELETON: bodies land in WP2.
 */
import type { DbWalkaboutSession } from '../../db/repositories/coverageWalkabout.js';
import type { MeshtasticDirectRfPacket } from './directRfContactRecorder.js';
import type {
  WalkaboutSampleInput,
  WalkaboutSampleResult,
  WalkaboutSkipCounts,
} from '../../types/walkabout.js';

export interface WalkaboutMeshtasticInput {
  sourceId: string;
  localNodeNum: number | null;
  packet: MeshtasticDirectRfPacket & { relayNode?: number | null };
  /** Store & Forward replay or virtual-node-originated packet. */
  replayed: boolean;
}

export interface WalkaboutMeshCoreInput {
  sourceId: string;
  localPubKey: string | null;
  event: { raw_hex?: string | null; snr?: number | null; rssi?: number | null };
}

export type WalkaboutErrorCode =
  | 'WALKABOUT_ALREADY_LIVE'
  | 'WALKABOUT_NOT_LIVE'
  | 'WALKABOUT_NOT_OWNER'
  | 'WALKABOUT_SOURCE_UNSUPPORTED'
  | 'WALKABOUT_NOT_FOUND';

export class WalkaboutError extends Error {
  code: WalkaboutErrorCode;
  extra?: Record<string, unknown>;
  constructor(code: WalkaboutErrorCode, message?: string, extra?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'WalkaboutError';
    this.code = code;
    this.extra = extra;
  }
}

const NOT_IMPLEMENTED = 'not implemented';

export class WalkaboutService {
  /** Resolves `ready`, success or failure. */
  async init(_nowMs: number = Date.now()): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async startSession(_sourceId: string, _userId: number | null, _name: string | null, _nowMs?: number): Promise<DbWalkaboutSession> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async stopSession(_sourceId: string, _sessionId: string, _nowMs?: number): Promise<DbWalkaboutSession | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async addSamples(_sourceId: string, _sessionId: string, _userId: number | null, _samples: WalkaboutSampleInput[], _nowMs?: number): Promise<WalkaboutSampleResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async deleteSession(_sourceId: string, _sessionId: string): Promise<boolean> {
    throw new Error(NOT_IMPLEMENTED);
  }

  forgetSource(_sourceId: string): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  getSkipped(_sourceId: string, _sessionId: string): WalkaboutSkipCounts | null {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Sync; never throws; never awaited on the RX path. */
  maybeCaptureMeshtastic(_input: WalkaboutMeshtasticInput): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Sync; never throws; never awaited on the RX path. */
  maybeCaptureMeshCore(_input: WalkaboutMeshCoreInput): void {
    throw new Error(NOT_IMPLEMENTED);
  }
}

export const walkaboutService = new WalkaboutService();
