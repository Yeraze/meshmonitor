import { describe, it, expect } from 'vitest';
import {
  crossSourceLinkStyle,
  CROSS_SOURCE_LINK_COLOR_RF,
  CROSS_SOURCE_LINK_COLOR_GATEWAY,
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
