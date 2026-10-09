/**
 * Registry of fire-and-forget work that no caller awaits: the DatabaseService
 * startup user checks, "new node" notifications and the like.
 *
 * Production code never needs to wait on these. The test setup does: Vitest
 * tears a file's module graph down as soon as its last test ends, and any
 * tracked work still running then (a dynamic import, a console log) lands
 * after teardown. A late console call leaves Vitest's `onUserConsoleLog` RPC
 * pending when the worker closes, which fails the whole run with an
 * `EnvironmentTeardownError` even though every test passed.
 * `src/test/setup.ts` awaits `waitForBackgroundTasks()` in `afterAll`.
 */

const pending = new Set<Promise<unknown>>();

/**
 * Track a promise nobody awaits. The caller must attach its own error handler
 * first; this only records that the work is in flight.
 */
export function trackBackgroundTask(task: Promise<unknown>): void {
  const tracked: Promise<unknown> = task.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    pending.delete(tracked);
  });
  pending.add(tracked);
}

/** Resolve once every tracked task, including ones started meanwhile, has settled. */
export async function waitForBackgroundTasks(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}
