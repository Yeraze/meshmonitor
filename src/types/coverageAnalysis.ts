/**
 * Result types for the Coverage Report's client-side analysis (#5277 P4a):
 * gaps, summary, grid, export and deep links. Types only.
 */
import type { CoverageReceiverKind } from './coverage.js';
import type { CoverageRangePreset } from '../utils/coverageTimeRange.js';

export interface GapFixInput { packetKey: string; firstReceivedAt: number; latitude: number; longitude: number; }
export type IntervalSource = 'configured' | 'observed' | 'default';
export interface CoverageGap {
  from: GapFixInput;
  to: GapFixInput;
  durationSec: number;
  distanceM: number;
  /** max(1, round(duration / interval) - 1) */
  missedEstimate: number;
}
export interface CoverageGapResult {
  intervalSec: number;
  intervalSource: IntervalSource;
  gaps: CoverageGap[];
  /** Spacings longer than COVERAGE_GAP_MAX_SEC: not drawn, not counted. */
  breaks: number;
  /** Fixes heard. */
  heard: number;
  /** heard + sum of missedEstimate. */
  expected: number;
}
export interface CoverageReceiverStat {
  key: string;
  sourceId: string;
  receiverId: string;
  receiverKind: CoverageReceiverKind;
  fixesHeard: number;
  medianSnr: number | null;
  furthestDirectM: number | null;
}
export interface CoverageDistancePoint { distanceM: number; snr: number; receiverKey: string; }
export interface CoverageSummary {
  fixesHeard: number;
  receptions: number;
  bestSnr: number | null;
  worstSnr: number | null;
  bestRssi: number | null;
  worstRssi: number | null;
  receivers: CoverageReceiverStat[];
  distancePoints: CoverageDistancePoint[];
}
export type CoverageGridCellSizeM = 100 | 250 | 500 | 1000;
export interface CoverageGridCell {
  key: string;
  south: number;
  west: number;
  north: number;
  east: number;
  medianValue: number | null;
  fixCount: number;
}
export type CoverageMapView = 'dots' | 'grid';
export interface CoverageExportContext {
  senderNames: Map<string, string>;
  receiverNames: Map<string, string>;
  sourceNames: Map<string, string>;
  truncated: boolean;
  generatedAt: number;
  filters: Record<string, string | number | null>;
}
export interface CoverageDeepLink { sender?: string; range?: Exclude<CoverageRangePreset, 'custom'>; survey?: string; }
