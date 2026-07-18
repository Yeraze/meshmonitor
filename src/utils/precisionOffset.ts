/**
 * Deterministic within-cell offset for obscured (low-precision) GPS node markers
 * on the Map Analysis map (issue #4016).
 *
 * Meshtastic's `precision_bits` snaps a reported position to a grid cell; the
 * true position could be anywhere inside that cell. Rendering the marker at the
 * dead-center of the cell implies precision the node never reported and stacks
 * same-cell nodes on one point. Instead we deterministically jitter each such
 * marker to a stable spot *within* its own cell — more honest, and it declutters
 * same-cell piles without a click.
 *
 * The cell-size math mirrors the accuracy-region rectangle drawn on the Dashboard
 * map (`DashboardMap.tsx`) and `formatPrecisionAccuracy` (`utils/distance.ts`),
 * so an offset marker always lands inside the drawn rectangle.
 */
import { djb2Hash } from './loraFrequency';

/** Meters per degree of latitude (matches DashboardMap / distance.ts). */
const METERS_PER_DEGREE = 111_111;

/**
 * Precision bits at/below which the accuracy cell is large enough (~180m+) that
 * centering is misleading and offsetting is worthwhile. At 18 bits the cell side
 * is `2^(32-18) * 1e-7 * 111111 ≈ 182m`.
 */
export const OBSCURED_PRECISION_MAX_BITS = 18;

/**
 * Cap the marker jitter magnitude at the size of this precision cell (#4155).
 * Coarser (fewer-bit) cells are enormous — a 1-bit cell spans more than half the
 * globe — so scaling the jitter to the node's own cell would fling the marker
 * absurd (multi-km to continental) distances from its reported point. 15 bits
 * ≈ a 1,456 m cell; markers in any coarser cell jitter no further than that.
 * For bits ≥ 15 the true cell is already smaller, so the cap is a no-op and
 * behavior is unchanged. The drawn accuracy rectangle stays honest (full true
 * cell) — only the marker offset is capped, so it still lands inside the square.
 */
export const OFFSET_MAGNITUDE_CAP_BITS = 15;

/**
 * Cell occupancy at which the occupancy-based offset scale reaches its maximum
 * (#4155). Below this, the scale grows logarithmically with the number of nodes
 * sharing the cell; at/above it, the full (capped) within-cell spread is used.
 */
export const OFFSET_SPREAD_SATURATION_OCCUPANCY = 8;

/** Full accuracy-cell side length in meters for a given precision. */
export function precisionCellSizeMeters(bits: number): number {
  return Math.pow(2, 32 - bits) * 1e-7 * METERS_PER_DEGREE;
}

/** Full accuracy-cell side length in degrees of latitude. */
export function precisionCellSizeDegrees(bits: number): number {
  return Math.pow(2, 32 - bits) * 1e-7;
}

/**
 * Whether a node has a meaningful accuracy cell to draw a rectangle for: a
 * defined, non-full precision (1..31 bits) that isn't a user override. Broader
 * than {@link shouldOffsetForPrecision} — the marker is only *offset* for large
 * cells (≤18 bits), but the accuracy square is drawn for any imprecise fix.
 */
export function hasAccuracyCell(
  bits: number | null | undefined,
  isOverride: boolean | null | undefined,
): boolean {
  if (isOverride) return false;
  if (bits == null) return false;
  return bits > 0 && bits < 32;
}

/**
 * Whether a node's marker should be offset within its precision cell.
 * Only nodes with a *defined* low precision (1..MAX bits) qualify; nodes with a
 * user-overridden position, missing/zero precision, or fine GPS are left at their
 * exact reported point.
 */
export function shouldOffsetForPrecision(
  bits: number | null | undefined,
  isOverride: boolean | null | undefined,
): bits is number {
  if (isOverride) return false;
  if (bits == null) return false;
  return bits >= 1 && bits <= OBSCURED_PRECISION_MAX_BITS;
}

