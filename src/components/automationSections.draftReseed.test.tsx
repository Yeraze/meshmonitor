/**
 * @vitest-environment jsdom
 *
 * AutoResponderSection and GeofenceTriggersSection re-seed their unsaved draft
 * from props only when the saved triggers change CONTENT.
 *
 * Both used to re-seed whenever `triggers` changed identity. AutomationContext
 * happens to pass a stable array today, but any parent that rebuilt the array
 * on each render (same content, new reference) would have wiped an unsaved
 * edit. A real content change (a save elsewhere, a reload with new data) must
 * still replace the draft.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AutoResponderSection from './AutoResponderSection';
import GeofenceTriggersSection from './GeofenceTriggersSection';
import type { AutoResponderTrigger, GeofenceTrigger } from './auto-responder/types';
import type { Channel } from '../types/device';

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
const noop = () => {};

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('AutoResponderSection draft re-seed', () => {
  const responder = (triggers: AutoResponderTrigger[]) => (
    <AutoResponderSection
      enabled={false}
      triggers={triggers}
      channels={channels}
      skipIncompleteNodes={false}
      baseUrl=""
      onEnabledChange={noop}
      onTriggersChange={noop}
      onSkipIncompleteNodesChange={noop}
    />
  );
  const toggle = (c: HTMLElement) => c.querySelector('input[type="checkbox"]') as HTMLInputElement;

  it('keeps an unsaved edit when re-rendered with a new array of identical content', async () => {
    const { container, rerender } = render(responder([]));
    await settle();
    await userEvent.setup().click(toggle(container));
    expect(toggle(container).checked).toBe(true);

    rerender(responder([])); // new reference, same content
    await settle();
    expect(toggle(container).checked).toBe(true);
  });

  it('re-seeds the draft when the saved triggers change content', async () => {
    const { container, rerender } = render(responder([]));
    await settle();
    await userEvent.setup().click(toggle(container));
    expect(toggle(container).checked).toBe(true);

    rerender(responder([{ id: 't1', trigger: 'ping', responseType: 'text', response: 'pong' }]));
    await settle();
    expect(toggle(container).checked).toBe(false);
  });
});

describe('GeofenceTriggersSection draft re-seed', () => {
  const geo = (name: string): GeofenceTrigger => ({
    id: 'geo-1',
    name,
    enabled: true,
    shape: { type: 'circle', center: { lat: 40, lng: -74 }, radiusKm: 5 },
    event: 'entry',
    nodeFilter: { type: 'all' },
    responseType: 'text',
    response: 'hello',
    channel: 0,
  });
  const section = (triggers: GeofenceTrigger[]) => (
    <GeofenceTriggersSection triggers={triggers} channels={channels} nodes={[]} baseUrl="" onTriggersChange={noop} />
  );

  it('keeps an unsaved edit when re-rendered with a new array of identical content', async () => {
    const { rerender } = render(section([geo('Zone A')]));
    await settle();
    await userEvent.setup().click(screen.getByText('Disable'));
    expect(screen.getByText('DISABLED')).toBeTruthy();

    rerender(section([geo('Zone A')])); // new array and objects, same content
    await settle();
    expect(screen.getByText('DISABLED')).toBeTruthy();
  });

  it('re-seeds the draft when the saved triggers change content', async () => {
    const { rerender } = render(section([geo('Zone A')]));
    await settle();
    await userEvent.setup().click(screen.getByText('Disable'));
    expect(screen.getByText('DISABLED')).toBeTruthy();

    rerender(section([geo('Zone B')]));
    await settle();
    expect(screen.getByText('Zone B')).toBeTruthy();
    expect(screen.getByText('ENABLED')).toBeTruthy();
  });
});
