/**
 * @vitest-environment jsdom
 *
 * activeTab<->route adapter tests (#3962 Phase 5.4 PR1).
 *
 * UIContext.activeTab used to be its own piece of state synced to
 * window.location.hash; it is now derived from the router location (last
 * path segment) and setActiveTab navigates instead of setting state. These
 * tests pin: (1) activeTab derivation for every VALID_TABS path segment plus
 * the 'nodes' default, and (2) setActiveTab(tab) round-tripping through a
 * real MemoryRouter navigation back into a re-derived activeTab, for every
 * VALID_TABS value.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { UIProvider, useUI } from './UIContext';
import { VALID_TABS, type TabType } from '../types/ui';

function TabProbe() {
  const { activeTab, setActiveTab } = useUI();
  return (
    <div>
      <span data-testid="active-tab">{activeTab}</span>
      {VALID_TABS.map(tab => (
        <button key={tab} data-testid={`go-${tab}`} onClick={() => setActiveTab(tab)}>
          {tab}
        </button>
      ))}
    </div>
  );
}

function renderSourceView(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="source/:sourceId/*"
          element={
            <UIProvider>
              <TabProbe />
            </UIProvider>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('UIContext activeTab<->route adapter', () => {
  it.each(VALID_TABS)('derives activeTab %s from the matching path segment', (tab: TabType) => {
    renderSourceView(`/source/abc123/${tab}`);
    expect(screen.getByTestId('active-tab').textContent).toBe(tab);
  });

  it('defaults activeTab to nodes on a bare source path', () => {
    renderSourceView('/source/abc123');
    expect(screen.getByTestId('active-tab').textContent).toBe('nodes');
  });

  it('defaults activeTab to nodes on a bare source path with trailing slash', () => {
    renderSourceView('/source/abc123/');
    expect(screen.getByTestId('active-tab').textContent).toBe('nodes');
  });

  it('defaults activeTab to nodes for an unrecognized path segment', () => {
    renderSourceView('/source/abc123/not-a-real-tab');
    expect(screen.getByTestId('active-tab').textContent).toBe('nodes');
  });

  it('does not resolve the removed "themes" orphan as a tab', () => {
    renderSourceView('/source/abc123/themes');
    expect(screen.getByTestId('active-tab').textContent).toBe('nodes');
  });

  it.each(VALID_TABS)('setActiveTab(%s) navigates and re-derives activeTab to match', (tab: TabType) => {
    renderSourceView('/source/abc123/nodes');
    fireEvent.click(screen.getByTestId(`go-${tab}`));
    expect(screen.getByTestId('active-tab').textContent).toBe(tab);
  });

  it('setActiveTab is a no-op with no sourceId param in scope (e.g. GlobalSettingsPage usage)', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <UIProvider>
          <TabProbe />
        </UIProvider>
      </MemoryRouter>
    );
    // No :sourceId route param matched, so setActiveTab must not throw and
    // must not navigate anywhere that would change activeTab derivation.
    expect(() => fireEvent.click(screen.getByTestId('go-messages'))).not.toThrow();
  });
});
