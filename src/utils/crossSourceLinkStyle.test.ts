import { describe, it, expect } from 'vitest';
import {
  crossSourceLinkStyle,
  tracerouteConfirmedLinkStyle,
  CROSS_SOURCE_LINK_COLOR_RF,
  CROSS_SOURCE_LINK_COLOR_GATEWAY,
  TRACEROUTE_CONFIRMED_LINK_COLORS,
  TRACEROUTE_CONFIRMED_ARROW_FRACTIONS,
} from './crossSourceLinkStyle';

const NOW = 1_000_000_000;
const WINDOW = 24 * 3_600_000;
const link = (o: Record<string, unknown> = {}) =>
  ({ kind: 'origin', transportClass: 'rf', count: 1, lastHeardAt: NOW, ...o }) as any;

describe('crossSourceLinkStyle (#5561)', () => {
  it('RF origin is solid in the RF colour', () => {
    const s = crossSourceLinkStyle(link(), NOW, WINDOW);
    expect(s.color).toBe(CROSS_SOURCE_LINK_COLOR_RF);
    expect(s.dashArray).toBeUndefined();
    expect(s.dash3d).toBeUndefined();
  });

  it('an MQTT-gateway hearing is dashed in its own colour', () => {
    const s = crossSourceLinkStyle(link({ transportClass: 'mqtt_gateway' }), NOW, WINDOW);
    expect(s.color).toBe(CROSS_SOURCE_LINK_COLOR_GATEWAY);
    expect(s.dashArray).toBe('10 6');
  });

  it('a likely relay is dotted, distinct from the gateway dash', () => {
    const s = crossSourceLinkStyle(link({ kind: 'relay' }), NOW, WINDOW);
    expect(s.dashArray).toBe('2 7');
    expect(crossSourceLinkStyle(link({ kind: 'relay', transportClass: 'mqtt_gateway' }), NOW, WINDOW).dashArray).toBe('2 7');
  });

  it('width grows with the count and is capped', () => {
    const w = (count: number) => crossSourceLinkStyle(link({ count }), NOW, WINDOW).weight;
    expect(w(1)).toBe(2);
    expect(w(10)).toBeCloseTo(3.5);
    expect(w(100)).toBeCloseTo(5);
    expect(w(1_000_000)).toBe(6);
    expect(w(0)).toBe(2);
  });

  it('opacity fades with age across the window', () => {
    const o = (age: number) => crossSourceLinkStyle(link({ lastHeardAt: NOW - age }), NOW, WINDOW).opacity;
    expect(o(0)).toBeCloseTo(0.9);
    expect(o(WINDOW)).toBeCloseTo(0.35);
    expect(o(WINDOW * 5)).toBeCloseTo(0.35);
    expect(o(WINDOW / 2)).toBeCloseTo(0.625);
  });
});

describe('tracerouteConfirmedLinkStyle (#5580)', () => {
  const confirmed = (o: Record<string, unknown> = {}) =>
    ({ transportClass: 'rf', count: 1, lastConfirmedAt: NOW, ...o }) as any;

  it('is double-headed and dash-dot, a pattern no one-way edge uses', () => {
    const s = tracerouteConfirmedLinkStyle(confirmed(), NOW, WINDOW);
    expect(s.doubleHeaded).toBe(true);
    expect(s.dashArray).toBe('12 5 2 5');
    expect(s.dash3d).toEqual([4, 1.5, 0.6, 1.5]);
    const oneWay = [
      crossSourceLinkStyle(link(), NOW, WINDOW),
      crossSourceLinkStyle(link({ transportClass: 'mqtt_gateway' }), NOW, WINDOW),
      crossSourceLinkStyle(link({ kind: 'relay' }), NOW, WINDOW),
    ];
    for (const o of oneWay) expect(o.dashArray).not.toBe(s.dashArray);
  });

  it('has one colour per transport class, none shared with the one-way edges', () => {
    const colors = (['rf', 'mqtt', 'udp'] as const).map(
      (transportClass) => tracerouteConfirmedLinkStyle(confirmed({ transportClass }), NOW, WINDOW).color,
    );
    expect(colors).toEqual([
      TRACEROUTE_CONFIRMED_LINK_COLORS.rf, TRACEROUTE_CONFIRMED_LINK_COLORS.mqtt, TRACEROUTE_CONFIRMED_LINK_COLORS.udp,
    ]);
    expect(new Set(colors).size).toBe(3);
    for (const c of colors) expect([CROSS_SOURCE_LINK_COLOR_RF, CROSS_SOURCE_LINK_COLOR_GATEWAY]).not.toContain(c);
  });

  it('width grows with the run count and is capped; opacity fades with age', () => {
    const w = (count: number) => tracerouteConfirmedLinkStyle(confirmed({ count }), NOW, WINDOW).weight;
    expect(w(1)).toBe(2.5);
    expect(w(10)).toBeCloseTo(4);
    expect(w(1_000_000)).toBe(6);
    const fresh = tracerouteConfirmedLinkStyle(confirmed(), NOW, WINDOW).opacity;
    const old = tracerouteConfirmedLinkStyle(confirmed({ lastConfirmedAt: NOW - WINDOW }), NOW, WINDOW).opacity;
    expect(fresh).toBeCloseTo(0.95);
    expect(old).toBeCloseTo(0.45);
  });

  it('puts one arrowhead near each end', () => {
    expect(TRACEROUTE_CONFIRMED_ARROW_FRACTIONS.towardNeighbor).toBeGreaterThan(0.5);
    expect(TRACEROUTE_CONFIRMED_ARROW_FRACTIONS.towardLocal).toBeLessThan(0.5);
  });
});

