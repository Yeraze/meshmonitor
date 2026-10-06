/**
 * Traceroute weak-link filters on NumberInput (#5649).
 *
 * These fields apply on change and have no Save. The rule for that family: an
 * optional bound, once cleared, means "no bound" exactly as before, and blank
 * or half-typed text never reaches the layer options as NaN (or as a silent 1).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TracerouteControls from './TracerouteControls';
import type { TracerouteLayerOptions } from '../../hooks/useMapAnalysisConfig';

const patches: Array<Partial<TracerouteLayerOptions>> = [];
let ctx: { config: unknown; setLayerOptions: (layer: string, patch: Record<string, unknown>) => void };

vi.mock('./MapAnalysisContext', () => ({
  useMapAnalysisCtx: () => ctx,
}));

/** Holds the layer options the way the real provider does. */
function Harness({ initial }: { initial: Partial<TracerouteLayerOptions> }) {
  const [options, setOptions] = useState<Partial<TracerouteLayerOptions>>(initial);
  ctx = {
    config: { layers: { traceroutes: { options } } },
    setLayerOptions: (_layer, patch) => {
      patches.push(patch as Partial<TracerouteLayerOptions>);
      setOptions(prev => ({ ...prev, ...patch }));
    },
  };
  return <TracerouteControls />;
}

async function open(initial: Partial<TracerouteLayerOptions>) {
  const user = userEvent.setup();
  render(<Harness initial={initial} />);
  await user.click(screen.getByRole('button', { name: /Traceroute filters/ }));
  return user;
}

const minSnr = () => screen.getByLabelText('Minimum SNR in dB') as HTMLInputElement;
const minOccurrences = () => screen.getByLabelText('Minimum occurrences') as HTMLInputElement;

describe('TracerouteControls number fields', () => {
  beforeEach(() => {
    patches.length = 0;
  });

  it('clearing the optional SNR bound applies "off" (null), never NaN', async () => {
    const user = await open({ minSnr: -5 });
    expect(minSnr().value).toBe('-5');

    await user.clear(minSnr());
    expect(minSnr().value).toBe('');
    // Optional: blank is legal, so no invalid state.
    expect(minSnr()).not.toHaveAttribute('aria-invalid');
    expect(patches.at(-1)).toEqual({ minSnr: null });

    await user.type(minSnr(), '-7.5');
    expect(patches.at(-1)).toEqual({ minSnr: -7.5 });

    for (const patch of patches) {
      expect(patch.minSnr === null || Number.isFinite(patch.minSnr)).toBe(true);
    }
  });

  it('a blank required count is flagged and not applied (it used to snap to 1)', async () => {
    const user = await open({ minOccurrences: 3 });

    await user.clear(minOccurrences());
    expect(minOccurrences().value).toBe('');
    expect(minOccurrences()).toHaveAttribute('aria-invalid', 'true');
    expect(patches).toEqual([]);

    await user.type(minOccurrences(), '12');
    expect(minOccurrences()).not.toHaveAttribute('aria-invalid');
    expect(patches.map(p => p.minOccurrences)).toEqual([1, 12]);
  });

  it('a count below 1 or a fraction is flagged and not applied', async () => {
    const user = await open({ minOccurrences: 3 });

    await user.clear(minOccurrences());
    await user.type(minOccurrences(), '0');
    expect(minOccurrences()).toHaveAttribute('aria-invalid', 'true');

    await user.clear(minOccurrences());
    await user.type(minOccurrences(), '2.5');
    expect(minOccurrences()).toHaveAttribute('aria-invalid', 'true');

    // Only the whole number typed on the way to "2.5" was applied.
    expect(patches.map(p => p.minOccurrences)).toEqual([2]);
  });
});
