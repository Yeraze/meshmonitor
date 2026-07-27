/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../../MapAnalysis/MapAnalysisContext';
import type { AtakContact } from '../../../types/atakContact';

// Stub leaflet primitives so the tests don't need a real DOM map context.
// `data-icon-html` surfaces the divIcon's raw html string so tests can assert
// on team color / stale opacity without depending on markerIcons internals.
vi.mock('react-leaflet', () => ({
  Marker: ({ children, position, icon, zIndexOffset }: any) => (
    <div
      data-testid="atak-marker"
      data-pos={JSON.stringify(position)}
      data-icon-html={icon?.html}
      data-z-index-offset={zIndexOffset}
    >
      {children}
    </div>
  ),
  Popup: ({ children }: any) => <div data-testid="atak-popup">{children}</div>,
}));

vi.mock('leaflet', () => ({
  default: {
    divIcon: vi.fn((opts: any) => opts),
  },
}));

vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({
    data: [{ id: 'src-1', name: 'Source One' }],
  }),
}));

function makeContact(overrides: Partial<AtakContact> = {}): AtakContact {
  return {
    uid: 'EUD-1',
    sourceId: 'src-1',
    nodeNum: 0x12345678,
    callsign: 'ALPHA-1',
    deviceCallsign: 'EUD-1',
    team: 5, // Red
    role: 2, // Team Lead
    battery: 87,
    latitude: 30.1,
    longitude: -90.2,
    altitude: 42,
    speed: 3,
    course: 180,
    lastSeen: Date.now(),
    createdAt: Date.now(),
    stale: false,
    ...overrides,
  };
}

let contactsFixture: AtakContact[] = [];

vi.mock('../../../hooks/useAtakContacts', () => ({
  useAtakContacts: () => ({
    contacts: contactsFixture,
    isLoading: false,
    error: null,
  }),
}));

import { AtakContactsLayer } from './AtakContactsLayer';
import AtakContactsMapAnalysisLayer from './AtakContactsLayer';

beforeEach(() => {
  contactsFixture = [];
  localStorage.setItem(
    'mapAnalysis.config.v1',
    JSON.stringify({
      version: 1,
      layers: {
        markers: { enabled: false, lookbackHours: null },
        traceroutes: { enabled: false, lookbackHours: 24 },
        neighbors: { enabled: false, lookbackHours: 24 },
        heatmap: { enabled: false, lookbackHours: 24 },
        trails: { enabled: false, lookbackHours: 24 },
        hopShading: { enabled: false, lookbackHours: null },
        snrOverlay: { enabled: false, lookbackHours: 24 },
        waypoints: { enabled: false, lookbackHours: null },
        atakContacts: { enabled: true, lookbackHours: null },
      },
      sources: [],
      timeSlider: { enabled: false },
      inspectorOpen: true,
    }),
  );
});

