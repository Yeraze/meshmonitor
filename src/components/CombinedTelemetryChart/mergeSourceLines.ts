/**
 * Merge the per-source lines of an objective telemetry series into one line
 * (#5931).
 *
 * An objective type (battery, temperature, voltage) is measured by the remote
 * node itself, so two sources' lines are two copies of the same readings, each
 * with its own gaps. Merging them fills one source's gaps from another.
 *
 * Averaged types arrive as fixed time buckets that line up across sources, so
 * points with the same timestamp are the same bucket. Raw (unaveraged) types
 * carry each source's receive time, so one packet heard by two sources lands a
 * few seconds apart; points from different sources less than `windowMs` after
 * the group's first point count as one reading. A source never merges with its own
 * points. A group's value is the mean of its points.
 */

export interface MergeInputLine {
  sourceName: string;
  points: ReadonlyArray<{ timestamp: number; value: number }>;
}

export interface MergedPoint {
  timestamp: number;
  value: number;
  /** The sources that held this reading, in line order. */
  sources: string[];
}

/**
 * One packet heard by two sources is stored less than this far apart. Strictly
 * less, so two sources' adjacent 1-minute buckets stay apart.
 */
export const MERGE_WINDOW_MS = 60_000;

export function mergeSourceLines(lines: ReadonlyArray<MergeInputLine>, windowMs = MERGE_WINDOW_MS): MergedPoint[] {
  const all: Array<{ timestamp: number; value: number; line: number }> = [];
  lines.forEach((l, line) => {
    for (const p of l.points) all.push({ timestamp: p.timestamp, value: p.value, line });
  });
  all.sort((a, b) => a.timestamp - b.timestamp || a.line - b.line);

  const out: MergedPoint[] = [];
  let group: typeof all = [];
  const flush = () => {
    if (group.length === 0) return;
    const order = [...new Set(group.map((p) => p.line))].sort((a, b) => a - b);
    out.push({
      timestamp: group[0].timestamp,
      value: group.reduce((sum, p) => sum + p.value, 0) / group.length,
      sources: order.map((i) => lines[i].sourceName),
    });
    group = [];
  };
  for (const p of all) {
    const fits = group.length > 0
      && p.timestamp - group[0].timestamp < windowMs
      && !group.some((g) => g.line === p.line);
    if (!fits) flush();
    group.push(p);
  }
  flush();
  return out;
}
