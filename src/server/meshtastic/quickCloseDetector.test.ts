import { describe, it, expect } from 'vitest';
import { QuickCloseDetector, QUICK_CLOSE_WARN_INTERVAL_MS } from './quickCloseDetector.js';

/** Connect at `t`, close `uptime` ms later; returns the warning (or null). */
function cycle(d: QuickCloseDetector, t: number, uptime: number): string | null {
  d.noteConnected(t);
  return d.noteClosed(t + uptime);
}

describe('QuickCloseDetector (#5974)', () => {
  it('stays quiet for fewer than three quick closes', () => {
    const d = new QuickCloseDetector();
    expect(cycle(d, 0, 1_000)).toBeNull();
    expect(cycle(d, 10_000, 1_000)).toBeNull();
  });

  it('warns on the third quick close in a row', () => {
    const d = new QuickCloseDetector();
    cycle(d, 0, 1_000);
    cycle(d, 10_000, 2_000);
    const msg = cycle(d, 20_000, 4_999);
    expect(msg).toContain('3 times within seconds of connecting');
    expect(msg).toContain("single TCP slot");
  });

  it('a session that lasts past the window breaks the streak', () => {
    const d = new QuickCloseDetector();
    cycle(d, 0, 1_000);
    cycle(d, 10_000, 1_000);
    expect(cycle(d, 20_000, 60_000)).toBeNull();
    expect(cycle(d, 90_000, 1_000)).toBeNull();
    expect(cycle(d, 100_000, 1_000)).toBeNull();
    expect(cycle(d, 110_000, 1_000)).not.toBeNull();
  });

  it('warns at most once per rate-limit window, then again after it', () => {
    const d = new QuickCloseDetector();
    let t = 0;
    const warnings: number[] = [];
    // A 3s/60s loop like the reporter's: one cycle per minute for 40 minutes.
    for (let i = 0; i < 40; i++) {
      if (cycle(d, t, 1_300)) warnings.push(t);
      t += 60_000;
    }
    expect(warnings.length).toBe(3);
    expect(warnings[1] - warnings[0]).toBeGreaterThanOrEqual(QUICK_CLOSE_WARN_INTERVAL_MS);
  });

  it('ignores a close with no matching connect', () => {
    const d = new QuickCloseDetector({ threshold: 1 });
    expect(d.noteClosed(5)).toBeNull();
  });

  it('reset() forgets the streak', () => {
    const d = new QuickCloseDetector();
    cycle(d, 0, 1_000);
    cycle(d, 10_000, 1_000);
    d.reset();
    expect(cycle(d, 20_000, 1_000)).toBeNull();
  });
});
