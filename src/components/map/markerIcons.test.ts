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
import { meshtasticNodeColor } from '../../utils/nodeColor.js';
import {
  createNodeIcon,
  createTracerouteEndpointIcon,
  getHopColor,
  roleGlyphInnerSvg,
  roleGlyphMarkerSvg,
  unmessageableBadgeSvg,
} from './markerIcons';
import * as roleGlyphSvg from '../../utils/roleGlyphSvg';
import roleGlyphSvgSource from '../../utils/roleGlyphSvg.ts?raw';
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
    // #4860: the short name carries a white halo so it stays legible over
    // satellite imagery where the backing circle washes out on bright terrain.
    expect(icon.html).toContain('paint-order="stroke"');
    expect(icon.html).toContain('stroke="#ffffff"');
    // A non-zero width is what actually makes the halo visible — guard against a
    // future stroke-width="0" that would keep the attributes but disable it.
    expect(icon.html).toContain('stroke-width="3"');
  });

  it('official pinStyle: fills the circle with the per-node color and luminance-picked text when nodeNum is set (#4880)', () => {
    // low 24 bits of 0x11223344 = 0x223344 (dark) -> white text, black halo
    const icon = createNodeIcon({
      hops: 0,
      isSelected: false,
      isRouter: false,
      shortName: 'ABCD',
      showLabel: true,
      pinStyle: 'official',
      nodeNum: 0x11223344,
    }) as unknown as FixtureDivIconOptions;

    expect(icon.html).toContain('fill="#223344"'); // node-color circle fill
    expect(icon.html).toContain('stroke="#ffffff"'); // white circle outline
    expect(icon.html).toContain('fill="#ffffff"'); // white short-name text on dark fill
    expect(icon.html).toContain('stroke="#000000"'); // dark text halo
    // The hop color is NOT used for the circle when a node color is applied.
    expect(icon.html).not.toContain(getHopColor(0));
  });

  it('official pinStyle without nodeNum keeps the original white circle + hop stroke (#4880 back-compat)', () => {
    const icon = createNodeIcon({
      hops: 0,
      isSelected: false,
      isRouter: false,
      shortName: 'ABCD',
      showLabel: true,
      pinStyle: 'official',
    }) as unknown as FixtureDivIconOptions;

    expect(icon.html).toContain(getHopColor(0)); // hop-colored stroke
    expect(icon.html).toContain('fill="white"');
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

  it('ROUTER_LATE keeps the router-tower silhouette (still reads as infra)', () => {
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

describe('createNodeIcon — likely-aircraft badge (#5364/#5365 Phase 1 WP4)', () => {
  const iconHtml = (isLikelyAircraft: boolean, pinStyle: 'meshmonitor' | 'official') =>
    (createNodeIcon({
      variant: 'meshtastic',
      hops: 1,
      roleCategory: 'mtClient',
      shortName: 'X',
      pinStyle,
      isLikelyAircraft,
    }) as unknown as { html: string }).html;

  it('adds the aircraft-badge overlay in meshmonitor style when isLikelyAircraft is true', () => {
    expect(iconHtml(true, 'meshmonitor')).toContain('#1f6feb');
    expect(iconHtml(false, 'meshmonitor')).not.toContain('#1f6feb');
  });

  it('adds the aircraft-badge overlay in official style when isLikelyAircraft is true', () => {
    expect(iconHtml(true, 'official')).toContain('#1f6feb');
    expect(iconHtml(false, 'official')).not.toContain('#1f6feb');
  });

  it('defaults to no badge when isLikelyAircraft is omitted', () => {
    const icon = createNodeIcon({
      variant: 'meshtastic',
      hops: 1,
      roleCategory: 'mtClient',
      shortName: 'X',
    }) as unknown as { html: string };
    expect(icon.html).not.toContain('#1f6feb');
  });

  it('places the badge in the top-left corner, clear of the top-right unmessageable badge and the bottom-right role badge', () => {
    const icon = createNodeIcon({
      variant: 'meshtastic',
      hops: 1,
      roleCategory: 'mtRouter',
      shortName: 'RTR1',
      pinStyle: 'official',
      isUnmessagable: true,
      isLikelyAircraft: true,
    }) as unknown as { html: string };
    // All three badges coexist: role badge bottom-right, unmessageable badge
    // top-right, aircraft badge top-left.
    expect(icon.html).toContain('bottom: -2px');
    expect(icon.html).toContain('top: -2px');
    expect(icon.html).toContain('right: -2px');
    expect(icon.html).toContain('left: -2px');
    expect(icon.html).toContain('#d64545');
    expect(icon.html).toContain('#1f6feb');
  });

  it('meshcore variant ignores isLikelyAircraft', () => {
    const icon = createNodeIcon({
      variant: 'meshcore',
      roleCategory: 'standard',
      isLikelyAircraft: true,
    }) as unknown as { html: string };
    expect(icon.html).not.toContain('#1f6feb');
  });

  it('unflagged output is byte-identical to omitting isLikelyAircraft entirely', () => {
    const withFalse = createNodeIcon({
      variant: 'meshtastic',
      hops: 1,
      roleCategory: 'mtClient',
      shortName: 'X',
      isLikelyAircraft: false,
    }) as unknown as { html: string };
    const omitted = createNodeIcon({
      variant: 'meshtastic',
      hops: 1,
      roleCategory: 'mtClient',
      shortName: 'X',
    }) as unknown as { html: string };
    expect(withFalse.html).toBe(omitted.html);
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

describe('markerIcons re-exports — extraction guard (issue #4381 WP1)', () => {
  // `roleGlyphInnerSvg`/`roleGlyphMarkerSvg`/`getHopColor`/`unmessageableBadgeSvg`
  // were relocated verbatim to the Leaflet-free `src/utils/roleGlyphSvg.ts` so
  // the Node Details traceroute strip can import them without pulling Leaflet
  // into a non-map bundle/test. `markerIcons.ts` re-exports the same function
  // references — assert identity (not just equal output) so a future refactor
  // that accidentally re-implements rather than re-exports is caught.
  it('re-exports the exact same function references as roleGlyphSvg', () => {
    expect(roleGlyphInnerSvg).toBe(roleGlyphSvg.roleGlyphInnerSvg);
    expect(roleGlyphMarkerSvg).toBe(roleGlyphSvg.roleGlyphMarkerSvg);
    expect(getHopColor).toBe(roleGlyphSvg.getHopColor);
    expect(unmessageableBadgeSvg).toBe(roleGlyphSvg.unmessageableBadgeSvg);
  });

  it('roleGlyphInnerSvg produces identical output via either import path', () => {
    const categories: NodeTypeCategory[] = [
      'standard',
      'mtRouter',
      'mtRouterLate',
      'repeater',
      'roomServer',
      'sensor',
      'companion',
    ];
    for (const category of categories) {
      expect(roleGlyphInnerSvg(category, '#123456')).toBe(
        roleGlyphSvg.roleGlyphInnerSvg(category, '#123456'),
      );
    }
  });

  it('roleGlyphMarkerSvg produces identical output via either import path, including the "" fallback for standard', () => {
    expect(roleGlyphMarkerSvg('standard', '#123456', 24)).toBe('');
    expect(roleGlyphMarkerSvg('standard', '#123456', 24)).toBe(
      roleGlyphSvg.roleGlyphMarkerSvg('standard', '#123456', 24),
    );
    expect(roleGlyphMarkerSvg('mtRouter', '#123456', 24)).toBe(
      roleGlyphSvg.roleGlyphMarkerSvg('mtRouter', '#123456', 24),
    );
  });

  it('getHopColor produces identical output via either import path', () => {
    for (const hops of [0, 1, 3, 6, 999]) {
      expect(getHopColor(hops)).toBe(roleGlyphSvg.getHopColor(hops));
    }
  });

  it('unmessageableBadgeSvg produces identical output via either import path', () => {
    expect(unmessageableBadgeSvg(10)).toBe(roleGlyphSvg.unmessageableBadgeSvg(10));
  });

  it('src/utils/roleGlyphSvg.ts is Leaflet-free (no leaflet import, no React import)', () => {
    // Loaded via Vite's `?raw` import (not `fs`/`__dirname`, which don't exist
    // under ESM outside a Vitest shim) so the assertion runs against the exact
    // module text the bundler sees. The patterns match the module specifier
    // generally, not just `from '...'`, so a dynamic `import('leaflet')` would
    // be caught too, not only a static import.
    expect(roleGlyphSvgSource).not.toMatch(/['"]leaflet['"]/);
    expect(roleGlyphSvgSource).not.toMatch(/['"]react['"]/);
  });
});

// ---------------------------------------------------------------------------
// #5018 — the official pin's colour is a separate choice from its shape.
//
// Before this, picking the official circle forced the per-node identity colour
// from #4880, so anyone who wanted that look lost hop distance at a glance.
// `colorMode` decouples the two; the teardrop pin is unaffected because it has
// only ever been hop-coloured.
// ---------------------------------------------------------------------------
describe('createNodeIcon — official pin colour mode (#5018)', () => {
  const base = {
    isSelected: false,
    isRouter: false,
    shortName: 'ABCD',
    pinStyle: 'official' as const,
    nodeNum: 0x11223344,
  };

  const htmlFor = (opts: Parameters<typeof createNodeIcon>[0]) =>
    (createNodeIcon(opts) as unknown as { html: string }).html;

  it('defaults to the per-node identity colour, preserving #4880', () => {
    const html = htmlFor({ ...base, hops: 3 });
    expect(html).toContain(meshtasticNodeColor(base.nodeNum));
  });

  it('fills with the hop colour when colorMode is "hops"', () => {
    const html = htmlFor({ ...base, hops: 3, colorMode: 'hops' });
    expect(html).toContain(getHopColor(3));
    expect(html).not.toContain(meshtasticNodeColor(base.nodeNum));
  });

  it('uses the SAME hop colour the teardrop pin would', () => {
    // The point of the feature: the two styles must agree on what a given hop
    // distance looks like, or the toggle teaches the user a second colour
    // scale for no reason.
    for (const hops of [0, 1, 2, 3, 7]) {
      const official = htmlFor({ ...base, hops, colorMode: 'hops' });
      expect(official).toContain(getHopColor(hops));
    }
  });

  it('still renders the short name — this is the official pin, not a teardrop', () => {
    const html = htmlFor({ ...base, hops: 2, colorMode: 'hops' });
    expect(html).toContain('ABCD');
    expect(html).toContain('<circle');
  });

  it('lets fixedColor win over both modes', () => {
    // fixedColor is how the Dashboard overlay and the MeshCore/Reticulum maps
    // pin a whole layer to one colour — a different question from what a
    // node's own colour means.
    const html = htmlFor({ ...base, hops: 3, colorMode: 'hops', fixedColor: '#facc15' });
    expect(html).toContain('#facc15');
    expect(html).not.toContain(getHopColor(3));
  });

  it('leaves the teardrop pin hop-coloured regardless of colorMode', () => {
    // 'node' is the default and must not leak the identity colour into a pin
    // style that has never had one.
    const html = htmlFor({ ...base, pinStyle: 'meshmonitor', hops: 4, colorMode: 'node' });
    expect(html).toContain(getHopColor(4));
    expect(html).not.toContain(meshtasticNodeColor(base.nodeNum));
  });
});

describe('createNodeIcon — Meshtastic role markers and corner badges (#6008)', () => {
  const html = (opts: Parameters<typeof createNodeIcon>[0]) =>
    (createNodeIcon({ variant: 'meshtastic', hops: 1, shortName: 'X', ...opts }) as unknown as { html: string }).html;
  const styles = ['meshmonitor', 'official'] as const;
  const badgeCases: Array<[NodeTypeCategory, string]> = [
    ['mtTracker', 'tracker'],
    ['mtTakTracker', 'tracker'],
    ['mtLostAndFound', 'lostAndFound'],
    ['mtSensor', 'sensor'],
    ['mtTak', 'tak'],
    ['mtClientMute', 'clientMute'],
  ];

  it.each(styles)('draws CLIENT_BASE with its own base glyph, not the router tower (%s)', (pinStyle) => {
    const base = html({ roleCategory: 'mtClientBase', isRouter: true, pinStyle });
    const glyph = roleGlyphInnerSvg('mtClientBase', getHopColor(1));
    expect(glyph).not.toBe('');
    expect(glyph).not.toBe(roleGlyphInnerSvg('mtRouter', getHopColor(1)));
    // meshmonitor swaps the pin for the glyph; official keeps the short-name
    // circle and draws the glyph as its bottom-right infrastructure badge.
    expect(base).toContain('<rect x="21" y="32" width="6" height="10" fill="white" />');
    expect(base).not.toContain('data-role-badge');
  });

  it.each(styles)('draws the deprecated ROUTER_CLIENT as the router tower (%s)', (pinStyle) => {
    const rc = html({ roleCategory: 'mtRouterClient', pinStyle });
    expect(rc).toContain('<rect x="22.5" y="4" width="3" height="12" fill="#555" />');
  });

  for (const pinStyle of styles) {
    it.each(badgeCases)(`badges %s as %s in the bottom-left corner (${pinStyle})`, (category, kind) => {
      const out = html({ roleCategory: category, pinStyle });
      expect(out).toContain(`data-role-badge="${kind}"`);
      const at = out.indexOf('class="node-role-badge"');
      const badgeStyle = out.slice(at, out.indexOf('">', at));
      expect(badgeStyle).toContain('bottom: -2px');
      expect(badgeStyle).toContain('left: -2px');
    });
  }

  it.each(styles)('keeps CLIENT, CLIENT_HIDDEN and MeshCore categories plain (%s)', (pinStyle) => {
    for (const category of ['mtClient', 'mtClientHidden'] as NodeTypeCategory[]) {
      expect(html({ roleCategory: category, pinStyle })).not.toContain('data-role-badge');
    }
    expect(html({ roleCategory: undefined, pinStyle })).not.toContain('data-role-badge');
  });

  it('does not badge the MeshCore variant', () => {
    expect(html({ variant: 'meshcore', roleCategory: 'sensor' })).not.toContain('data-role-badge');
  });

  it('a SENSOR is a badge on the default pin, not a sensor glyph swap', () => {
    const sensor = html({ roleCategory: 'mtSensor', pinStyle: 'meshmonitor' });
    expect(sensor).toContain('<!-- Pin shape -->');
  });

  it('coexists with the aircraft and unmessageable badges in separate corners', () => {
    const out = html({ roleCategory: 'mtTracker', pinStyle: 'official', isLikelyAircraft: true, isUnmessagable: true });
    expect(out).toContain('data-role-badge="tracker"');
    expect(out).toContain('top: -2px;\n        left: -2px'); // aircraft, top-left
    expect(out).toContain('top: -2px;\n        right: -2px'); // unmessageable, top-right
    expect(out).toContain('bottom: -2px;\n        left: -2px'); // role badge, bottom-left
  });

  it('colours badges with theme role tokens only', () => {
    for (const [category] of badgeCases) {
      const out = html({ roleCategory: category, pinStyle: 'official' });
      const at = out.indexOf('<svg', out.indexOf('class="node-role-badge"'));
      const badge = out.slice(at, out.indexOf('</svg>', at));
      expect(badge).toContain('var(--color-');
      expect(badge).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    }
  });
});

// Cases moved from the deleted src/utils/mapIcons.test.ts, which tested the
// same functions through the deprecated re-export shim.
describe('getHopColor', () => {
  describe('special hop counts', () => {
    it('should return green for 0 hops (local node)', () => {
      expect(getHopColor(0)).toBe('#22c55e');
    });

    it('should return grey for 999 (no hop data)', () => {
      expect(getHopColor(999)).toBe('#9ca3af');
    });
  });

  describe('blue-to-red gradient (1-6 hops)', () => {
    it('should return blue for 1 hop', () => {
      expect(getHopColor(1)).toBe('#0000FF');
    });

    it('should return blue-purple for 2 hops', () => {
      expect(getHopColor(2)).toBe('#3300CC');
    });

    it('should return purple for 3 hops', () => {
      expect(getHopColor(3)).toBe('#660099');
    });

    it('should return red-purple for 4 hops', () => {
      expect(getHopColor(4)).toBe('#990066');
    });

    it('should return red-magenta for 5 hops', () => {
      expect(getHopColor(5)).toBe('#CC0033');
    });

    it('should return red for 6 hops', () => {
      expect(getHopColor(6)).toBe('#FF0000');
    });
  });

  describe('high hop counts (6+)', () => {
    it('should return red for 7 hops', () => {
      expect(getHopColor(7)).toBe('#FF0000');
    });

    it('should return red for 10 hops', () => {
      expect(getHopColor(10)).toBe('#FF0000');
    });

    it('should return red for 100 hops', () => {
      expect(getHopColor(100)).toBe('#FF0000');
    });
  });

  describe('gradient progression', () => {
    it('should progress from blue to red through purple', () => {
      const colors = [
        getHopColor(1), // Blue
        getHopColor(2), // Blue-Purple
        getHopColor(3), // Purple
        getHopColor(4), // Red-Purple
        getHopColor(5), // Red-Magenta
        getHopColor(6), // Red
      ];

      // Verify we have 6 distinct colors
      const uniqueColors = new Set(colors);
      expect(uniqueColors.size).toBe(6);

      // Verify colors are in expected order
      expect(colors).toEqual([
        '#0000FF',
        '#3300CC',
        '#660099',
        '#990066',
        '#CC0033',
        '#FF0000',
      ]);
    });

    it('should have valid hex color format for all hop levels', () => {
      const hexColorRegex = /^#[0-9A-Fa-f]{6}$/;

      for (let i = 0; i <= 10; i++) {
        expect(getHopColor(i)).toMatch(hexColorRegex);
      }

      expect(getHopColor(999)).toMatch(hexColorRegex);
    });
  });

  describe('color properties', () => {
    it('should use pure blue at 1 hop (start of gradient)', () => {
      const color = getHopColor(1);
      expect(color.toLowerCase()).toBe('#0000ff');
    });

    it('should use pure red at 6+ hops (end of gradient)', () => {
      const color = getHopColor(6);
      expect(color.toLowerCase()).toBe('#ff0000');
    });

    it('should use distinct green for local node (not in gradient)', () => {
      const localColor = getHopColor(0);
      const gradientColors = [1, 2, 3, 4, 5, 6].map(h => getHopColor(h));

      expect(gradientColors).not.toContain(localColor);
      expect(localColor).toBe('#22c55e');
    });

    it('should use distinct grey for no data (not in gradient)', () => {
      const noDataColor = getHopColor(999);
      const gradientColors = [1, 2, 3, 4, 5, 6].map(h => getHopColor(h));

      expect(gradientColors).not.toContain(noDataColor);
      expect(noDataColor).toBe('#9ca3af');
    });
  });

  describe('edge cases', () => {
    it('should handle negative hop counts as no data', () => {
      // While this shouldn't happen in practice, we should handle it gracefully
      // Negative values will not match any condition and fall through to the gradient logic
      // which will use the last color in the array
      expect(getHopColor(-1)).toBe('#FF0000');
      expect(getHopColor(-999)).toBe('#FF0000');
    });

    it('should handle very large hop counts consistently', () => {
      expect(getHopColor(1000)).toBe('#FF0000');
      expect(getHopColor(9999)).toBe('#FF0000');
    });

    it('should treat fractional hop counts (if any) by array index', () => {
      // TypeScript should prevent this, but if it happens, test behavior
      // 0.5 would become colors[0.5 - 1] = colors[-0.5] which is undefined
      // This would return the fallback (last color)
      const result = getHopColor(0.5 as number);
      expect(result).toBeDefined();
      expect(result).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });
  });

  describe('map legend compatibility', () => {
    it('should provide correct colors for all legend items', () => {
      const legendTests = [
        { hops: 0, label: 'Local Node', expectedColor: '#22c55e' },
        { hops: 1, label: '1 Hop', expectedColor: '#0000FF' },
        { hops: 2, label: '2 Hops', expectedColor: '#3300CC' },
        { hops: 3, label: '3 Hops', expectedColor: '#660099' },
        { hops: 4, label: '4 Hops', expectedColor: '#990066' },
        { hops: 5, label: '5 Hops', expectedColor: '#CC0033' },
        { hops: 6, label: '6+ Hops', expectedColor: '#FF0000' },
      ];

      legendTests.forEach(({ hops, expectedColor }) => {
        expect(getHopColor(hops)).toBe(expectedColor);
      });
    });
  });
});

describe('roleGlyphMarkerSvg', () => {
  const COLOR = '#cba6f7';

  it('returns an <svg> with a backing circle and the glyph for known categories', () => {
    for (const category of ['repeater', 'roomServer', 'sensor', 'companion'] as const) {
      const svg = roleGlyphMarkerSvg(category, COLOR, 24);
      expect(svg).toContain('<svg');
      expect(svg).toContain('viewBox="0 0 48 48"');
      expect(svg).toContain('<circle'); // white backing circle
      expect(svg).toContain(COLOR);     // glyph/stroke uses the passed color
    }
  });

  it('honors the requested size', () => {
    const svg = roleGlyphMarkerSvg('repeater', COLOR, 30);
    expect(svg).toContain('width="30"');
    expect(svg).toContain('height="30"');
  });

  it('returns empty string for standard (so callers keep their default marker)', () => {
    expect(roleGlyphMarkerSvg('standard', COLOR, 24)).toBe('');
  });

  it('renders Meshtastic role categories via their shared glyph family (issue #3610)', () => {
    // ROUTER, REPEATER and ROUTER_CLIENT share the Meshtastic tower.
    expect(roleGlyphMarkerSvg('mtRepeater', COLOR, 24)).toBe(roleGlyphMarkerSvg('mtRouter', COLOR, 24));
    expect(roleGlyphMarkerSvg('mtRouterClient', COLOR, 24)).toBe(roleGlyphMarkerSvg('mtRouter', COLOR, 24));
    // #6008: CLIENT_BASE has its own base-station glyph; SENSOR moved to a
    // corner badge, so it no longer swaps the glyph.
    expect(roleGlyphMarkerSvg('mtClientBase', COLOR, 24)).not.toBe('');
    expect(roleGlyphMarkerSvg('mtClientBase', COLOR, 24)).not.toBe(roleGlyphMarkerSvg('mtRouter', COLOR, 24));
    expect(roleGlyphMarkerSvg('mtSensor', COLOR, 24)).toBe('');
  });

  it('draws a Meshtastic ROUTER and a MeshCore Repeater with different glyphs (#5491)', () => {
    const mtRouter = roleGlyphMarkerSvg('mtRouter', COLOR, 24);
    const mcRepeater = roleGlyphMarkerSvg('repeater', COLOR, 24);
    expect(mtRouter).not.toBe('');
    expect(mcRepeater).not.toBe('');
    expect(mtRouter).not.toBe(mcRepeater);
    // The tower's mast is Meshtastic-only; ROUTER_LATE keeps it too.
    const mast = 'x="22.5" y="4" width="3" height="12"';
    expect(mtRouter).toContain(mast);
    expect(roleGlyphMarkerSvg('mtRouterLate', COLOR, 24)).toContain(mast);
    expect(mcRepeater).not.toContain(mast);
  });

  it('renders ROUTER_LATE as the tower plus a distinguishing clock badge (issue #4295)', () => {
    // ROUTER_LATE keeps the router tower but adds a clock badge, so it no
    // longer matches a plain ROUTER/repeater exactly.
    const late = roleGlyphMarkerSvg('mtRouterLate', COLOR, 24);
    expect(late).not.toBe(roleGlyphMarkerSvg('repeater', COLOR, 24));
    expect(late).toContain('x="19" y="32"'); // shared tower base
    expect(late).toContain('cx="13" cy="34"'); // clock badge
  });

  it('returns empty string for Meshtastic client-type roles (default pin)', () => {
    expect(roleGlyphMarkerSvg('mtClient', COLOR, 24)).toBe('');
    expect(roleGlyphMarkerSvg('mtTracker', COLOR, 24)).toBe('');
  });
});
