/**
 * Timer for App's "is the source back yet?" check.
 *
 * Runs `check` while `shouldCheck()` is true, with a growing delay while the
 * result stays the same (5 s, 10 s, 20 s, then every 30 s). A different result
 * starts over at 5 s. Nothing runs while the tab is hidden; when it becomes
 * visible again, one check runs at once and the delay starts over.
 *
 * `shouldCheck` and `check` are read through refs, so the caller may pass new
 * closures on every render without restarting the timer.
 */
import { useEffect, useRef } from 'react';
import { connectionCheckDelay } from './connectionCheck';

interface UseConnectionCheckLoopOptions {
  /** False while no check is wanted (connected, rebooting, user-disconnected...). */
  shouldCheck: () => boolean;
  /** Runs one check and returns its result; equal results in a row back off. */
  check: () => Promise<unknown>;
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export function useConnectionCheckLoop({ shouldCheck, check }: UseConnectionCheckLoopOptions): void {
  const shouldCheckRef = useRef(shouldCheck);
  const checkRef = useRef(check);
  shouldCheckRef.current = shouldCheck;
  checkRef.current = check;

  useEffect(() => {
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unchanged = 0;
    let hasLast = false;
    let last: unknown;

    const clear = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    const schedule = () => {
      clear();
      if (stopped || isHidden()) return;
      timer = setTimeout(() => void tick(), connectionCheckDelay(unchanged));
    };

    const tick = async () => {
      if (stopped || running) return;
      if (!shouldCheckRef.current()) {
        // Connected (or paused on purpose): the next disconnect starts at 5 s.
        unchanged = 0;
        hasLast = false;
        schedule();
        return;
      }
      running = true;
      let result: unknown;
      try {
        result = await checkRef.current();
      } catch {
        result = undefined;
      } finally {
        running = false;
      }
      if (stopped) return;
      unchanged = hasLast && Object.is(result, last) ? unchanged + 1 : 0;
      last = result;
      hasLast = true;
      schedule();
    };

    const onVisibilityChange = () => {
      if (isHidden()) {
        clear();
        return;
      }
      unchanged = 0;
      hasLast = false;
      clear();
      void tick();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    schedule();
    return () => {
      stopped = true;
      clear();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
}
