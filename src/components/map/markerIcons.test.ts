import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Leaflet before importing markerIcons, mirroring the pre-move
// `src/utils/mapIcons.test.ts`. `divIcon` echoes its options object back so
// tests can assert on the exact shape passed to Leaflet (html/className/
// iconSize/iconAnchor/popupAnchor) without a real DOM.
vi.mock('leaflet', () => ({
  default: {
    divIcon: vi.fn((opts: unknown) => opts),
    icon: vi.fn(),
  },
}));

import L from 'leaflet';
import {
  createNodeIcon,
  createTracerouteEndpointIcon,
  getHopColor,
  roleGlyphMarkerSvg,
} from './markerIcons';
import type { NodeTypeCategory } from '../../utils/nodeTypeCategory';

const divIconMock = vi.mocked(L.divIcon);

interface FixtureDivIconOptions {
  html: string;
  className: string;
  iconSize: [number, number];
  iconAnchor: [number, number];
  popupAnchor?: [number, number];
}

/**
 * Byte-for-byte fixture of MeshCoreMap's pre-migration local `makeIcon`
 * (MeshCoreMap.tsx:76, as it existed before #4047 Phase 4 WP1). This is
 * copy-pasted verbatim (not imported) so the test proves the factory's
 * `variant: 'meshcore'` branch produces identical output to the ORIGINAL
 * hand-rolled builder, independent of any future edits to either file.
 */
const MESHCORE_COLOR = '#cba6f7';
function fixtureMakeIcon(name: string, category: NodeTypeCategory): FixtureDivIconOptions {
  const glyph = roleGlyphMarkerSvg(category, MESHCORE_COLOR, 24);
  const body = glyph
    ? `<div style="width:24px;height:24px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));">${glyph}</div>`
    : `
      <div style="
        width: 24px;
        height: 24px;
        background: ${MESHCORE_COLOR};
        border: 2px solid white;
        border-radius: 50%;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #1e1e2e;
        font-size: 10px;
        font-weight: bold;
      ">MC</div>`;
  return {
    className: 'meshcore-marker',
    html: `
      ${body}
      <div style="
        position: absolute;
        top: -20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${MESHCORE_COLOR}e6;
        color: #1e1e2e;
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 11px;
        white-space: nowrap;
      ">${name}</div>
    `,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  };
}

beforeEach(() => {
  divIconMock.mockClear();
});

describe('createNodeIcon — variant branch selection', () => {
  it('defaults to the meshtastic variant when omitted', () => {
    const icon = createNodeIcon({ hops: 2, isSelected: false, isRouter: false, showLabel: false }) as unknown as FixtureDivIconOptions;
    expect(icon.className).toBe('custom-node-icon');
  });

  it('dispatches to the meshcore badge branch when variant is meshcore', () => {
    const icon = createNodeIcon({
      variant: 'meshcore',
      fixedColor: MESHCORE_COLOR,
      labelName: 'Base Station',
      roleCategory: 'standard',
    }) as unknown as FixtureDivIconOptions;
    expect(icon.className).toBe('meshcore-marker');
  });
});

describe('createNodeIcon — variant:"meshcore" parity with the pre-migration makeIcon', () => {
  const cases: { label: string; name: string; category: NodeTypeCategory }[] = [
    { label: 'glyph branch (repeater)', name: 'Ridge Repeater', category: 'repeater' },
    { label: 'glyph branch (roomServer)', name: 'Room Server', category: 'roomServer' },
    { label: 'glyph branch (sensor)', name: 'Weather Sensor', category: 'sensor' },
    { label: 'glyph branch (companion)', name: 'Handheld', category: 'companion' },
    { label: '"MC" fallback branch (standard)', name: 'Plain Node', category: 'standard' },
  ];

  it.each(cases)('$label produces byte-identical divIcon options', ({ name, category }) => {
    const expected = fixtureMakeIcon(name, category);
    const actual = createNodeIcon({
      variant: 'meshcore',
      fixedColor: MESHCORE_COLOR,
      labelName: name,
      roleCategory: category,
    }) as unknown as FixtureDivIconOptions;

    expect(actual.html).toBe(expected.html);
    expect(actual.className).toBe(expected.className);
    expect(actual.iconSize).toEqual(expected.iconSize);
    expect(actual.iconAnchor).toEqual(expected.iconAnchor);
    // The original makeIcon never set popupAnchor (center-anchored, no
    // popup offset) — the factory must not introduce one either.
    expect(actual.popupAnchor).toBeUndefined();
  });

  it('ignores pin/selection/animate options (MeshCore has none today)', () => {
    const withExtras = createNodeIcon({
      variant: 'meshcore',
      fixedColor: MESHCORE_COLOR,
      labelName: 'Node',
      roleCategory: 'standard',
      isSelected: true,
      isRouter: true,
      animate: true,
      highlightSelected: true,
      pinStyle: 'official',
    }) as unknown as FixtureDivIconOptions;
    const bare = createNodeIcon({
      variant: 'meshcore',
      fixedColor: MESHCORE_COLOR,
      labelName: 'Node',
      roleCategory: 'standard',
    }) as unknown as FixtureDivIconOptions;

    expect(withExtras).toEqual(bare);
  });
});

