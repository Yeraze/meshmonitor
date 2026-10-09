import { describe, it, expect } from 'vitest';
import { trackBackgroundTask, waitForBackgroundTasks } from './backgroundTasks.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('backgroundTasks', () => {
  it('resolves at once when nothing is in flight', async () => {
    await expect(waitForBackgroundTasks()).resolves.toBeUndefined();
  });

  it('waits for a tracked task, and for one started while it waited', async () => {
    const first = deferred();
    const second = deferred();
    trackBackgroundTask(first.promise);

    let drained = false;
    const wait = waitForBackgroundTasks().then(() => { drained = true; });

    trackBackgroundTask(second.promise);
    first.resolve();
    await tick();
    expect(drained).toBe(false);

    second.resolve();
    await wait;
    expect(drained).toBe(true);
  });

  it('never rejects, even when a tracked task does', async () => {
    const task = deferred();
    task.promise.catch(() => {}); // the caller owns error handling
    trackBackgroundTask(task.promise);
    task.reject(new Error('boom'));
    await expect(waitForBackgroundTasks()).resolves.toBeUndefined();
  });
});
