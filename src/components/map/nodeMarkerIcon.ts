/**
 * Node marker icon for the 3D map (#4800).
 *
 * Lives in its own module (not `Base3DMap.tsx`) so the component file exports
 * only its component — a non-component export there trips
 * `react-refresh/only-export-components`.
 */

/** Id of the generated SDF disc image used as the node marker icon. */
export const NODE_MARKER_IMAGE_ID = 'node-marker-icon';

/**
 * Source resolution of the marker image (device px); the symbol layer scales it
 * down via `icon-size`. 64px gives a crisp dot after downscaling.
 */
export const NODE_MARKER_IMAGE_SIZE = 64;

/**
 * Build a signed-distance-field (SDF) disc image for the node marker symbol.
 *
 * MapLibre `circle` layers do NOT drape onto 3D terrain — they render at
 * elevation 0, so with exaggerated terrain the surface rises above them and the
 * node dots vanish under the mesh (the reported bug). `symbol` layers, by
 * contrast, are elevated onto the terrain surface, so the dot is drawn as a
 * symbol using this icon instead of a circle layer.
 *
 * The image is an SDF: RGB is solid white and the disc is encoded in the alpha
 * channel. That lets one shared image be tinted per-node via `icon-color` and
 * outlined via `icon-halo-color`/`icon-halo-width`, reproducing the 2D circle
 * marker's coloured-fill-plus-white-ring look. Per MapLibre's SDF convention
 * the shape edge sits at alpha 191 (0.75 x 255): alpha climbs toward 255 inside
 * the disc and falls toward 0 outside, over a short linear ramp so the halo has
 * a gradient to render against.
 *
 * Pure and canvas-free so it is deterministic and unit-testable (jsdom has no
 * canvas); the returned object is accepted directly by `map.addImage`.
 */
export function createNodeMarkerImage(
  size: number = NODE_MARKER_IMAGE_SIZE,
): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(size * size * 4);
  const center = (size - 1) / 2;
  // Leave a ring of padding so the halo has room and the disc never clips.
  const radius = size / 2 - 6;
  const EDGE = 191; // 0.75 * 255 — MapLibre's SDF edge threshold
  const RAMP = 16; // alpha units per pixel of signed distance
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = radius - Math.hypot(x - center, y - center); // > 0 inside
      const alpha = Math.max(0, Math.min(255, Math.round(EDGE + dist * RAMP)));
      const i = (y * size + x) * 4;
      data[i] = 255; // R — white, recolored per-node by icon-color
      data[i + 1] = 255; // G
      data[i + 2] = 255; // B
      data[i + 3] = alpha;
    }
  }
  return { width: size, height: size, data };
}
