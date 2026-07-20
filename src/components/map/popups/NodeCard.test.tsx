/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NodeCard } from './NodeCard';
import type { NodeCardModel } from './nodeCardModel';

vi.mock('../../../contexts/SettingsContext', () => ({
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
