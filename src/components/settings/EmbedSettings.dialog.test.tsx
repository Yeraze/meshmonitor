/**
 * @vitest-environment jsdom
 *
 * Embed settings modals follow the dialog contract (useDialogA11y): Escape
 * closes, focus moves into the dialog, and the close button has a name.
 * Before this, the Create Embed Profile modal ignored Escape and its close
 * button was an unlabelled "×".
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const PROFILE = {
  id: 'p1',
  name: 'Front page',
  enabled: true,
  channels: [0],
  tileset: 'osm',
  defaultLat: 1,
  defaultLng: 2,
  defaultZoom: 10,
  showTooltips: true,
  showPopups: true,
  showLegend: true,
  showPaths: false,
  showNeighborInfo: false,
  showTraceroutes: false,
  showMqttNodes: true,
  pollIntervalSeconds: 30,
  allowedOrigins: [],
  sourceId: null,
  createdAt: 0,
  updatedAt: 0,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

vi.mock('../../services/api', () => ({
  default: {
    get: vi.fn(async (url: string) => (url === '/api/embed-profiles' ? [PROFILE] : [])),
    getBaseUrl: vi.fn(async () => ''),
  },
}));

vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn() }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../contexts/SettingsContext', () => ({ useSettings: () => ({ customTilesets: [] }) }));
vi.mock('../../hooks/useDashboardData', () => ({ useDashboardSources: () => ({ data: [] }) }));
vi.mock('../../config/tilesets', () => ({ getAllTilesets: () => [{ id: 'osm', name: 'OSM', isVector: false }] }));
vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children }: { children?: React.ReactNode }) => <div data-testid="base-map">{children}</div>,
}));
vi.mock('react-leaflet', () => ({
  useMapEvents: () => null,
  useMap: () => ({ setView: vi.fn(), getZoom: () => 10 }),
  Marker: () => null,
}));

import EmbedSettings from './EmbedSettings';

type User = ReturnType<typeof userEvent.setup>;

async function renderLoaded(): Promise<User> {
  const user = userEvent.setup();
  render(<EmbedSettings />);
  await screen.findByText('Front page');
  return user;
}

/**
 * Open a dialog and wait until it is ready, not just in the DOM.
 *
 * "+ New Embed Profile" runs the async `openCreate`: it awaits
 * `/api/nodes/active` before `setEditingId('new')`, so the dialog commits
 * outside `act()`. `findByRole` resolves as soon as the node appears, but
 * React runs `useDialogA11y`'s passive effects (focus the dialog, attach the
 * document Escape listener) in a later task. An Escape sent in that gap finds
 * no listener, so the dialog never closes. Under CI load the gap is wide
 * enough to hit (run 36496362067). Both effects flush in the same pass, so
 * once focus has moved the Escape listener is attached too.
 */
async function openDialog(user: User, trigger: string, name?: string): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: trigger }));
  const dialog = await screen.findByRole('dialog', name ? { name } : {});
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  return dialog;
}

async function expectClosed() {
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

describe('EmbedSettings dialogs', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
  });

  it('create/edit dialog is a labelled modal dialog with a named close button', async () => {
    const user = await renderLoaded();
    // openDialog also asserts focus moved into the dialog.
    const dialog = await openDialog(user, '+ New Embed Profile', 'Create Embed Profile');

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('Escape closes the create/edit dialog', async () => {
    const user = await renderLoaded();
    await openDialog(user, '+ New Embed Profile');

    await user.keyboard('{Escape}');

    await expectClosed();
  });

  it('the close button closes the create/edit dialog', async () => {
    const user = await renderLoaded();
    await openDialog(user, 'Edit', 'Edit Embed Profile');

    await user.click(screen.getByRole('button', { name: 'Close' }));

    await expectClosed();
  });

  it('clicking inside the dialog does not close it; clicking the overlay does', async () => {
    const user = await renderLoaded();
    const dialog = await openDialog(user, '+ New Embed Profile');

    await user.click(dialog);
    expect(screen.getByRole('dialog')).toBeTruthy();

    await user.click(dialog.parentElement!);
    await expectClosed();
  });

  it('embed code dialog also closes on Escape and labels its close button', async () => {
    const user = await renderLoaded();
    await openDialog(user, 'Embed Code', 'Embed Code');

    // The dialog's own footer button is also "Close"; the header icon button
    // must carry the same accessible name rather than none.
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2);

    await user.keyboard('{Escape}');
    await expectClosed();
  });
});
