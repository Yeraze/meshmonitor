/**
 * @vitest-environment jsdom
 *
 * Guard: unsaved Automation drafts survive a viewport change across the
 * phone/desktop breakpoint.
 *
 * The report was that going from 390px to 1280px reset the Geofence event
 * select to "Entry" and turned the Auto Responder toggle back off. Tracing it
 * in the live app showed the page does NOT swap layout trees: a pure width
 * change keeps every section mounted and its draft intact. The reset came from
 * Chrome DevTools itself, which reloads the page when device emulation toggles
 * the `mobile`/`touch` flags (390x844,mobile,touch -> 1280x900). Nothing in the
 * Automation tree keys or branches on the viewport.
 *
 * This test pins that down, so a future `useIsMobile ? <A/> : <B/>` split or a
 * viewport-derived `key` cannot start throwing drafts away unnoticed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GeofenceTriggersSection from './GeofenceTriggersSection';
import AutoResponderSection from './AutoResponderSection';
import { Channel } from '../types/device';

vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn() }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useSourceQuery', () => ({ useSourceQuery: () => '' }));
vi.mock('../hooks/useSaveBar', () => ({ useSaveBar: () => undefined }));
vi.mock('../services/api', () => ({ default: { get: vi.fn().mockResolvedValue({ scripts: [] }) } }));
vi.mock('./GeofenceMapEditor', () => ({ default: () => <div data-testid="geofence-map-editor" /> }));
vi.mock('./GeofenceNodeSelector', () => ({ default: () => <div data-testid="geofence-node-selector" /> }));

const channels: Channel[] = [
  { id: 0, name: 'Primary', psk: 'test', uplinkEnabled: true, downlinkEnabled: true, createdAt: 0, updatedAt: 0 },
];

/** A matchMedia stub whose answers flip with the simulated viewport width. */
type Listener = (e: { matches: boolean; media: string }) => void;
let width = 390;
const lists: Array<{ query: string; listeners: Set<Listener> }> = [];
function matchesFor(query: string): boolean {
  const max = query.match(/max-width:\s*(\d+)px/);
  const min = query.match(/min-width:\s*(\d+)px/);
  if (max && width > Number(max[1])) return false;
  if (min && width < Number(min[1])) return false;
  return Boolean(max || min);
}
function installMatchMedia(): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const entry = { query, listeners: new Set<Listener>() };
    lists.push(entry);
    return {
      get matches() { return matchesFor(query); },
      media: query,
      onchange: null,
      addEventListener: (_: string, l: Listener) => entry.listeners.add(l),
      removeEventListener: (_: string, l: Listener) => entry.listeners.delete(l),
      addListener: (l: Listener) => entry.listeners.add(l),
      removeListener: (l: Listener) => entry.listeners.delete(l),
      dispatchEvent: () => true,
    };
  }) as unknown as typeof window.matchMedia;
}
function setViewport(next: number): void {
  width = next;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: next });
  for (const { query, listeners } of lists) {
    for (const l of listeners) l({ matches: matchesFor(query), media: query });
  }
  window.dispatchEvent(new Event('resize'));
}

const originalMatchMedia = window.matchMedia;
const originalInnerWidth = window.innerWidth;

beforeEach(() => {
  lists.length = 0;
  installMatchMedia();
  setViewport(390);
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
});

// Stable references, as AutomationContext hands them down: the sections
// re-seed their drafts when these props change identity, so inline `[]`
// literals would model a context reload, not a resize.
const noResponderTriggers: never[] = [];
const noGeofenceTriggers: never[] = [];
const noNodes: never[] = [];
const noop = () => {};

function Page() {
  return (
    <>
      <div id="auto-responder">
        <AutoResponderSection
          enabled={false}
          triggers={noResponderTriggers}
          channels={channels}
          skipIncompleteNodes={false}
          baseUrl=""
          onEnabledChange={noop}
          onTriggersChange={noop}
          onSkipIncompleteNodesChange={noop}
        />
      </div>
      <div id="geofence-triggers">
        <GeofenceTriggersSection
          triggers={noGeofenceTriggers}
          channels={channels}
          nodes={noNodes}
          baseUrl=""
          onTriggersChange={noop}
        />
      </div>
    </>
  );
}

describe('Automation drafts across the phone/desktop breakpoint', () => {
  it('keeps the Geofence event and Auto Responder toggle when the viewport widens', async () => {
    const { container, rerender } = render(<Page />);
    // Let the mount-time script-list fetches settle, as they would before a
    // user starts editing.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const responderToggle = container.querySelector('#auto-responder input[type="checkbox"]') as HTMLInputElement;
    const eventSelect = screen.getByDisplayValue('automation.geofence_triggers.event_entry') as HTMLSelectElement;
    expect(responderToggle.checked).toBe(false);

    const user = userEvent.setup();
    await user.click(responderToggle);
    expect(responderToggle.checked, 'toggle after click').toBe(true);
    await user.selectOptions(eventSelect, 'exit');
    expect(responderToggle.checked, 'toggle after select change').toBe(true);
    expect(eventSelect.value, 'event after change').toBe('exit');

    act(() => setViewport(1280));
    rerender(<Page />);

    // Same DOM nodes: nothing remounted.
    expect(container.querySelector('#auto-responder input[type="checkbox"]'), 'toggle not remounted').toBe(responderToggle);
    expect(screen.getByDisplayValue('automation.geofence_triggers.event_exit'), 'select not remounted').toBe(eventSelect);
    expect(responderToggle.checked, 'toggle at 1280px').toBe(true);
    expect(eventSelect.value, 'event at 1280px').toBe('exit');

    act(() => setViewport(390));
    rerender(<Page />);
    expect(responderToggle.checked, 'toggle back at 390px').toBe(true);
    expect(eventSelect.value, 'event back at 390px').toBe('exit');
  });
});
