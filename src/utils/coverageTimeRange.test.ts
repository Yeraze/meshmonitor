import { describe, it, expect } from 'vitest';
import { resolveCoverageWindow, COVERAGE_RANGE_PRESET_MS } from './coverageTimeRange';

const NOW = 1_700_000_000_000;

/**
 * Builds a `datetime-local`-shaped string (`YYYY-MM-DDTHH:MM`) using LOCAL
 * getters, so re-parsing it with `new Date(str)` (which treats a
 * 'Z'-less/offset-less string as LOCAL time) round-trips back to `ms`
 * exactly. `toISOString().slice(0, 16)` would NOT round-trip here — it
 * produces UTC wall-clock digits, which `new Date()` then reinterprets as
 * LOCAL time, silently shifting the instant by the runner's UTC offset.
 */
function toDatetimeLocalString(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe('resolveCoverageWindow', () => {
  it('resolves a fixed preset relative to nowMs', () => {
    const w = resolveCoverageWindow('24h', NOW);
    expect(w.sinceMs).toBe(NOW - COVERAGE_RANGE_PRESET_MS['24h']);
    expect(w.untilMs).toBe(NOW);
    expect(w.rangeInvalid).toBe(false);
  });

  it('resolves every fixed preset window size', () => {
    (['1h', '6h', '24h', '3d', '7d'] as const).forEach((preset) => {
      const w = resolveCoverageWindow(preset, NOW);
      expect(w.untilMs - w.sinceMs).toBe(COVERAGE_RANGE_PRESET_MS[preset]);
    });
  });

  it('resolves a valid custom from/to pair', () => {
    const from = toDatetimeLocalString(NOW - 3_600_000);
    const to = toDatetimeLocalString(NOW);
    const w = resolveCoverageWindow('custom', NOW, from, to);
    expect(w.rangeInvalid).toBe(false);
    expect(w.sinceMs).toBe(new Date(from).getTime());
    expect(w.untilMs).toBe(new Date(to).getTime());
  });

  it('defaults "to" to nowMs when customTo is omitted', () => {
    const from = toDatetimeLocalString(NOW - 3_600_000);
    const w = resolveCoverageWindow('custom', NOW, from, '');
    expect(w.rangeInvalid).toBe(false);
    expect(w.untilMs).toBe(NOW);
  });

  it('flags rangeInvalid when "to" is before "from", with a safe 24h fallback', () => {
    const from = toDatetimeLocalString(NOW);
    const to = toDatetimeLocalString(NOW - 3_600_000);
    const w = resolveCoverageWindow('custom', NOW, from, to);
    expect(w.rangeInvalid).toBe(true);
    expect(w.sinceMs).toBe(NOW - COVERAGE_RANGE_PRESET_MS['24h']);
    expect(w.untilMs).toBe(NOW);
  });

  it('flags rangeInvalid when "from" is unparsable/absent', () => {
    const w = resolveCoverageWindow('custom', NOW, '', '');
    expect(w.rangeInvalid).toBe(true);
  });

  it('is pure: identical inputs always give identical output', () => {
    const a = resolveCoverageWindow('24h', NOW);
    const b = resolveCoverageWindow('24h', NOW);
    expect(a).toEqual(b);
  });
});
