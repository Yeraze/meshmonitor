import { describe, expect, it } from 'vitest';
import { batteryIconName } from './batteryIcon';
import { UI_ICON_DEFINITIONS } from './UiIcon';

describe('batteryIconName (#5946)', () => {
  it.each([
    [0, 'batteryEmpty'],
    [9, 'batteryEmpty'],
    [10, 'batteryLow'],
    [49, 'batteryLow'],
    [50, 'batteryMedium'],
    [85, 'batteryMedium'],
    [86, 'batteryFull'],
    [93, 'batteryFull'],
    [100, 'batteryFull'],
    [101, 'batteryCharging'],
  ])('level %d → %s', (level, name) => {
    expect(batteryIconName(level)).toBe(name);
  });

  it('keeps the plain outline for an unknown level', () => {
    expect(batteryIconName(null)).toBe('battery');
    expect(batteryIconName(undefined)).toBe('battery');
    expect(batteryIconName(Number.NaN)).toBe('battery');
  });

  it('returns only registered icon names', () => {
    for (const level of [null, 0, 10, 50, 86, 101]) {
      expect(UI_ICON_DEFINITIONS[batteryIconName(level)]).toBeDefined();
    }
  });
});