/**
 * Accuracy-region rectangle bounds `[[latMin, lngMin], [latMax, lngMax]]` for a
 * position at (lat, lng) with the given precision. The reported position is the
 * cell center; the rectangle spans ± half a cell. Mirrors the Dashboard map's
 * accuracy-region math so both maps draw the identical square.
 */
export function precisionCellBounds(
  lat: number,
  lng: number,
  bits: number,
): [[number, number], [number, number]] {
  const halfMeters = precisionCellSizeMeters(bits) / 2;
  const latOffset = halfMeters / METERS_PER_DEGREE;
  const metersPerDegreeLng = METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
  const lngOffset = metersPerDegreeLng !== 0 ? halfMeters / metersPerDegreeLng : halfMeters / METERS_PER_DEGREE;
  return [
    [lat - latOffset, lng - lngOffset],
    [lat + latOffset, lng + lngOffset],
  ];
}

/**
 * Offset-magnitude scale in `[0,1]` for a precision cell shared by `occupancy`
 * nodes (#4155). A lone node returns 0 (nothing to declutter — leave it at its
 * true center). For 2+ occupants the scale grows LOGARITHMICALLY with the count
 * and saturates at 1 by {@link OFFSET_SPREAD_SATURATION_OCCUPANCY}: a more
 * crowded cell spreads its markers across more of the cell, but stepping 2→3
 * nudges the spread far less than 1→2, so lightly-shared cells aren't
 * over-spread.
 */
export function occupancyOffsetScale(occupancy: number): number {
  if (occupancy < 2) return 0;
  const scale = Math.log2(occupancy) / Math.log2(OFFSET_SPREAD_SATURATION_OCCUPANCY);
  return Math.min(1, scale);
}

/**
 * Deterministically offset (lat, lng) to a stable point within the node's
 * accuracy cell. The offset is a pure function of `id`, so it is identical across
 * re-renders/polls (the marker never jumps).
 *
 * The jitter magnitude is bounded two ways, both of which only ever SHRINK it —
 * so the result always stays within `± halfCell` of the input, i.e. inside the
 * drawn accuracy rectangle:
 *  - capped at an {@link OFFSET_MAGNITUDE_CAP_BITS}-bit cell so coarse-precision
 *    markers don't fling far from their reported point (#4155);
 *  - scaled by `spread` in `[0,1]` (occupancy-based, see
 *    {@link occupancyOffsetScale}) — `1` uses the full capped cell.
 */
export function offsetWithinPrecisionCell(
  lat: number,
  lng: number,
  bits: number,
  id: string,
  spread: number = 1,
): [number, number] {
  // Cap the effective cell at OFFSET_MAGNITUDE_CAP_BITS before scaling by
  // occupancy. min() (not the raw cell) is what bounds coarse-precision jitter.
  const cappedSizeDeg = Math.min(
    precisionCellSizeDegrees(bits),
    precisionCellSizeDegrees(OFFSET_MAGNITUDE_CAP_BITS),
  );
  const sizeDeg = cappedSizeDeg * spread;
  // Two independent fractions in [0,1) from one id.
  const fx = (djb2Hash(id) % 1_000_000) / 1_000_000;
  const fy = (djb2Hash(`${id}:y`) % 1_000_000) / 1_000_000;
  const latOffset = (fx - 0.5) * sizeDeg;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Longitude degrees shrink with latitude; guard the poles (cos→0).
  const lngSizeDeg = cosLat !== 0 ? sizeDeg / cosLat : sizeDeg;
  const lngOffset = (fy - 0.5) * lngSizeDeg;
  return [lat + latOffset, lng + lngOffset];
}

