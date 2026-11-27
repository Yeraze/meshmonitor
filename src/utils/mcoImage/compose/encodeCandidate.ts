import { base91Encode } from '../base91.js';
import { detectMcoImage } from '../detect.js';
import { SUBTYPE_VERSION, TEXT_PREFIX } from '../v3/constants.js';
import { decodeV3Text } from '../v3/decoder.js';
import { decodeV4Text } from '../v4/decoder.js';
import { im4TextFromV3Body } from '../v4/rasterEncoder.js';
import { pickShortestNonce } from './nonce.js';
import { matteWhite, quantize } from './quantize.js';
import { resizeArea, targetDims } from './resize.js';
import type { Candidate, CandidateResult, EncodeV3Fn, McoLevel, RgbaImage } from './types.js';

export class McoComposeSelfCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McoComposeSelfCheckError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function samePixels(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Resize, matte, quantize, encode (v3 without nonce), build the IM3 and IM4 texts with the
 * shortest nonce, and decode both back: a text that does not decode to the quantized pixels is
 * never returned (McoComposeSelfCheckError).
 */
export function encodeCandidate(
  src: RgbaImage,
  c: Candidate,
  level: McoLevel,
  rng: () => number,
  deps: { encodeV3: EncodeV3Fn },
): CandidateResult {
  const started = Date.now();
  const { w, h } = targetDims(src.width, src.height, c.longest);
  const pixels = quantize(matteWhite(resizeArea(src, w, h)), c.profile, { dither: c.dither });
  const encoded = deps.encodeV3(
    { width: w, height: h, paletteProfile: c.profile, pixels, transparentColor: null },
    { level, packetNonce: 0 },
  );
  const inner = encoded.bodyWithoutNonce;
  const im3 = pickShortestNonce((nonce) => {
    const bytes = new Uint8Array(inner.length + 2);
    bytes[0] = SUBTYPE_VERSION;
    bytes[1] = nonce;
    bytes.set(inner, 2);
    return `${TEXT_PREFIX}${base91Encode(bytes)}`;
  }, rng);
  const im4 = pickShortestNonce(
    (nonce) => im4TextFromV3Body({ width: w, height: h, profile: c.profile, v3BodyWithoutNonce: inner, nonce }),
    rng,
  );

  for (const [name, text] of [['im3', im3.text], ['im4', im4.text]] as const) {
    if (detectMcoImage(text)?.format !== name) throw new McoComposeSelfCheckError(`${name} text is not detected`);
  }
  const d3 = decodeV3Text(im3.text);
  if (d3.width !== w || d3.height !== h || d3.paletteProfile !== c.profile || !samePixels(d3.pixels, pixels)) {
    throw new McoComposeSelfCheckError('im3 text does not decode to the quantized pixels');
  }
  const d4 = decodeV4Text(im4.text).document;
  const fig = d4.figures[0];
  if (
    d4.width !== w ||
    d4.height !== h ||
    d4.figures.length !== 1 ||
    fig.kind !== 'raster' ||
    !samePixels(fig.pixels, pixels)
  ) {
    throw new McoComposeSelfCheckError('im4 text does not decode to the quantized pixels');
  }
  return {
    w,
    h,
    profile: c.profile,
    dither: c.dither,
    level,
    im3Text: im3.text,
    im4Text: im4.text,
    im3Bytes: im3.text.length,
    im4Bytes: im4.text.length,
    ms: Date.now() - started,
  };
}
