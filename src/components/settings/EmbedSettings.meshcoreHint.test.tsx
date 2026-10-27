/**
 * @vitest-environment jsdom
 *
 * #5999: the profile's channel list is Meshtastic-only. The form says so
 * under the list when the chosen source is a MeshCore source, or when the
 * profile shows all sources and one of them is MeshCore.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key);
  return createReactI18nextMock(t);
});

vi.mock('../../services/api', () => ({
  default: {
    get: vi.fn(async (url: string) => (url === '/api/embed-profiles' ? [PROFILE] : [])),
    getBaseUrl: vi.fn(async () => ''),
  },
}));

vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn() }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../contexts/SettingsContext', () => ({ useSettings: () => ({ customTilesets: [] }) }));
let SOURCES: Array<{ id: string; name: string; type: string; enabled: boolean }> = [];
vi.mock('../../hooks/useDashboardData', () => ({ useDashboardSources: () => ({ data: SOURCES }) }));
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

const MT = { id: 'mt-1', name: 'Home Radio', type: 'meshtastic_tcp', enabled: true };
const MC = { id: 'mc-1', name: 'Core Radio', type: 'meshcore', enabled: true };
const HINT = 'embed-channels-meshcore-hint';

async function openEditor() {
  const user = userEvent.setup();
  render(<EmbedSettings />);
  await screen.findByText('Front page');
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  await screen.findByRole('dialog');
  return user;
}

describe('EmbedSettings MeshCore channel hint (#5999)', () => {
  it('is absent for All sources when no source is MeshCore', async () => {
    SOURCES = [MT];
    await openEditor();
    expect(screen.queryByTestId(HINT)).toBeNull();
  });

  it('shows for All sources when a MeshCore source exists', async () => {
    SOURCES = [MT, MC];
    await openEditor();
    expect(screen.getByTestId(HINT)).toBeTruthy();
  });

  it('follows the selected source: shown for MeshCore, gone for Meshtastic', async () => {
    SOURCES = [MT, MC];
    const user = await openEditor();
    const select = screen.getByLabelText('Source');
    await user.selectOptions(select, 'mc-1');
    expect(screen.getByTestId(HINT)).toBeTruthy();
    await user.selectOptions(select, 'mt-1');
    expect(screen.queryByTestId(HINT)).toBeNull();
  });
});
