/**
 * @vitest-environment jsdom
 *
 * #5291 part 1: with the node list collapsed, its expand arrow stayed on top of
 * the open map-controls sheet and overlapped the "Map controls" heading.
 *
 * The arrow cannot be beaten by z-index — it lives outside `.map-container`,
 * a stacking context at `z-index: 1`, so the sheet's 1001 is trapped below it.
 * `MapSidebar` therefore marks the root element while it is open and
 * `nodes.css` hides the arrow from that shared ancestor.
 *
 * Both halves are asserted: the marker (render test) and the rule that wins at
 * each concrete viewport (cascade resolver, since jsdom has no media queries).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MapSidebar, MAP_SHEET_OPEN_CLASS } from './MapSidebar';
import {
  createResolver,
  PORTRAIT_PHONE,
  LANDSCAPE_SMALL_PHONE,
  DESKTOP,
} from '../../styles/cssCascadeResolver';

let mockIsMobile = false;
vi.mock('../../hooks/useIsMobileViewport', () => ({
  useIsMobileViewport: () => mockIsMobile,
  useIsMobileLayoutViewport: () => mockIsMobile,
}));

const ARROW = ':root.mm-map-sheet-open .nodes-sidebar.collapsed .sidebar-header';
const resolveDecl = createResolver(readFileSync(resolve('src/styles/nodes.css'), 'utf-8'));

describe('map sheet marks the root element (#5291)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockIsMobile = false;
    document.documentElement.className = '';
  });

  it('marks the root while open and clears it on collapse', () => {
    render(<MapSidebar title="Map controls"><div>Legend</div></MapSidebar>);
    expect(document.documentElement.classList.contains(MAP_SHEET_OPEN_CLASS)).toBe(true);

    fireEvent.click(screen.getByLabelText('Hide Map controls'));
    expect(document.documentElement.classList.contains(MAP_SHEET_OPEN_CLASS)).toBe(false);
  });

  it('does not mark the root when it starts collapsed', () => {
    mockIsMobile = true; // Mobile defaults to collapsed (#4909).
    render(<MapSidebar title="Map controls"><div>Legend</div></MapSidebar>);
    expect(document.documentElement.classList.contains(MAP_SHEET_OPEN_CLASS)).toBe(false);
  });

  it('clears the marker when the panel unmounts while open', () => {
    const { unmount } = render(<MapSidebar title="Map controls"><div>Legend</div></MapSidebar>);
    expect(document.documentElement.classList.contains(MAP_SHEET_OPEN_CLASS)).toBe(true);
    unmount();
    expect(document.documentElement.classList.contains(MAP_SHEET_OPEN_CLASS)).toBe(false);
  });

  it('keeps the marker while a second panel is still open', () => {
    // The Dashboard renders its own MapSidebar, so two can be mounted at once
    // and the first to close must not clear the marker for the other.
    const first = render(<MapSidebar storageKey="a" title="Map controls"><div>A</div></MapSidebar>);
    render(<MapSidebar storageKey="b" title="Map controls"><div>B</div></MapSidebar>);
    first.unmount();
    expect(document.documentElement.classList.contains(MAP_SHEET_OPEN_CLASS)).toBe(true);
  });
});

describe('the arrow is hidden only where the sheet covers it (#5291)', () => {
  it('is hidden on a portrait phone, where the sheet is full-screen', () => {
    expect(resolveDecl(ARROW, 'display', PORTRAIT_PHONE)).toBe('none');
  });

  it('stays visible in short landscape, where the sheet is a right-edge half-panel', () => {
    // 667x375 matches BOTH the width query and the landscape one, so this also
    // pins the source order of the two blocks.
    expect(resolveDecl(ARROW, 'display', LANDSCAPE_SMALL_PHONE)).toBe('block');
  });

  it('is untouched on desktop', () => {
    expect(resolveDecl(ARROW, 'display', DESKTOP)).toBeNull();
  });
});
