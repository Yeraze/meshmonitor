/**
 * Group consecutive ignored messages (#5408) so the stream can collapse each
 * run into one "N ignored messages" row.
 */
export interface IgnoredRun {
  /** Id of the first message in the run — stable while the run grows. */
  key: string;
  startIndex: number;
  count: number;
}

/**
 * Map every index that belongs to a run of `filtered` messages to its run.
 * Messages without `filtered` break a run.
 */
export function findIgnoredRuns(messages: ReadonlyArray<{ id: string; filtered?: string }>): Map<number, IgnoredRun> {
  const byIndex = new Map<number, IgnoredRun>();
  let current: IgnoredRun | null = null;
  messages.forEach((m, i) => {
    if (!m.filtered) {
      current = null;
      return;
    }
    if (!current) current = { key: m.id, startIndex: i, count: 0 };
    current.count += 1;
    byIndex.set(i, current);
  });
  return byIndex;
}
