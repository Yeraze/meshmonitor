/**
 * Per-node-type marker glyph icons for the 3D map (#4808).
 *
 * The 2D map draws distinct role glyphs (repeater tower, sensor, room server,
 * companion) over a white disc, hop-colored, via `roleGlyphMarkerSvg`. MapLibre
 * SDF icons are single-color (they can only be tinted one flat color), so they
 * can't reproduce the white-disc + colored-glyph look. Instead we rasterize the
 * full-color SVG marker to a normal RGBA image, one per (glyph family, hop
 * color) pair, and register it lazily through MapLibre's `styleimagemissing`
 * event — so only the combinations actually on screen are ever generated.
 *
 * Icon id format is `"<family>_<hexColor>"` (e.g. `"repeater_#0000FF"`). The
 * `standard` family has no glyph and keeps the shared SDF disc instead, so it
 * never routes through here.
 */
import { roleGlyphMarkerSvg } from '../../utils/roleGlyphSvg';
import type { NodeTypeCategory } from '../../utils/nodeTypeCategory';

/** Source resolution of a generated glyph image (device px). */
export const GLYPH_ICON_SIZE = 64;

/** Compose the icon id used both in the GeoJSON `iconImage` prop and addImage. */
export function glyphIconId(family: string, color: string): string {
  return `${family}_${color}`;
}

/**
 * Split a `"<family>_<color>"` icon id back into its parts, on the FIRST `_`.
 * Safe because family names contain no `_` (a hex color has `#` but no `_`); if
 * a future family name introduces one, switch this to a fixed separator.
 */
export function parseGlyphIconId(id: string): { family: string; color: string } | null {
  const i = id.indexOf('_');
  if (i < 0) return null;
  return { family: id.slice(0, i), color: id.slice(i + 1) };
}

/**
 * Rasterize the full-color role-glyph marker SVG to an ImageData, ready for
 * `map.addImage`. Browser-only (uses Image + canvas); returns null for a family
 * with no glyph or if the 2D context/rasterization is unavailable.
 */
export async function rasterizeGlyphIcon(
  family: string,
  color: string,
  size: number = GLYPH_ICON_SIZE,
): Promise<ImageData | null> {
  const svg = roleGlyphMarkerSvg(family as NodeTypeCategory, color, size);
  if (!svg) return null;
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const img = new Image();
  img.width = size;
  img.height = size;
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('glyph svg load failed'));
      img.src = url;
    });
  } catch {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}
