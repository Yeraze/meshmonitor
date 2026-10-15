/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSectionBaseline } from './useSectionBaseline';

type V = { name: string; interval: number; keys: string[]; lat: number };
const start: V = { name: 'a', interval: 900, keys: ['k1'], lat: 0 };

const setup = () =>
  renderHook(
    ({ values, version }: { values: V; version: number }) =>
      useSectionBaseline(values, { reseedKey: version, keepOnReseed: ['lat'] }),
    { initialProps: { values: start, version: 0 } }
  );

describe('useSectionBaseline (#5797)', () => {
  it('starts clean and flags a change', () => {
    const { result, rerender } = setup();
    expect(result.current.hasChanges).toBe(false);
    rerender({ values: { ...start, name: 'b' }, version: 0 });
    expect(result.current.hasChanges).toBe(true);
    expect(result.current.baseline.name).toBe('a');
  });

  it('compares arrays by content, not identity', () => {
    const { result, rerender } = setup();
    rerender({ values: { ...start, keys: ['k1'] }, version: 0 });
    expect(result.current.hasChanges).toBe(false);
    rerender({ values: { ...start, keys: ['k1', 'k2'] }, version: 0 });
    expect(result.current.hasChanges).toBe(true);
  });

  it('commit makes the given values the baseline', () => {
    const { result, rerender } = setup();
    const edited = { ...start, name: 'b', interval: 900 };
    rerender({ values: edited, version: 0 });
    // The save raised the interval; the section commits what was sent.
    act(() => result.current.commit({ ...edited, interval: 14400 }));
    expect(result.current.baseline).toMatchObject({ name: 'b', interval: 14400 });
    rerender({ values: { ...edited, interval: 14400 }, version: 0 });
    expect(result.current.hasChanges).toBe(false);
  });

  it('does not move on re-renders alone', () => {
    const { result, rerender } = setup();
    rerender({ values: { ...start, name: 'b' }, version: 0 });
    rerender({ values: { ...start, name: 'b' }, version: 0 });
    expect(result.current.baseline.name).toBe('a');
    expect(result.current.hasChanges).toBe(true);
  });

  it('a new reseed key takes the current values, except keepOnReseed keys', () => {
    const { result, rerender } = setup();
    rerender({ values: { ...start, name: 'reloaded', lat: 27.5 }, version: 1 });
    expect(result.current.baseline.name).toBe('reloaded');
    // Reload does not refresh this key, so the unsaved 27.5 is still a change.
    expect(result.current.baseline.lat).toBe(0);
    expect(result.current.hasChanges).toBe(true);
  });
});
