import type { McoImageV3BlockAlgorithmId, ScanModeId } from '../constants.js';

// Types for the v3 encoder port (see encode.ts for the licence). The upstream file is untyped
// JavaScript; these describe the shapes it passes around. No behaviour lives here.

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
  area?: number;
}

export interface V3Image {
  width: number;
  height: number;
  paletteProfile: number;
  pixels: number[];
  transparentColor: number | null;
}

export interface RowChange {
  x: number;
  value: number;
}

export interface RowSegment {
  x: number;
  length: number;
  values: number[];
}

export interface BackgroundCandidate {
  color: number;
  rank: number;
}

/** A candidate encoding (upstream `makeCandidate` result). */
export interface Candidate {
  payload: Uint8Array;
  body: Uint8Array;
  text: string;
  mode: number;
  modeName: string;
  scan: ScanModeId;
  scanName: string;
  byteLength: number;
  charLength: number;
  boundsPresent: boolean;
  boundsX: number | null;
  boundsY: number | null;
  boundsWidth: number | null;
  boundsHeight: number | null;
  backgroundColor: number | null;
  transparentColor: number | null;
  regionCount: number;
  backgroundRank: number;
  codecVersion: number;
  localPaletteSize: number | null;
  bitsPerLocalPixel: number | null;
  requestedEncodingVersion: number;
  actualEncodingVersion: number;
  paletteKind: string;
  container: string;
  algorithm: McoImageV3BlockAlgorithmId | null;
}

/** Union of every option bag the upstream helpers read. All fields are optional. */
export interface EncodeOptions {
  // makeCandidate
  mode?: number;
  scan?: ScanModeId;
  boundsPresent?: boolean;
  boundsX?: number | null;
  boundsY?: number | null;
  boundsWidth?: number | null;
  boundsHeight?: number | null;
  backgroundColor?: number | null;
  transparentColor?: number | null;
  regionCount?: number;
  backgroundRank?: number;
  localPaletteSize?: number | null;
  bitsPerLocalPixel?: number | null;
  paletteKind?: string;
  container?: string;
  algorithm?: McoImageV3BlockAlgorithmId | null;
  // local palettes
  indexOrderSensitive?: boolean;
  includeTransitionOrder?: boolean;
  includeBitplaneOptimizedOrder?: boolean;
  includeRgbOrder?: boolean;
  preferredFirstColor?: number | null;
  // block bodies
  rowLength?: number;
  backgroundInherited?: boolean;
  greedyLzOnly?: boolean;
  useHighCompressionExtras?: boolean;
  compactHeader?: boolean;
  // regions
  compactGeometry?: boolean;
  commonBlockHeader?: boolean;
  hybridCommonHeader?: boolean;
  deltaGeometry?: boolean;
  sharedLocalPalette?: boolean;
}

export interface SparseSegment {
  start: number;
  color: number;
  length: number;
}

export interface SparseAnalysis {
  segments: SparseSegment[];
  foregroundColors: number[];
}

export type LzToken =
  | { isMatch: false; literals: number[] }
  | { isMatch: true; distance: number; length: number; literals: number[] };

export interface RegionState {
  regions: Bounds[];
  cost: number;
  exactPlanCache: RegionPlanCache | null;
}

export interface RowDeltaDecision {
  op: number;
  extendedOp: number;
  predictor: number;
  changes: RowChange[];
  bitCost: number;
}

export interface CompactRowDeltaDecision {
  op: number;
  predictor: number;
  changes: RowChange[];
  useResidual: boolean;
  bitCost: number;
}

export interface CompactValueEncoding {
  useResidual: boolean;
  bitCost: number;
}

export interface RegionSplit {
  parts: Bounds[];
  savedArea: number;
}

/** One region plus its pixels, cut out of the image. */
export interface PreparedRegion {
  bounds: Bounds;
  pixels: number[];
}

/** A region body (upstream `tryRegionBodyEncoder` result). */
export interface RegionBodyResult {
  algorithm: McoImageV3BlockAlgorithmId;
  scan: ScanModeId;
  bytes: Uint8Array;
  bitLength: number;
}

/** A body plus the bit cost of its region header. */
export interface RegionBlock extends RegionBodyResult {
  cost: number;
}

export interface SharedPaletteVariants {
  invariant: number[][];
  sensitive: number[][];
}

/** A region layout plan. `algorithm`/`scan`/`usesCommon` exist only on common and hybrid plans. */
export interface RegionPlan {
  algorithm?: McoImageV3BlockAlgorithmId;
  scan?: ScanModeId;
  blocks: RegionBodyResult[];
  usesCommon?: boolean[];
  cost: number;
  sharedPalette: number[] | null;
}

export interface RegionPlanCache {
  prepared: PreparedRegion[];
  sharedVariants: SharedPaletteVariants | null;
  individual: RegionPlan | null | undefined;
  common: RegionPlan | null | undefined;
  hybrid: RegionPlan | null | undefined;
  sharedIndividual: RegionPlan | null | undefined;
  sharedCommon: RegionPlan | null | undefined;
  sharedHybrid: RegionPlan | null | undefined;
}

export interface RegionNeighbor {
  regions: Bounds[];
  heuristic: number;
}

export interface RegionVariant {
  regions: Bounds[];
  label: string | null;
  planCache: RegionPlanCache | null;
}
