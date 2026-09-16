/**
 * @vitest-environment jsdom
 *
 * The global i18n mock (src/test/setup.ts) renders translation keys, so
 * buttons are found by key rather than by their English default text.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SolarOverridesPanel } from './SolarOverridesPanel';

const analyzed = [
  { node_num: 1, node_name: 'Alpha' },
  { node_num: 2, node_name: 'Bravo' },
];

describe('SolarOverridesPanel (#3195)', () => {
  it('renders nothing for a read-only viewer with no overrides', () => {
    const { container } = render(
      <SolarOverridesPanel overrides={[]} analyzedNodes={analyzed} canWrite={false} busy={false} error={null} onSet={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('lists overrides to a read-only viewer without offering changes', () => {
    render(
      <SolarOverridesPanel
        overrides={[{ node_num: 1, node_name: 'Alpha', is_solar: false }]}
        analyzedNodes={analyzed}
        canWrite={false}
        busy={false}
        error={null}
        onSet={vi.fn()}
      />,
    );
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('offers only nodes that are not already classified', () => {
    render(
      <SolarOverridesPanel
        overrides={[{ node_num: 1, node_name: 'Alpha', is_solar: true }]}
        analyzedNodes={analyzed}
        canWrite
        busy={false}
        error={null}
        onSet={vi.fn()}
      />,
    );
    const options = Array.from((screen.getByRole('combobox') as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['', '2']);
  });

  it('marks the picked node as solar', () => {
    const onSet = vi.fn();
    render(<SolarOverridesPanel overrides={[]} analyzedNodes={analyzed} canWrite busy={false} error={null} onSet={onSet} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /override_mark_solar/ }));
    expect(onSet).toHaveBeenCalledWith(2, true);
  });

  it('clears an override back to auto-detection', () => {
    const onSet = vi.fn();
    render(
      <SolarOverridesPanel
        overrides={[{ node_num: 1, node_name: 'Alpha', is_solar: false }]}
        analyzedNodes={analyzed}
        canWrite
        busy={false}
        error={null}
        onSet={onSet}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /override_clear/ }));
    expect(onSet).toHaveBeenCalledWith(1, null);
  });
});