describe('createNodeIcon — variant:"meshtastic" (default) unchanged code paths', () => {
  it('meshmonitor pinStyle: hop-colored pin, unselected, no label', () => {
    const icon = createNodeIcon({
      hops: 3,
      isSelected: false,
      isRouter: false,
      showLabel: false,
      pinStyle: 'meshmonitor',
    }) as unknown as FixtureDivIconOptions;

    expect(icon.className).toBe('custom-node-icon');
    expect(icon.iconSize).toEqual([48, 48]);
    expect(icon.iconAnchor).toEqual([24, 48]);
    expect(icon.popupAnchor).toEqual([0, -48]);
    expect(icon.html).toContain(getHopColor(3)); // #660099
    expect(icon.html).not.toContain('node-icon-pulse');
    expect(icon.html).not.toContain('node-icon-highlight');
  });

  it('meshmonitor pinStyle: selected router with label grows to 60px + label offset', () => {
    const icon = createNodeIcon({
      hops: 1,
      isSelected: true,
      isRouter: true,
      shortName: 'RTR1',
      showLabel: true,
      pinStyle: 'meshmonitor',
    }) as unknown as FixtureDivIconOptions;

    expect(icon.iconSize).toEqual([60, 80]); // size + 20 for label
    expect(icon.iconAnchor).toEqual([30, 60]);
    expect(icon.html).toContain('RTR1');
    expect(icon.html).toContain(getHopColor(1)); // #0000FF
  });

  it('official pinStyle: circle with short-name text, center-anchored', () => {
    const icon = createNodeIcon({
      hops: 0,
      isSelected: false,
      isRouter: false,
      shortName: 'ABCD',
      showLabel: true,
      pinStyle: 'official',
    }) as unknown as FixtureDivIconOptions;

    expect(icon.className).toBe('custom-node-icon');
    expect(icon.iconSize).toEqual([48, 48]);
    expect(icon.iconAnchor).toEqual([24, 24]);
    expect(icon.popupAnchor).toEqual([0, -24]);
    expect(icon.html).toContain('ABCD');
    expect(icon.html).toContain(getHopColor(0)); // #22c55e
  });

  it('animate + highlightSelected classes are applied when requested', () => {
    const icon = createNodeIcon({
      hops: 2,
      isSelected: true,
      isRouter: false,
      showLabel: false,
      animate: true,
      highlightSelected: true,
    }) as unknown as FixtureDivIconOptions;

    expect(icon.html).toContain('node-icon-pulse');
    expect(icon.html).toContain('node-icon-highlight');
  });

  it('fixedColor overrides getHopColor(hops) when explicitly supplied', () => {
    const icon = createNodeIcon({
      hops: 4,
      isSelected: false,
      isRouter: false,
      showLabel: false,
      fixedColor: '#123456',
    }) as unknown as FixtureDivIconOptions;

    expect(icon.html).toContain('#123456');
    expect(icon.html).not.toContain(getHopColor(4)); // #990066 must not appear
  });

  it('meshtastic callers never pass fixedColor, so output is unaffected by its existence', () => {
    const before = createNodeIcon({ hops: 5, isSelected: false, isRouter: false, showLabel: false }) as unknown as FixtureDivIconOptions;
    const after = createNodeIcon({ hops: 5, isSelected: false, isRouter: false, showLabel: false, fixedColor: undefined }) as unknown as FixtureDivIconOptions;
    expect(after).toEqual(before);
  });

  it('matches the pre-Phase-4 shim import path (src/utils/mapIcons) byte-for-byte', async () => {
    const shim = await import('../../utils/mapIcons');
    const direct = createNodeIcon({ hops: 2, isSelected: true, isRouter: true, shortName: 'HOP2', showLabel: true, pinStyle: 'meshmonitor' });
    const viaShim = shim.createNodeIcon({ hops: 2, isSelected: true, isRouter: true, shortName: 'HOP2', showLabel: true, pinStyle: 'meshmonitor' });
    expect(viaShim).toEqual(direct);
  });
});

