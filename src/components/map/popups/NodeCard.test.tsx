/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NodeCard } from './NodeCard';
import type { NodeCardModel } from './nodeCardModel';

vi.mock('../../../contexts/SettingsContext', () => ({
  // #4880: NodeCardHeader reads the node-list color style; default to monochrome.
  useNodeListStyle: () => 'monochrome',
}));

// Always resolve to the key itself (ignoring any string/object default) so
// assertions are deterministic regardless of English copy.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const baseModel: NodeCardModel = { longName: 'Tower Node', shortName: 'TWR' };

describe('NodeCard', () => {
  it('renders the header and sections directly when tracerouteBody is omitted (no tabs)', () => {
    render(<NodeCard model={baseModel} sections={<div data-testid="sections">SECTIONS</div>} />);
    expect(screen.getByText('Tower Node')).toBeInTheDocument();
    expect(screen.getByText('TWR')).toBeInTheDocument();
    expect(screen.getByTestId('sections')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ℹ️' })).not.toBeInTheDocument();
  });

  it('renders header without a subtitle badge when shortName is absent', () => {
    render(<NodeCard model={{ longName: 'No Short' }} sections={<div />} />);
    expect(screen.getByText('No Short')).toBeInTheDocument();
    expect(screen.queryByText('TWR')).not.toBeInTheDocument();
  });

  it('applies the root className alongside "node-popup"', () => {
    const { container } = render(
      <NodeCard model={baseModel} className="node-popup-overlay" sections={<div />} />,
    );
    expect(container.firstElementChild).toHaveClass('node-popup', 'node-popup-overlay');
  });

  it('renders exactly "node-popup" with no extra class when className is omitted', () => {
    const { container } = render(<NodeCard model={baseModel} sections={<div />} />);
    expect(container.firstElementChild?.className).toBe('node-popup');
  });

  it('renders `actions` OUTSIDE the scrolling body (#5247)', () => {
    // `.node-popup-content` is the scroll box. Anything inside it can be
    // scrolled out of view, and the action row is last — which is how Delete
    // and Purge ended up clipped into unlabelled red slivers. Being a SIBLING
    // of the scroll box is the whole fix, so assert the relationship rather
    // than mere presence.
    const { container } = render(
      <NodeCard
        model={baseModel}
        sections={<div data-testid="info-body">INFO</div>}
        actions={<div data-testid="actions">ACTIONS</div>}
      />,
    );

    const scrollBox = container.querySelector('.node-popup-content')!;
    const actions = screen.getByTestId('actions');
    expect(scrollBox.contains(actions)).toBe(false);
    expect(actions.parentElement).toBe(container.querySelector('.node-popup'));
  });

  it('stays tab-less and action-less when neither is supplied', () => {
    const { container } = render(
      <NodeCard model={baseModel} sections={<div data-testid="info-body">INFO</div>} />,
    );
    expect(container.querySelector('.node-popup-tabs')).toBeNull();
    // No stray footer node when a consumer passes no actions.
    expect(container.querySelector('.node-popup')?.children).toHaveLength(2);
  });

  it('keeps actions visible on the traceroute tab too', () => {
    // The footer is chrome, not tab content — switching tabs must not take the
    // buttons away.
    render(
      <NodeCard
        model={baseModel}
        sections={<div data-testid="info-body">INFO</div>}
        tracerouteBody={<div data-testid="tr-body">TRACEROUTE</div>}
        actions={<div data-testid="actions">ACTIONS</div>}
      />,
    );
    expect(screen.getByTestId('actions')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('node_popup.tab_traceroute'));
    expect(screen.getByTestId('actions')).toBeInTheDocument();
  });

  it('renders a tab bar and switches between sections/tracerouteBody when tracerouteBody is present', () => {
    render(
      <NodeCard
        model={baseModel}
        sections={<div data-testid="info-body">INFO</div>}
        tracerouteBody={<div data-testid="tr-body">TRACEROUTE</div>}
      />,
    );

    // Info tab active by default.
    expect(screen.getByTestId('info-body')).toBeInTheDocument();
    expect(screen.queryByTestId('tr-body')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('node_popup.tab_traceroute'));
    expect(screen.getByTestId('tr-body')).toBeInTheDocument();
    expect(screen.queryByTestId('info-body')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('node_popup.tab_info'));
    expect(screen.getByTestId('info-body')).toBeInTheDocument();
    expect(screen.queryByTestId('tr-body')).not.toBeInTheDocument();
  });
});