/**
 * Stable key identifying the accuracy cell a reported position falls in, used to
 * count how many nodes share a cell before deciding whether to offset (issue
 * #4155). Firmware snaps an obscured position to its cell, so same-cell nodes of
 * the same precision report identical coordinates and floor to identical grid
 * indices. `bits` is part of the key because a different precision means a
 * different cell size — i.e. a different cell — so two nodes only "share a cell"
 * when both their snapped position AND their precision match.
 */
export function precisionCellKey(lat: number, lng: number, bits: number): string {
  const size = precisionCellSizeDegrees(bits);
  const latIdx = Math.floor(lat / size);
  const lngIdx = Math.floor(lng / size);
  return `${bits}:${latIdx}:${lngIdx}`;
}

/**
 * One node fed to {@link applyPrecisionCellOffsets}: an opaque `item` carried
 * through untouched, a stable hash `id` (use `unifiedNodeKey` semantics so the
 * SAME node lands on the SAME in-cell spot on every map), the node's TRUE reported
 * center `latLng`, and its precision/override flags.
 */
export interface PrecisionOffsetInput<T> {
  item: T;
  id: string;
  latLng: [number, number];
  bits: number | null | undefined;
  isOverride: boolean | null | undefined;
}

/**
 * Occupancy-gated within-cell offset for a set of positioned nodes — the single
 * shared implementation used by every map surface (Dashboard, NodesTab, Map
 * Analysis) so obscured-GPS markers declutter identically everywhere.
 *
 * A node is offset to a deterministic spot inside its accuracy cell (#4016) ONLY
 * when 2+ offsettable nodes share that cell (#4155); a node alone in its cell
 * stays at its true reported center (offsetting a lone marker just implies a
 * position it never reported). Nodes with fine/absent precision or a user
 * override are never moved. Pure and deterministic given the same input.
 *
 * The offset magnitude is refined two ways (#4155): it scales LOGARITHMICALLY
 * with the cell's occupancy ({@link occupancyOffsetScale}) so a crowded cell
 * spreads wider than a barely-shared one, and it is capped at an
 * {@link OFFSET_MAGNITUDE_CAP_BITS}-bit cell ({@link offsetWithinPrecisionCell})
 * so coarse-precision markers don't scatter kilometers away. Because a node is
 * only ever offset when 2+ nodes of the SAME precision share the SAME cell
 * ({@link precisionCellKey} folds `bits` into the key), two nodes with
 * overlapping but differently-sized accuracy regions are each alone in their own
 * cell and stay put — so the offset can never push them closer together than
 * their true centers.
 *
 * Returns each input's `item` paired with its resolved `latLng` (offset where the
 * cell has 2+ occupants, true center otherwise), in the input order.
 */
export function applyPrecisionCellOffsets<T>(
  nodes: ReadonlyArray<PrecisionOffsetInput<T>>,
): Array<{ item: T; latLng: [number, number] }> {
  // Pass 1: for each node resolve its accuracy cell (null when not offsettable)
  // and count occupancy. `shouldOffsetForPrecision` is evaluated once per node
  // here; it also narrows `bits` to a number, which we capture for pass 2.
  const occupancy = new Map<string, number>();
  const cellOf = nodes.map((n) => {
    if (!shouldOffsetForPrecision(n.bits, n.isOverride)) return null;
    const cell = precisionCellKey(n.latLng[0], n.latLng[1], n.bits);
    occupancy.set(cell, (occupancy.get(cell) ?? 0) + 1);
    return { cell, bits: n.bits };
  });
  // Pass 2: offset only nodes whose cell has 2+ occupants, scaling the jitter
  // logarithmically by that cell's occupancy (#4155).
  return nodes.map((n, i) => {
    const c = cellOf[i];
    const occ = c ? (occupancy.get(c.cell) ?? 0) : 0;
    if (c && occ >= 2) {
      const spread = occupancyOffsetScale(occ);
      return { item: n.item, latLng: offsetWithinPrecisionCell(n.latLng[0], n.latLng[1], c.bits, n.id, spread) };
    }
    return { item: n.item, latLng: n.latLng };
  });
}