describe('createNodeIcon — cache-relevant purity', () => {
  it('same inputs produce equal (deep-equal) html/options across calls', () => {
    const opts = { hops: 3, isSelected: false, isRouter: true, shortName: 'X', showLabel: true, pinStyle: 'meshmonitor' as const };
    const a = createNodeIcon(opts);
    const b = createNodeIcon(opts);
    expect(a).toEqual(b);
  });

  it('meshcore variant: same inputs produce equal output across calls', () => {
    const opts = { variant: 'meshcore' as const, fixedColor: MESHCORE_COLOR, labelName: 'Node', roleCategory: 'sensor' as const };
    const a = createNodeIcon(opts);
    const b = createNodeIcon(opts);
    expect(a).toEqual(b);
  });

  it('different inputs produce different html', () => {
    const a = createNodeIcon({ hops: 1, isSelected: false, isRouter: false, showLabel: false });
    const b = createNodeIcon({ hops: 6, isSelected: false, isRouter: false, showLabel: false });
    expect(a).not.toEqual(b);
  });
});

describe('createTracerouteEndpointIcon', () => {
  it('"from" role: green, 12px endpoint dot', () => {
    const icon = createTracerouteEndpointIcon('from') as unknown as FixtureDivIconOptions;
    expect(icon.html).toContain('#4CAF50');
    expect(icon.className).toBe('traceroute-node-icon');
    expect(icon.iconSize).toEqual([16, 16]);
    expect(icon.iconAnchor).toEqual([8, 8]);
  });

  it('"to" role: blue, 12px endpoint dot', () => {
    const icon = createTracerouteEndpointIcon('to') as unknown as FixtureDivIconOptions;
    expect(icon.html).toContain('#2196F3');
    expect(icon.iconSize).toEqual([16, 16]);
    expect(icon.iconAnchor).toEqual([8, 8]);
  });

  it('"hop" role: gray, 8px intermediate dot', () => {
    const icon = createTracerouteEndpointIcon('hop') as unknown as FixtureDivIconOptions;
    expect(icon.html).toContain('#888');
    expect(icon.iconSize).toEqual([12, 12]);
    expect(icon.iconAnchor).toEqual([6, 6]);
  });

  it('is a verbatim relocation of TracerouteWidget\'s local builder (no popupAnchor, same class)', () => {
    const icon = createTracerouteEndpointIcon('from') as unknown as FixtureDivIconOptions;
    expect(icon.popupAnchor).toBeUndefined();
    expect(icon.className).toBe('traceroute-node-icon');
  });
});

describe('createNodeIcon — Meshtastic ROUTER_LATE is distinguished from ROUTER (#4295)', () => {
  const iconHtml = (roleCategory: NodeTypeCategory | undefined, isRouter: boolean) =>
    (createNodeIcon({
      variant: 'meshtastic',
      hops: 1,
      isRouter,
      roleCategory,
      shortName: 'X',
    }) as unknown as { html: string }).html;

  it('ROUTER_LATE (mtRouterLate) no longer renders identically to ROUTER (mtRouter)', () => {
    // #4295 reverses #4075's intentional convergence: ROUTER_LATE is a lesser
    // infra role and must read distinctly. It keeps the tower silhouette but
    // gains a clock badge, so its markup diverges from a plain ROUTER.
    expect(iconHtml('mtRouterLate', false)).not.toBe(iconHtml('mtRouter', false));
  });

  it('ROUTER_LATE keeps the shared repeater-tower silhouette (still reads as infra)', () => {
    // Both draw the tower base rect; ROUTER_LATE layers a clock badge on top of
    // it rather than swapping to an unrelated glyph.
    const routerLate = iconHtml('mtRouterLate', false);
    const router = iconHtml('mtRouter', false);
    expect(router).toContain('x="19" y="32"'); // tower base
    expect(routerLate).toContain('x="19" y="32"'); // tower base retained
  });

  it('ROUTER_LATE carries a clock badge that ROUTER does not', () => {
    // The clock disc is drawn at (13,34); ROUTER has no such element.
    expect(iconHtml('mtRouterLate', false)).toContain('cx="13" cy="34"');
    expect(iconHtml('mtRouter', false)).not.toContain('cx="13" cy="34"');
  });

  it('ROUTER_LATE does NOT render as the generic client pin', () => {
    // A ROUTER_LATE node (isRouter=false, role 11) with its category must still
    // diverge from a standard client icon.
    expect(iconHtml('mtRouterLate', false)).not.toBe(iconHtml('mtClient', false));
  });
});

