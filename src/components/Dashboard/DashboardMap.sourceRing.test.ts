// @vitest-environment jsdom
/**
 * DashboardMap — per-source node ring helpers (#6125).
 *
 * Exercises the two pure helpers the marker memo wires together: the ring
 * colour resolver and the divIcon wrapper. Covers the issue's acceptance
 * points — the built icon HTML carries the source-colour ring when the toggle
 * is on in a unified context, and nothing when it is off, and the iconSig
 * ingredient differs between the two states so the icon is rebuilt.
 */
import { describe, it, expect } from 'vitest';
import { nodeSourceRingColor, nodeGatewayRingColor, applyNodeSourceRing } from './nodeSourceRing';
import { createNodeIcon } from '../map/markerIcons';
import { getSourceColor } from '../../utils/sourceColors';

const SOURCES = ['src-a', 'src-b', 'src-c'];
const GATEWAYS = ['!gw000001', '!gw000002', '!gw000003'];

describe('nodeSourceRingColor (#6125)', () => {
  it('returns the source colour when the toggle is on in a unified context', () => {
    const color = nodeSourceRingColor(true, true, 'src-b', SOURCES);
    expect(color).toBe(getSourceColor('src-b', SOURCES));
    expect(color).toMatch(/^var\(--chart-\d\)$/);
  });

  it('returns null when the toggle is off', () => {
    expect(nodeSourceRingColor(false, true, 'src-b', SOURCES)).toBeNull();
  });

  it('returns null outside the unified (cross-source) map', () => {
    expect(nodeSourceRingColor(true, false, 'src-b', SOURCES)).toBeNull();
  });

  it('returns null when the node has no source', () => {
    expect(nodeSourceRingColor(true, true, null, SOURCES)).toBeNull();
    expect(nodeSourceRingColor(true, true, undefined, SOURCES)).toBeNull();
  });

  it('coerces a numeric source id to match the string source list', () => {
    expect(nodeSourceRingColor(true, true, 1 as unknown as string, ['0', '1', '2'])).toBe(
      getSourceColor('1', ['0', '1', '2']),
    );
  });

  it('feeds a distinct iconSig ingredient between on and off', () => {
    const on = nodeSourceRingColor(true, true, 'src-a', SOURCES) ?? '';
    const off = nodeSourceRingColor(false, true, 'src-a', SOURCES) ?? '';
    // The memo appends this fragment to iconSig; on/off must differ so the
    // layer rebuilds the icon when the toggle flips.
    expect(on).not.toBe(off);
  });
});

describe('nodeGatewayRingColor (#6175)', () => {
  it('returns the gateway colour (most-recent gateway) when the mode is on in a unified context', () => {
    const gateways = [
      { gatewayId: '!gw000001', lastHeard: 100 },
      { gatewayId: '!gw000002', lastHeard: 500 },
    ];
    const color = nodeGatewayRingColor(true, true, gateways, GATEWAYS);
    // Most-recent gateway is gw000002 (lastHeard 500).
    expect(color).toBe(getSourceColor('!gw000002', GATEWAYS));
    expect(color).toMatch(/^var\(--chart-\d\)$/);
  });

  it('rings a single-gateway node by that gateway', () => {
    const color = nodeGatewayRingColor(true, true, [{ gatewayId: '!gw000003', lastHeard: 1 }], GATEWAYS);
    expect(color).toBe(getSourceColor('!gw000003', GATEWAYS));
  });

  it('returns null when the mode is off', () => {
    expect(nodeGatewayRingColor(false, true, [{ gatewayId: '!gw000001', lastHeard: 1 }], GATEWAYS)).toBeNull();
  });

  it('returns null outside the unified (cross-source) map', () => {
    expect(nodeGatewayRingColor(true, false, [{ gatewayId: '!gw000001', lastHeard: 1 }], GATEWAYS)).toBeNull();
  });

  it('returns null when the node has no gateways (null/empty no-op)', () => {
    expect(nodeGatewayRingColor(true, true, null, GATEWAYS)).toBeNull();
    expect(nodeGatewayRingColor(true, true, undefined, GATEWAYS)).toBeNull();
    expect(nodeGatewayRingColor(true, true, [], GATEWAYS)).toBeNull();
  });

  it('feeds a distinct iconSig ingredient between on and off', () => {
    const g = [{ gatewayId: '!gw000001', lastHeard: 1 }];
    const on = nodeGatewayRingColor(true, true, g, GATEWAYS) ?? '';
    const off = nodeGatewayRingColor(false, true, g, GATEWAYS) ?? '';
    expect(on).not.toBe(off);
  });
});

describe('applyNodeSourceRing (#6125)', () => {
  const baseOpts = { variant: 'meshtastic' as const, hops: 2, shortName: 'AB', showLabel: true };

  it('wraps the divIcon html in a box-shadow ring in the source colour when on', () => {
    const color = getSourceColor('src-a', SOURCES);
    const icon = applyNodeSourceRing(createNodeIcon(baseOpts), color);
    const html = String(icon.options.html);

    expect(html).toContain('node-source-ring');
    expect(html).toContain(`box-shadow: 0 0 0 3px ${color}`);
  });

  it('leaves the icon html untouched when the ring colour is null (toggle off)', () => {
    const plain = createNodeIcon(baseOpts);
    const plainHtml = String(plain.options.html);
    const icon = applyNodeSourceRing(createNodeIcon(baseOpts), null);

    expect(String(icon.options.html)).toBe(plainHtml);
    expect(String(icon.options.html)).not.toContain('node-source-ring');
  });

  it('keeps the original marker markup (role glyph / label) inside the ring', () => {
    const color = getSourceColor('src-a', SOURCES);
    const plainHtml = String(createNodeIcon(baseOpts).options.html);
    const ringedHtml = String(applyNodeSourceRing(createNodeIcon(baseOpts), color).options.html);

    // The ring is additive: the entire original html is still present within it.
    expect(ringedHtml).toContain(plainHtml);
  });
});