describe('AtakContactsLayer', () => {
  it('renders one marker per positioned contact with the expected coordinates', () => {
    contactsFixture = [makeContact()];
    const { getAllByTestId } = render(
      <AtakContactsLayer source={{ id: 'src-1', name: 'Source One' }} />,
    );
    const markers = getAllByTestId('atak-marker');
    expect(markers).toHaveLength(1);
    expect(markers[0].getAttribute('data-pos')).toBe('[30.1,-90.2]');
  });

  it('skips contacts with no lat/lon (bogus/Null-Island position)', () => {
    contactsFixture = [
      makeContact({ uid: 'EUD-1', latitude: null, longitude: null }),
      makeContact({ uid: 'EUD-2', callsign: 'BRAVO-2', latitude: 31, longitude: -91 }),
    ];
    const { queryAllByTestId } = render(
      <AtakContactsLayer source={{ id: 'src-1', name: 'Source One' }} />,
    );
    const markers = queryAllByTestId('atak-marker');
    expect(markers).toHaveLength(1);
    expect(markers[0].getAttribute('data-pos')).toBe('[31,-91]');
  });

  it('boosts markers above co-located node icons via zIndexOffset (#3691)', () => {
    contactsFixture = [makeContact()];
    const { getAllByTestId } = render(
      <AtakContactsLayer source={{ id: 'src-1', name: 'Source One' }} />,
    );
    expect(getAllByTestId('atak-marker')[0].getAttribute('data-z-index-offset')).toBe('1000');
  });

  it('renders nothing when there are no contacts', () => {
    contactsFixture = [];
    const { container } = render(
      <AtakContactsLayer source={{ id: 'src-1', name: 'Source One' }} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('applies the team color to the marker icon', () => {
    contactsFixture = [makeContact({ team: 5 })]; // Red -> #ff0000
    const { getAllByTestId } = render(
      <AtakContactsLayer source={{ id: 'src-1', name: 'Source One' }} />,
    );
    const html = getAllByTestId('atak-marker')[0].getAttribute('data-icon-html');
    expect(html).toContain('#ff0000');
  });

  it('falls back to the default Cyan color for an unspecified/unknown team', () => {
    contactsFixture = [makeContact({ team: null })];
    const { getAllByTestId } = render(
      <AtakContactsLayer source={{ id: 'src-1', name: 'Source One' }} />,
    );
    const html = getAllByTestId('atak-marker')[0].getAttribute('data-icon-html');
    expect(html).toContain('#00ffff');
  });

  it('dims the marker icon (reduced opacity) when the contact is stale', () => {
    contactsFixture = [makeContact({ stale: true })];
    const { getAllByTestId } = render(
      <AtakContactsLayer source={{ id: 'src-1', name: 'Source One' }} />,
    );
    const html = getAllByTestId('atak-marker')[0].getAttribute('data-icon-html');
    expect(html).toContain('opacity: 0.5');
  });

  it('keeps full opacity when the contact is fresh', () => {
    contactsFixture = [makeContact({ stale: false })];
    const { getAllByTestId } = render(
      <AtakContactsLayer source={{ id: 'src-1', name: 'Source One' }} />,
    );
    const html = getAllByTestId('atak-marker')[0].getAttribute('data-icon-html');
    expect(html).toContain('opacity: 1');
  });

  it('renders popup fields: callsign, team, role, battery, course, speed, altitude, last-seen', () => {
    contactsFixture = [makeContact()];
    const { getByTestId } = render(
      <AtakContactsLayer source={{ id: 'src-1', name: 'Source One' }} />,
    );
    const popup = getByTestId('atak-popup');
    expect(popup.textContent).toContain('ALPHA-1');
    expect(popup.textContent).toContain('Red');
    expect(popup.textContent).toContain('Team Lead');
    expect(popup.textContent).toContain('87%');
    expect(popup.textContent).toContain('180°');
    expect(popup.textContent).toContain('3 m/s');
    expect(popup.textContent).toContain('42 m HAE');
  });

  it('shows a STALE badge only when the contact is stale', () => {
    contactsFixture = [makeContact({ stale: true })];
    const { getByTestId, rerender } = render(
      <AtakContactsLayer source={{ id: 'src-1', name: 'Source One' }} />,
    );
    expect(getByTestId('atak-popup').textContent).toContain('STALE');

    contactsFixture = [makeContact({ stale: false })];
    rerender(<AtakContactsLayer source={{ id: 'src-1', name: 'Source One' }} />);
    expect(getByTestId('atak-popup').textContent).not.toContain('STALE');
  });

  it('omits optional popup fields (battery/course/speed/altitude) when absent', () => {
    contactsFixture = [
      makeContact({ battery: null, course: null, speed: null, altitude: null }),
    ];
    const { getByTestId } = render(
      <AtakContactsLayer source={{ id: 'src-1', name: 'Source One' }} />,
    );
    const popup = getByTestId('atak-popup');
    expect(popup.textContent).not.toContain('m HAE');
    expect(popup.textContent).not.toContain('m/s');
  });
});

describe('AtakContactsLayer — MapAnalysis default export', () => {
  it('renders markers for the config-selected sources', () => {
    contactsFixture = [makeContact()];
    const qc = new QueryClient();
    const { getAllByTestId } = render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <AtakContactsMapAnalysisLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(getAllByTestId('atak-marker')).toHaveLength(1);
  });
});
