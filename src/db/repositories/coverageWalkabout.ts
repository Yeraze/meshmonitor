/**
 * Repository for the Walkabout Coverage tables (epic #5891, Phase 1).
 * Spec: WALKABOUT_P1_SPEC.md §2.3. WP0 SKELETON: bodies land in WP1.
 *
 * Every method takes `sourceId` and scopes with `withSourceScope`, except
 * `getOpenSessionsAllSources` (boot loader: cross-source by design).
 */
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { WALKABOUT_LIST_LIMIT, type WalkaboutEndReason } from '../../utils/walkabout.js';

export interface DbWalkaboutSession {
  id: string;
  sourceId: string;
  name: string | null;
  startedAt: number;
  endedAt: number | null;
  endReason: WalkaboutEndReason | null;
  /** users.id; never sent to the client. */
  startedBy: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DbWalkaboutSessionWithCounts extends DbWalkaboutSession {
  sampleCount: number;
  receptionCount: number;
  /** Distinct credited keys. */
  nodeCount: number;
  lastSampleAt: number | null;
}

export interface DbWalkaboutSample {
  id: number;
  sessionId: string;
  sourceId: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** Phone clock; spacing only. */
  deviceFixAt: number;
  /** Server clock: receivedAt - ageMs; freshness only. */
  fixAt: number;
  receivedAt: number;
}

export type NewWalkaboutSample = Omit<DbWalkaboutSample, 'id'>;

export interface DbWalkaboutReception {
  id: number;
  sessionId: string;
  sourceId: string;
  protocol: 'meshtastic' | 'meshcore';
  creditedKey: string;
  creditedNodeNum: number | null;
  creditKind: 'direct' | 'relay';
  hopsAway: number | null;
  packetKey: string;
  snr: number | null;
  rssi: number | null;
  heardAt: number;
  sampleId: number | null;
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** heardAt - sample.fixAt. */
  sampleAgeMs: number;
}

export type NewWalkaboutReception = Omit<DbWalkaboutReception, 'id'>;

export interface WalkaboutCounts {
  samples: number;
  receptions: number;
  nodes: number;
  lastSampleAt: number | null;
}

const NOT_IMPLEMENTED = 'not implemented';

export class CoverageWalkaboutRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  async createSession(_p: { id: string; sourceId: string; name: string | null; startedAt: number; startedBy: number | null }): Promise<DbWalkaboutSession> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getSession(_sourceId: string, _id: string): Promise<DbWalkaboutSession | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** endedAt IS NULL, newest. */
  async getOpenSession(_sourceId: string): Promise<DbWalkaboutSession | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Newest first. */
  async listSessions(_sourceId: string, _limit: number = WALKABOUT_LIST_LIMIT): Promise<DbWalkaboutSessionWithCounts[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Boot only. Cross-source by design (the service loads every open session at init). */
  async getOpenSessionsAllSources(): Promise<DbWalkaboutSession[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** `WHERE endedAt IS NULL`; true when a row was ended. */
  async endSession(_sourceId: string, _id: string, _endedAt: number, _reason: WalkaboutEndReason): Promise<boolean> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Deletes receptions, samples, then the session. */
  async deleteSession(_sourceId: string, _id: string): Promise<boolean> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async deleteForSource(_sourceId: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Returns the row with its id (PG returning / MySQL insertId / SQLite lastInsertRowid). */
  async insertSample(_row: NewWalkaboutSample): Promise<DbWalkaboutSample> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Newest by deviceFixAt. */
  async getLatestSample(_sourceId: string, _sessionId: string): Promise<DbWalkaboutSample | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** insertIgnore + getAffectedRows > 0; false on a duplicate. */
  async recordReception(_row: NewWalkaboutReception): Promise<boolean> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getCounts(_sourceId: string, _sessionId: string): Promise<WalkaboutCounts> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
