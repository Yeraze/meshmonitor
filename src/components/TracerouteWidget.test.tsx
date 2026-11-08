/**
 * @vitest-environment jsdom
 *
 * TracerouteWidget picks RouteFlowMap's colour mode from the trace: leg colours
 * (and a legend) when there is a return leg, SNR colours otherwise.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, transition: null, isDragging: false }),
}));
vi.mock('@dnd-kit/utilities', () => ({ CSS: { Transform: { toString: () => null } } }));
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock((key: string) => key);
});
vi.mock('../contexts/SettingsContext', () => ({ useSettings: () => ({ overlayColors: undefined }) }));
vi.mock('../contexts/SourceContext', () => ({ useSource: () => ({ sourceId: 's', sourceName: 'S' }) }));
vi.mock('./map/RouteFlowMap', () => ({
  RouteFlowMap: (p: { colorMode?: string }) => <div data-testid="flow" data-mode={p.colorMode} />,
}));
const h = (key: string, lon: number) => ({ key, label: key, snr: 1, lat: 1, lon });
const state: { trace: unknown } = { trace: null };
vi.mock('../hooks/useWidgetTrace', () => ({
  useWidgetTrace: () => ({ trace: state.trace, isLoading: false }),
}));

import TracerouteWidget from './TracerouteWidget';

function show() {
  render(
    <TracerouteWidget id="w" targetNodeId="b" currentNodeId="a" nodes={new Map()} onRemove={vi.fn()} onSelectNode={vi.fn()} />,
  );
  fireEvent.click(screen.getByText('dashboard.widget.traceroute.show_map'));
}

describe('TracerouteWidget colour mode', () => {
  it('uses leg colours and a legend with a return leg', () => {
    state.trace = { timestamp: 1, forward: [h('a', 1), h('b', 2)], back: [h('b', 2), h('a', 1)] };
    show();
    expect(screen.getByTestId('flow').getAttribute('data-mode')).toBe('leg');
    expect(document.querySelector('.traceroute-map-legend')).not.toBeNull();
  });

  it('uses SNR colours and no legend without a return leg', () => {
    state.trace = { timestamp: 1, forward: [h('a', 1), h('b', 2)], back: null };
    show();
    expect(screen.getByTestId('flow').getAttribute('data-mode')).toBe('snr');
    expect(document.querySelector('.traceroute-map-legend')).toBeNull();
  });
});
