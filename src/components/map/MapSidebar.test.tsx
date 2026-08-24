/**
 * @vitest-environment jsdom
 *
 * #4909: the unified map controls sidebar shell — collapse/expand + persistence.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MapSidebar } from './MapSidebar';

describe('MapSidebar (#4909)', () => {
  beforeEach(() => localStorage.clear());

  it('renders its children stacked in the panel by default', () => {
    render(<MapSidebar><div>Legend</div><div>Features</div></MapSidebar>);
    expect(screen.getByText('Legend')).toBeTruthy();
    expect(screen.getByText('Features')).toBeTruthy();
  });

  it('collapses to a toggle button and restores, persisting the state', () => {
    const { unmount } = render(
      <MapSidebar storageKey="mm-test-sidebar"><div>Legend</div></MapSidebar>,
    );
    // Collapse via the header close button.
    fireEvent.click(screen.getByLabelText(/Hide/));
    expect(screen.queryByText('Legend')).toBeNull();
    expect(localStorage.getItem('mm-test-sidebar')).toBe('true');

    // A fresh mount reads the persisted collapsed state.
    unmount();
    render(<MapSidebar storageKey="mm-test-sidebar"><div>Legend</div></MapSidebar>);
    expect(screen.queryByText('Legend')).toBeNull();
    // Expand again.
    fireEvent.click(screen.getByLabelText(/Show/));
    expect(screen.getByText('Legend')).toBeTruthy();
    expect(localStorage.getItem('mm-test-sidebar')).toBe('false');
  });
});
