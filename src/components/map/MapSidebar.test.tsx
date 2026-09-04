/**
 * @vitest-environment jsdom
 *
 * #4909: the unified map controls sidebar shell — collapse/expand + persistence.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MapSidebar } from './MapSidebar';

// Control the viewport-size hook so mobile-vs-desktop defaults are testable
// without a real matchMedia (jsdom lacks it). `useIsMobileLayoutViewport` is
// the shell's definition — narrow OR short-and-landscape — so "mobile" here
// covers a rotated phone too (#5060).
let mockIsMobile = false;
vi.mock('../../hooks/useIsMobileViewport', () => ({
  useIsMobileViewport: () => mockIsMobile,
  useIsMobileLayoutViewport: () => mockIsMobile,
}));

describe('MapSidebar (#4909)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockIsMobile = false;
  });

  it('renders its children stacked in the panel by default (desktop)', () => {
    render(<MapSidebar><div>Legend</div><div>Features</div></MapSidebar>);
    expect(screen.getByText('Legend')).toBeTruthy();
    expect(screen.getByText('Features')).toBeTruthy();
  });

  it('starts collapsed on mobile with no saved preference (#4909)', () => {
    mockIsMobile = true;
    render(<MapSidebar storageKey="mm-test-mobile"><div>Legend</div></MapSidebar>);
    expect(screen.queryByText('Legend')).toBeNull();
    expect(screen.getByTitle(/Show/)).toBeTruthy();
  });

  it('honors a saved expanded preference even on mobile', () => {
    mockIsMobile = true;
    localStorage.setItem('mm-test-mobile2', 'false');
    render(<MapSidebar storageKey="mm-test-mobile2"><div>Legend</div></MapSidebar>);
    expect(screen.getByText('Legend')).toBeTruthy();
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
