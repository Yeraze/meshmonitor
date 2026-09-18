/**
 * @vitest-environment jsdom
 *
 * Marker-clustering perf fix: proves `NodeMarkerCluster`'s own contract —
 * it forwards `disableClusteringAtZoom` (defaulting to
 * `DEFAULT_ZOOM_GATE_THRESHOLD`, the same zoom `NodeMarkersLayer`'s
 * spiderfier gate already treats as "individually manageable"), disables
 * leaflet.markercluster's own spiderfy/coverage-hover (so it never competes
 * with the OMS spiderfier), and its `iconCreateFunction` builds a
 * count-bubble `L.divIcon` sized/tiered by child count with a translated
 * label. Real leaflet.markercluster clustering behavior (which markers land
 * in which cluster) is the vendored library's own concern, not this
 * wrapper's — that's covered by the browser verification in the perf-fix
 * writeup, not here.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { NodeMarkerCluster } from './NodeMarkerCluster';
import { DEFAULT_ZOOM_GATE_THRESHOLD } from '../../../hooks/useMarkerSpiderfier';

vi.mock('leaflet.markercluster', () => ({}));
vi.mock('react-leaflet-cluster/dist/assets/MarkerCluster.css', () => ({}));

interface CapturedProps {
  iconCreateFunction: (cluster: { getChildCount: () => number }) => { options: { html: string; className: string; iconSize: [number, number] } };
  disableClusteringAtZoom: number;
  spiderfyOnMaxZoom: boolean;
  showCoverageOnHover: boolean;
  chunkedLoading: boolean;
}
let captured: CapturedProps | null = null;

vi.mock('react-leaflet-cluster', () => ({
  default: (props: CapturedProps & { children: React.ReactNode }) => {
    captured = props;
    return <div data-testid="cluster-group">{props.children}</div>;
  },
}));

vi.mock('leaflet', () => ({
  default: {
    divIcon: (opts: { html: string; className: string; iconSize: [number, number]; iconAnchor: [number, number] }) => ({ options: opts }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count: number }) =>
      key === 'map.clusterNodeCount' ? `${opts?.count} node${opts?.count === 1 ? '' : 's'}` : key,
  }),
}));

describe('NodeMarkerCluster', () => {
  it('renders children through MarkerClusterGroup', () => {
    const { getByTestId, getByText } = render(
      <NodeMarkerCluster>
        <div>a marker</div>
      </NodeMarkerCluster>,
    );
    expect(getByTestId('cluster-group')).toBeTruthy();
    expect(getByText('a marker')).toBeTruthy();
  });

  it('defaults disableClusteringAtZoom to DEFAULT_ZOOM_GATE_THRESHOLD and turns off the library spiderfy/hover', () => {
    render(<NodeMarkerCluster><div /></NodeMarkerCluster>);
    expect(captured?.disableClusteringAtZoom).toBe(DEFAULT_ZOOM_GATE_THRESHOLD);
    expect(captured?.spiderfyOnMaxZoom).toBe(false);
    expect(captured?.showCoverageOnHover).toBe(false);
    expect(captured?.chunkedLoading).toBe(true);
  });

  it('accepts an explicit disableClusteringAtZoom override', () => {
    render(<NodeMarkerCluster disableClusteringAtZoom={10}><div /></NodeMarkerCluster>);
    expect(captured?.disableClusteringAtZoom).toBe(10);
  });

  it('iconCreateFunction builds a small-tier bubble under 10', () => {
    render(<NodeMarkerCluster><div /></NodeMarkerCluster>);
    const icon = captured!.iconCreateFunction({ getChildCount: () => 4 });
    expect(icon.options.html).toContain('>4<');
    expect(icon.options.html).toContain('4 nodes');
    expect(icon.options.className).toBe('node-cluster-icon');
    expect(icon.options.iconSize).toEqual([34, 34]);
  });

  it('iconCreateFunction builds a medium-tier bubble at 10-99', () => {
    render(<NodeMarkerCluster><div /></NodeMarkerCluster>);
    const icon = captured!.iconCreateFunction({ getChildCount: () => 42 });
    expect(icon.options.iconSize).toEqual([42, 42]);
  });

  it('iconCreateFunction builds a large-tier bubble at 100+', () => {
    render(<NodeMarkerCluster><div /></NodeMarkerCluster>);
    const icon = captured!.iconCreateFunction({ getChildCount: () => 250 });
    expect(icon.options.iconSize).toEqual([52, 52]);
    expect(icon.options.html).toContain('250 nodes');
  });

  it('singular count uses the singular translation', () => {
    render(<NodeMarkerCluster><div /></NodeMarkerCluster>);
    const icon = captured!.iconCreateFunction({ getChildCount: () => 1 });
    expect(icon.options.html).toContain('1 node"');
  });
});
