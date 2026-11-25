/** Walkabout Coverage DTOs (#5891, Phase 1). Spec: WALKABOUT_P1_SPEC.md §2.1. */
import type { WalkaboutEndReason } from '../utils/walkabout.js';

export interface WalkaboutSessionDto {
  id: string;
  sourceId: string;
  name: string | null;
  startedAt: number;
  endedAt: number | null;
  endsAt: number;
  isLive: boolean;
  endReason: WalkaboutEndReason | null;
  /** Never the user id. */
  startedByMe: boolean;
  sampleCount: number;
  receptionCount: number;
  /** Distinct credited nodes. */
  nodeCount: number;
  lastSampleAt: number | null;
}

export interface WalkaboutSampleInput {
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** GeolocationPosition.timestamp (phone clock); used only for spacing. */
  deviceFixAt: number;
  /** Phone now minus deviceFixAt at send time; skew-free. */
  ageMs: number;
}

export interface WalkaboutSkipCounts {
  noFix: number;
  relayAmbiguous: number;
  relayUnknown: number;
  noSender: number;
}

export interface WalkaboutSampleResult {
  accepted: number;
  dropped: { accuracy: number; spacing: number; stale: number; invalid: number };
  /** Counts read from the DB (§2.5). */
  session: WalkaboutSessionDto;
  /** Memory only, since this server start. */
  skipped: WalkaboutSkipCounts;
}
