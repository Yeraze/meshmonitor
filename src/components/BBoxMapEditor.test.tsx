// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import BBoxMapEditor from './BBoxMapEditor';

// BaseMap is mocked as a passthrough so this test stays isolated from
// BaseMap internals (and never pulls in maplibre) — mirrors
// DefaultMapCenterPicker.test.tsx's mock pattern.
vi.mock('./map/BaseMap', () => ({
  BaseMap: ({ children }: { children?: ReactNode }) => (
    <div data-testid="minimap">{children}</div>
  ),
}));

// The Layer child calls useMap()/useMapEvents() directly (not through
// BaseMap). Stub useMap with no-op layer methods so the imperative L.*
// `.addTo(map)` calls in BBoxMapEditor's Layer don't touch a real Leaflet
// map instance. useMapEvents just needs to accept a handlers object.
vi.mock('react-leaflet', () => ({
  useMap: () => ({
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    fitBounds: vi.fn(),
  }),
  useMapEvents: () => ({}),
}));

vi.mock('leaflet/dist/leaflet.css', () => ({}));

// The global react-i18next mock (src/test/setup.ts) returns the translation
// key itself rather than the fallback English string, so assertions target
// the keys used in BBoxMapEditor.tsx.
describe('BBoxMapEditor', () => {
  it('shows the "click two corners" hint when no bbox is set', () => {
    render(<BBoxMapEditor bbox={null} onChange={vi.fn()} />);
    expect(screen.getByText('bbox.hint.click_first')).toBeTruthy();
  });

  it('shows the "drag any corner" hint when a bbox is set', () => {
    render(
      <BBoxMapEditor
        bbox={{ minLat: 0, maxLat: 1, minLng: 0, maxLng: 1 }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('bbox.hint.drag_corners')).toBeTruthy();
  });

  it('renders the Clear button once a bbox is set', () => {
    render(
      <BBoxMapEditor
        bbox={{ minLat: 0, maxLat: 1, minLng: 0, maxLng: 1 }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('common.clear')).toBeTruthy();
  });
});
