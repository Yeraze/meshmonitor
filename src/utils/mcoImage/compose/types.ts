/**
 * Shared types for the MCOimg compose pipeline (Phase 3 of #6586).
 * Pure types: safe to import from the main bundle. No runtime code here.
 */
import type { PaletteProfileId } from '../v3/constants.js';

/** Compression level of the v3 search. Normal drives the fit search; High refines. */
export type McoLevel = 'normal' | 'high';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA8888, row major, `width * height * 4` bytes. */
  rgba: Uint8ClampedArray;
}

export interface RgbImage {
  width: number;
  height: number;
  /** RGB888, row major, `width * height * 3` bytes. Already matted on white. */
  rgb: Uint8ClampedArray;
}

/** One thing to encode: a target size, a palette and the dither switch. */
export interface Candidate {
  /** Longest side of the encoded image, in pixels. */
  longest: number;
  profile: PaletteProfileId;
  dither: boolean;
}

export interface CandidateResult {
  w: number;
  h: number;
  profile: PaletteProfileId;
  dither: boolean;
  level: McoLevel;
  im3Text: string;
  im4Text: string;
  /** Text length in bytes (the payloads are ASCII). */
  im3Bytes: number;
  im4Bytes: number;
  /** Wall-clock time of the encode, for diagnostics. */
  ms: number;
}

/** Structural copy of the v3 encoder surface (`v3/encoder/encode.ts`), injected so tests can stub it. */
export interface McoV3EncodeInputLike {
  width: number;
  height: number;
  paletteProfile: PaletteProfileId;
  pixels: ArrayLike<number>;
  transparentColor?: number | null;
}
export interface McoV3EncodeResultLike {
  body: Uint8Array;
  bodyWithoutNonce: Uint8Array;
  text: string;
}
export type EncodeV3Fn = (
  image: McoV3EncodeInputLike,
  opts: { level: McoLevel; packetNonce: number },
) => McoV3EncodeResultLike;

// ---- worker protocol -------------------------------------------------------

export type EncodeRequest =
  | { type: 'setSource'; source: RgbaImage }
  | { type: 'encode'; gen: number; jobId: number; candidate: Candidate; level: McoLevel };

export type EncodeResponse =
  | { type: 'sourceSet' }
  | { type: 'result'; gen: number; jobId: number; candidate: Candidate; level: McoLevel; result: CandidateResult }
  | { type: 'error'; gen: number; jobId: number; candidate: Candidate; level: McoLevel; message: string };

// ---- dialog ----------------------------------------------------------------

export interface McoImageComposeDialogProps {
  open: boolean;
  /** Byte limit of the conversation the image goes into. */
  limit: number;
  draftNotEmpty: boolean;
  onChoose(text: string): void;
  onClose(): void;
}
