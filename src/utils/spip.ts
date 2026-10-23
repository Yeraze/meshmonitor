/**
 * Small Packet Image Protocol 1.0 (SPIP1) decoder.
 *
 * SPIP packs a tiny pixel image into one text message: `<cols>:<pixels>`, one
 * character per pixel, row by row. Letters a–x are colours, y/z are black and
 * white, and 1–9 are greys; case is ignored and 0 is reserved. The spec and the
 * reference editor live at https://github.com/lilyellowtags/spip-editor.
 *
 * Example: `3:yzyzyzyzy` is a 3x3 black-and-white checkerboard.
 */

export const SPIP_PALETTE: Readonly<Record<string, string>> = {
  a: '#ff0000', b: '#ff8080', c: '#7e0000',
  d: '#ff7f00', e: '#ffbf80', f: '#7f4000',
  g: '#ffff00', h: '#ffff80', i: '#7f7f00',
  j: '#00ff00', k: '#a8ff81', l: '#287f00',
  m: '#0000ff', n: '#8080ff', o: '#000080',
  p: '#9300ff', q: '#ca80ff', r: '#4b0082',
  s: '#00ffff', t: '#7effff', u: '#008080',
  v: '#ff008a', w: '#ff80c3', x: '#800044',
  y: '#000000', z: '#ffffff',
  1: '#1a1a1a', 2: '#333333', 3: '#4d4d4d',
  4: '#666666', 5: '#808080', 6: '#999999',
  7: '#b3b3b3', 8: '#cccccc', 9: '#e5e5e5',
};

/** Widest image we render; the spec targets 3–12 columns. */
export const SPIP_MAX_COLS = 32;
/** Pixel cap, well above what fits in one Meshtastic or MeshCore packet. */
export const SPIP_MAX_PIXELS = 1024;

export interface SpipImage {
  cols: number;
  rows: number;
  /** Hex colour per pixel, row-major. */
  pixels: string[];
}

const SPIP_REGEX = /^(\d{1,2}):([a-z1-9]+)$/i;

/**
 * Decode a message that is entirely one SPIP image, or return null.
 *
 * Detection is strict so ordinary chat is never swallowed: the whole message
 * must be the code, the grid must be at least 2x2, and the pixel count must
 * fill whole rows. That keeps times and references such as `12:30` or `3:16`
 * as text.
 */
export function parseSpip(text: string | null | undefined): SpipImage | null {
  if (!text) return null;
  const match = SPIP_REGEX.exec(text.trim());
  if (!match) return null;

  const cols = parseInt(match[1], 10);
  const data = match[2].toLowerCase();
  if (cols < 2 || cols > SPIP_MAX_COLS) return null;
  if (data.length > SPIP_MAX_PIXELS || data.length % cols !== 0) return null;

  const rows = data.length / cols;
  if (rows < 2) return null;

  return { cols, rows, pixels: Array.from(data, ch => SPIP_PALETTE[ch]) };
}
