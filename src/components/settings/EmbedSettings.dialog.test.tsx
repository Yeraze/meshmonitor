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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

async function renderLoaded() {
  render(<EmbedSettings />);
  await screen.findByText('Front page');
}

describe('EmbedSettings dialogs', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
  });

  it('create/edit dialog is a labelled modal dialog with a named close button', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '+ New Embed Profile' }));

    const dialog = await screen.findByRole('dialog', { name: 'Create Embed Profile' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('Escape closes the create/edit dialog', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '+ New Embed Profile' }));
    await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the close button closes the create/edit dialog', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByRole('dialog', { name: 'Edit Embed Profile' });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clicking inside the dialog does not close it; clicking the overlay does', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '+ New Embed Profile' }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(dialog);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(dialog.parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('embed code dialog also closes on Escape and labels its close button', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Embed Code' }));

    await screen.findByRole('dialog', { name: 'Embed Code' });
    // The dialog's own footer button is also "Close"; the header icon button
    // must carry the same accessible name rather than none.
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
