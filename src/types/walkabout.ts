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
  /** Set when a walkabout import created this session (#6573); null = recorded live. */
  importId?: string | null;
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

// --- Phase 2: map (WALKABOUT_P2_SPEC.md §2.6) ---
export type WalkaboutH3Res = 7 | 8 | 9;
export type WalkaboutMapWindow = '24h' | '7d' | '14d' | '30d';
/** Exactly one of the three; `node` narrows to one credited node. */
export type WalkaboutMapQuery =
  | { kind: 'window'; window: WalkaboutMapWindow; node?: string }
  | { kind: 'session'; sessionId: string; node?: string }
  | { kind: 'range'; sinceMs: number; untilMs: number; node?: string };
export interface WalkaboutCellDto {
  cell: string; // H3 index (15 hex chars). A position; see spec §2.4.
  bestSnr: number | null; // max non-null SNR in the cell
  receptionCount: number;
  nodeCount: number; // distinct credited nodes (visible only)
  sampleCount: number; // GPS samples in the cell; > 0 with receptionCount 0 = "no signal"
}
export interface WalkaboutCellsResult {
  res: WalkaboutH3Res;
  windowStartAt: number;
  windowEndAt: number;
  cells: WalkaboutCellDto[];
  truncated: boolean; // any row/session/cell cap hit
  hiddenReceptionCount: number;
  /** Box around every clipped, visible reception and sample (raw lat/lon, not
   *  hex outlines), so it does not depend on res. null when empty. Catalogue
   *  names (bboxNorth etc. are latitude/longitude keys). */
  bounds: { bboxSouth: number; bboxNorth: number; bboxWest: number; bboxEast: number } | null;
}
export interface WalkaboutCellNodeDto {
  protocol: 'meshtastic' | 'meshcore';
  nodeId: string | null; // Meshtastic '!xxxxxxxx'
  nodeNum: number | null; // Meshtastic
  publicKey: string | null; // MeshCore, 64-hex lowercase
  longName: string | null;
  shortName: string | null;
  bestSnr: number | null;
  receptionCount: number;
  lastHeardAt: number;
}
export interface WalkaboutCellNodesResult {
  cell: string;
  nodes: WalkaboutCellNodeDto[];
  truncated: boolean;
}
export interface WalkaboutTrackResult {
  sessionId: string;
  positions: Array<[number, number]>;
  truncated: boolean;
}

// --- Export / import (#6573) ---

/** One sample as exported. `id` is file-local: receptions point at it via `sampleId`. */
export interface WalkaboutExportSample {
  id: number;
  latitude: number;
  longitude: number;
  accuracyM: number;
  deviceFixAt: number;
  fixAt: number;
  receivedAt: number;
}

/** One credited reception as exported. Names are display-only; import ignores them. */
export interface WalkaboutExportReception {
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
  sampleAgeMs: number;
  longName?: string | null;
  shortName?: string | null;
}

export interface WalkaboutExportSession {
  name: string | null;
  startedAt: number;
  endedAt: number | null;
  endReason: WalkaboutEndReason | null;
  samples: WalkaboutExportSample[];
  receptions: WalkaboutExportReception[];
}

/** The lossless JSON export, and the only walkabout import format. */
export interface WalkaboutExportDoc {
  meshmonitor: {
    format: 'meshmonitor-walkabout';
    version: number;
    exportedAt: number;
    /** Receptions left out because their credited node is hidden from the viewer (whole session). */
    hiddenReceptionCount: number;
    /** True when the row cap cut the export. */
    truncated: boolean;
  };
  sessions: WalkaboutExportSession[];
}
