/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LayerToggleButton from './LayerToggleButton';

describe('LayerToggleButton', () => {
  it('renders label and active class when enabled', () => {
    render(
      <LayerToggleButton
        label="Markers"
        enabled={true}
        onToggle={() => {}}
        lookbackHours={24}
        lookbackOptions={[1, 24, 168]}
        onLookbackChange={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: /markers/i });
    expect(btn.className).toMatch(/active/);
  });

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn();
    render(<LayerToggleButton label="X" enabled={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /x/i }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('opens popover with lookback options when chevron clicked', () => {
    render(
      <LayerToggleButton
        label="Trails"
        enabled={true}
        onToggle={() => {}}
        lookbackHours={24}
        lookbackOptions={[1, 24, 168]}
        onLookbackChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText(/configure trails/i));
    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('168h')).toBeInTheDocument();
  });

  it('shows spinner badge when loading', () => {
    render(<LayerToggleButton label="X" enabled={true} onToggle={() => {}} loading={true} />);
    expect(screen.getByTestId('layer-spinner')).toBeInTheDocument();
  });
});
