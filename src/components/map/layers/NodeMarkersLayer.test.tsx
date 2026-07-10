/**
 * @vitest-environment jsdom
 *
 * Descriptor→marker mapping, stable icon/position caches, removal
 * reconciliation, and OMS-click wiring for the shared node marker layer
 * (#4047 Phase 4 WP2). `useMarkerSpiderfier` is fully mocked (per memory:
 * spiderfy tests mock OMS and therefore cannot catch real
 * fan-out/obscured-marker regressions) — this suite proves the layer's
 * *contract*, not real Leaflet/OMS behavior. Browser validation against all
 * four consumer maps is the binding gate for that (see
 * docs/internal/dev-notes/MAP_CONSOLIDATION_P4_SPEC.md §6).
 *
 * The mock `Marker` registers its ref once on mount and clears it once on
 * unmount (a `[]`/stable-dep effect) rather than replicating react-leaflet's
 * real every-render null-bounce (`useImperativeHandle` with no deps, see the
 * component's own comment). That quirk is a `useMarkerSpiderfier`-internal
 * concern already covered by `useMarkerSpiderfier.test.tsx`; this suite only
 * needs a stable per-descriptor marker identity to assert cache/reconciliation
 * behavior.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NodeMarkersLayer, type NodeMarkerDescriptor } from './NodeMarkersLayer';

// ---------------------------------------------------------------------------
// Fake marker + react-leaflet mock
// ---------------------------------------------------------------------------

interface FakeMarker {
  openPopup: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  _openPopup?: (e: unknown) => void;
  _meshPopupStripped?: boolean;
}
function createFakeMarker(): FakeMarker {
  return { openPopup: vi.fn(), off: vi.fn(), _openPopup: () => {} };
}

interface RenderLogEntry {
  position: [number, number];
  icon: unknown;
  opacity?: number;
}
let renderLog: RenderLogEntry[] = [];
let mountedMarkers: FakeMarker[] = [];

interface MockMarkerProps {
  position: [number, number];
  icon: unknown;
  opacity?: number;
  zIndexOffset?: number;
  eventHandlers?: Record<string, (...args: unknown[]) => void>;
  children?: ReactNode;
  ref?: (m: FakeMarker | null) => void;
}

vi.mock('react-leaflet', () => ({
  Marker: (props: MockMarkerProps) => {
    const instRef = useRef<FakeMarker | null>(null);
    if (!instRef.current) instRef.current = createFakeMarker();
    renderLog.push({ position: props.position, icon: props.icon, opacity: props.opacity });
    useEffect(() => {
      props.ref?.(instRef.current);
      mountedMarkers.push(instRef.current!);
      return () => props.ref?.(null);
      // Stable across re-renders as long as `key` (and therefore the layer's
      // memoized ref callback) doesn't change — mirrors mount/unmount only,
      // see file header.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.ref]);
    return <div data-testid="marker">{props.children}</div>;
  },
}));

// ---------------------------------------------------------------------------
// useMarkerSpiderfier mock
// ---------------------------------------------------------------------------

const addMarkerMock = vi.fn();
const removeMarkerMock = vi.fn();
const addListenerMock = vi.fn();
const removeListenerMock = vi.fn();

vi.mock('../../../hooks/useMarkerSpiderfier', () => ({
  useMarkerSpiderfier: () => ({
    addMarker: addMarkerMock,
    removeMarker: removeMarkerMock,
    addListener: addListenerMock,
    removeListener: removeListenerMock,
  }),
  SHARED_SPIDERFIER_OPTIONS: {},
}));

function omsClickHandler(): (marker: FakeMarker) => void {
  const call = addListenerMock.mock.calls.find((c) => c[0] === 'click');
  if (!call) throw new Error('no click listener registered on the spiderfier mock');
  return call[1] as (marker: FakeMarker) => void;
}

function descriptor(overrides: Partial<NodeMarkerDescriptor> & Pick<NodeMarkerDescriptor, 'key'>): NodeMarkerDescriptor {
  return {
    position: [10, 20],
    iconSig: 'sig-default',
    buildIcon: (() => ({ tag: 'icon-default' })) as unknown as NodeMarkerDescriptor['buildIcon'],
    ...overrides,
  };
}

beforeEach(() => {
  renderLog = [];
  mountedMarkers = [];
  addMarkerMock.mockClear();
  removeMarkerMock.mockClear();
  addListenerMock.mockClear();
  removeListenerMock.mockClear();
});
afterEach(() => cleanup());

describe('NodeMarkersLayer', () => {
  it('renders one Marker per descriptor', () => {
    render(
      <NodeMarkersLayer
        markers={[
          descriptor({ key: 'a', position: [1, 2] }),
          descriptor({ key: 'b', position: [3, 4] }),
        ]}
      />,
    );
    expect(screen.getAllByTestId('marker')).toHaveLength(2);
    expect(addMarkerMock).toHaveBeenCalledTimes(2);
    expect(addMarkerMock).toHaveBeenCalledWith(mountedMarkers[0], 'a');
    expect(addMarkerMock).toHaveBeenCalledWith(mountedMarkers[1], 'b');
  });

  it('rebuilds the icon only when iconSig changes (cache hit ignores a new buildIcon reference)', () => {
    const iconA = { tag: 'icon-a' };
    const iconB = { tag: 'icon-b' };
    const asBuildIcon = (fn: () => unknown) => fn as unknown as NodeMarkerDescriptor['buildIcon'];
    const buildIconSpy1 = vi.fn(() => iconA);
    const { rerender } = render(
      <NodeMarkersLayer markers={[descriptor({ key: 'n1', iconSig: 'sig-a', buildIcon: asBuildIcon(buildIconSpy1) })]} />,
    );
    expect(buildIconSpy1).toHaveBeenCalledTimes(1);
    expect(renderLog.at(-1)?.icon).toBe(iconA);

    // Same iconSig, but a BRAND NEW buildIcon closure (as every real consumer
    // passes each render) and a changed opacity — must be a pure cache hit:
    // the new closure is never invoked, and the icon reference is unchanged.
    const buildIconSpy2 = vi.fn(() => iconA);
    rerender(
      <NodeMarkersLayer
        markers={[descriptor({ key: 'n1', iconSig: 'sig-a', buildIcon: asBuildIcon(buildIconSpy2), opacity: 0.5 })]}
      />,
    );
    expect(buildIconSpy2).not.toHaveBeenCalled();
    expect(renderLog.at(-1)?.icon).toBe(iconA);
    expect(renderLog.at(-1)?.opacity).toBe(0.5);

    // Different iconSig — must rebuild.
    const buildIconSpy3 = vi.fn(() => iconB);
    rerender(
      <NodeMarkersLayer markers={[descriptor({ key: 'n1', iconSig: 'sig-b', buildIcon: asBuildIcon(buildIconSpy3) })]} />,
    );
    expect(buildIconSpy3).toHaveBeenCalledTimes(1);
    expect(renderLog.at(-1)?.icon).toBe(iconB);
  });

  it('keeps the position tuple referentially stable across a re-render with identical coordinates (#3685)', () => {
    const { rerender } = render(
      <NodeMarkersLayer markers={[descriptor({ key: 'n1', position: [10, 20] })]} />,
    );
    const firstPosition = renderLog.at(-1)?.position;

    // A brand new array literal with the SAME numeric values — the cache
    // must return the original tuple reference, not this new one.
    rerender(<NodeMarkersLayer markers={[descriptor({ key: 'n1', position: [10, 20] })]} />);
    expect(renderLog.at(-1)?.position).toBe(firstPosition);

    // A genuine position change gets a new tuple.
    rerender(<NodeMarkersLayer markers={[descriptor({ key: 'n1', position: [11, 21] })]} />);
    expect(renderLog.at(-1)?.position).not.toBe(firstPosition);
    expect(renderLog.at(-1)?.position).toEqual([11, 21]);
  });

  it('evicts the removed key and unregisters it from the spiderfier when a descriptor drops out', () => {
    const { rerender } = render(
      <NodeMarkersLayer
        markers={[descriptor({ key: 'a', position: [1, 2] }), descriptor({ key: 'b', position: [3, 4] })]}
      />,
    );
    expect(screen.getAllByTestId('marker')).toHaveLength(2);
    const markerB = mountedMarkers[1];

    rerender(<NodeMarkersLayer markers={[descriptor({ key: 'a', position: [1, 2] })]} />);
    expect(screen.getAllByTestId('marker')).toHaveLength(1);
    expect(removeMarkerMock).toHaveBeenCalledWith(markerB);
  });

  it('default onOmsClick opens the marker popup', () => {
    render(<NodeMarkersLayer markers={[descriptor({ key: 'n1' })]} />);
    const marker = mountedMarkers[0];
    omsClickHandler()(marker);
    expect(marker.openPopup).toHaveBeenCalledTimes(1);
  });

  it('custom onOmsClick receives (marker, key) and the default openPopup is NOT also called', () => {
    const onOmsClick = vi.fn();
    render(<NodeMarkersLayer markers={[descriptor({ key: 'n1' })]} onOmsClick={onOmsClick} />);
    const marker = mountedMarkers[0];
    omsClickHandler()(marker);
    expect(onOmsClick).toHaveBeenCalledWith(marker, 'n1');
    expect(marker.openPopup).not.toHaveBeenCalled();
  });

  it('strips the Leaflet auto-popup handler once per marker by default', () => {
    const { rerender } = render(<NodeMarkersLayer markers={[descriptor({ key: 'n1' })]} />);
    const marker = mountedMarkers[0];
    expect(marker.off).toHaveBeenCalledTimes(1);
    expect(marker.off).toHaveBeenCalledWith('click', marker._openPopup, marker);
    expect(marker._meshPopupStripped).toBe(true);

    // Steady-state re-render: already stripped, so `off` must not fire again.
    rerender(<NodeMarkersLayer markers={[descriptor({ key: 'n1', opacity: 0.7 })]} />);
    expect(marker.off).toHaveBeenCalledTimes(1);
  });

  it('does not strip the auto-popup handler when stripLeafletAutoPopup is false', () => {
    render(<NodeMarkersLayer markers={[descriptor({ key: 'n1' })]} stripLeafletAutoPopup={false} />);
    const marker = mountedMarkers[0];
    expect(marker.off).not.toHaveBeenCalled();
    expect(marker._meshPopupStripped).toBeUndefined();
  });
});
