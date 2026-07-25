/**
 * @vitest-environment jsdom
 *
 * Issue #4326 — the map's "Show Traceroute" toggle silently changes what
 * clicking a node does, and its only evidence lived inside a collapsible,
 * draggable Features panel. MapModeIndicator is the always-visible banner
 * that makes the active mode (and the way out of it) obvious.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MapModeIndicator } from './MapModeIndicator';

describe('MapModeIndicator', () => {
  const baseProps = {
    icon: 'route' as const,
    label: 'Traceroute mode',
    hint: 'Clicking a node with a stored route shows its path instead of its info popup',
  };

  it('announces the active mode and how it changes clicking a node', () => {
    render(<MapModeIndicator {...baseProps} />);

    const indicator = screen.getByTestId('map-mode-indicator');
    expect(indicator).toHaveAttribute('role', 'status');
    expect(screen.getByText('Traceroute mode')).toBeInTheDocument();
    // The explanation is both visible text and a title, so it survives the
    // narrow-screen rule that hides the inline hint.
    expect(screen.getByText(baseProps.hint)).toBeInTheDocument();
    expect(indicator).toHaveAttribute('title', baseProps.hint);
  });

  it('renders a dismiss control that turns the mode off', async () => {
    const onDisable = vi.fn();
    render(
      <MapModeIndicator {...baseProps} onDisable={onDisable} disableLabel="Turn off Show Traceroute" />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Turn off Show Traceroute' }));
    expect(onDisable).toHaveBeenCalledTimes(1);
  });

  it('omits the dismiss control when no onDisable handler is supplied', () => {
    render(<MapModeIndicator {...baseProps} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