describe('createNodeIcon — unmessageable badge (#4295)', () => {
  const iconHtml = (isUnmessagable: boolean, pinStyle: 'meshmonitor' | 'official') =>
    (createNodeIcon({
      variant: 'meshtastic',
      hops: 1,
      roleCategory: 'mtClient',
      shortName: 'X',
      pinStyle,
      isUnmessagable,
    }) as unknown as { html: string }).html;

  it('adds the ban-badge overlay in meshmonitor style when isUnmessagable is true', () => {
    expect(iconHtml(true, 'meshmonitor')).toContain('#d64545');
    expect(iconHtml(false, 'meshmonitor')).not.toContain('#d64545');
  });

  it('adds the ban-badge overlay in official style when isUnmessagable is true', () => {
    expect(iconHtml(true, 'official')).toContain('#d64545');
    expect(iconHtml(false, 'official')).not.toContain('#d64545');
  });

  it('defaults to no badge when isUnmessagable is omitted', () => {
    const icon = createNodeIcon({
      variant: 'meshtastic',
      hops: 1,
      roleCategory: 'mtClient',
      shortName: 'X',
    }) as unknown as { html: string };
    expect(icon.html).not.toContain('#d64545');
  });

  it('places the badge in the top-right corner, clear of the bottom-right role badge', () => {
    const icon = createNodeIcon({
      variant: 'meshtastic',
      hops: 1,
      roleCategory: 'mtRouter',
      shortName: 'RTR1',
      pinStyle: 'official',
      isUnmessagable: true,
    }) as unknown as { html: string };
    // Both badges coexist: role badge bottom-right, unmessageable badge top-right.
    expect(icon.html).toContain('bottom: -2px');
    expect(icon.html).toContain('top: -2px');
    expect(icon.html).toContain('#d64545');
  });
});

describe('createNodeIcon — official pinStyle keeps the short-name visible for infra roles (#4154)', () => {
  it('ROUTER short name is NOT suppressed by the role glyph in official style', () => {
    const icon = createNodeIcon({
      hops: 1,
      shortName: 'RTR1',
      roleCategory: 'mtRouter',
      pinStyle: 'official',
    }) as unknown as FixtureDivIconOptions;

    // The pre-#4154 bug: roleInner truthy meant the <text> short-name node
    // never rendered at all for ROUTER/ROUTER_LATE in official style.
    expect(icon.html).toContain('RTR1');
    expect(icon.html).toContain('<text');
  });

  it('ROUTER_LATE short name is NOT suppressed by the role glyph in official style', () => {
    const icon = createNodeIcon({
      hops: 1,
      shortName: 'RTL2',
      roleCategory: 'mtRouterLate',
      pinStyle: 'official',
    }) as unknown as FixtureDivIconOptions;

    expect(icon.html).toContain('RTL2');
    expect(icon.html).toContain('<text');
  });

  it('infra roles still get a distinguishing corner badge carrying the role glyph', () => {
    const icon = createNodeIcon({
      hops: 1,
      shortName: 'RTR1',
      roleCategory: 'mtRouter',
      pinStyle: 'official',
    }) as unknown as FixtureDivIconOptions;
    const plain = createNodeIcon({
      hops: 1,
      shortName: 'RTR1',
      roleCategory: 'standard',
      pinStyle: 'official',
    }) as unknown as FixtureDivIconOptions;

    // Badge is present for the infra role and absent for a standard node —
    // the badge is how official style now differentiates infra without
    // hiding the short name.
    expect(icon.html).not.toEqual(plain.html);
    // The badge wrapper is absolutely positioned in the bottom-right corner.
    expect(icon.html).toContain('bottom: -2px');
    expect(icon.html).toContain('right: -2px');
    expect(plain.html).not.toContain('bottom: -2px');
  });

  it('MeshCore role glyphs (issue #3546) also keep the short name visible in official style', () => {
    const icon = createNodeIcon({
      hops: 1,
      shortName: 'SNS1',
      roleCategory: 'sensor',
      pinStyle: 'official',
    }) as unknown as FixtureDivIconOptions;

    expect(icon.html).toContain('SNS1');
    expect(icon.html).toContain('<text');
    // Still gets the differentiating corner badge.
    expect(icon.html).toContain('bottom: -2px');
  });

  it('emoji short names still render via the emoji overlay (no <text>), unaffected by role', () => {
    const icon = createNodeIcon({
      hops: 1,
      shortName: '🛰️',
      roleCategory: 'mtRouter',
      pinStyle: 'official',
    }) as unknown as FixtureDivIconOptions;

    expect(icon.html).toContain('🛰️');
    // Emoji path never used <text>; it overlays a plain div instead.
    expect(icon.html).not.toContain('<text');
    // Badge still shows for the infra role.
    expect(icon.html).toContain('bottom: -2px');
  });

  it('standard-role nodes are unaffected: no badge markup at all', () => {
    const icon = createNodeIcon({
      hops: 1,
      shortName: 'PLAIN',
      pinStyle: 'official',
    }) as unknown as FixtureDivIconOptions;

    expect(icon.html).toContain('PLAIN');
    expect(icon.html).not.toContain('bottom: -2px');
  });
});
