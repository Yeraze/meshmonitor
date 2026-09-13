/**
 * Packet Distribution card header on a phone (#5195).
 *
 * The header was `display: flex` with `justify-content: space-between` and no
 * wrap. A flex item will not shrink below its min-content width, so on a phone
 * the three-button time-range group was clipped by the card edge with "All
 * Data" unreachable — no tap target, no scroll to reach it.
 *
 * These are inline styles on JSX, and jsdom has no layout engine, so the source
 * is asserted directly the way TelemetryGraphs.layout.test.ts guards #5093.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const infoTab = readFileSync(join(here, 'InfoTab.tsx'), 'utf8');
const appCss = readFileSync(join(here, '../App.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const statsChart = readFileSync(join(here, 'PacketStatsChart.tsx'), 'utf8');

/** The `style={{ … }}` object literal opening the Packet Distribution header. */
const headerStyle = (): string => {
  const anchor = infoTab.indexOf("t('info.packet_distribution'");
  expect(anchor, 'Packet Distribution heading not found').toBeGreaterThan(-1);
  // The header row is the flex container opened just above the <h3>.
  const before = infoTab.slice(0, anchor);
  const start = before.lastIndexOf("<div style={{ display: 'flex', justifyContent: 'space-between'");
  expect(start, 'Packet Distribution header row not found').toBeGreaterThan(-1);
  return before.slice(start, before.indexOf('>', start));
};

describe('Packet Distribution header (#5195)', () => {
  it('wraps the header row so the time-range group drops to its own line', () => {
    expect(headerStyle()).toMatch(/flexWrap:\s*'wrap'/);
  });

  it('wraps the time-range button group itself', () => {
    const group = /const timeRangeButtons = \([\s\S]*?<div style=\{\{([^}]*)\}\}/.exec(infoTab);
    expect(group, 'timeRangeButtons container not found').not.toBeNull();
    expect(group![1]).toMatch(/flexWrap:\s*'wrap'/);
  });
});

describe('Packet Distribution donut cards (#5195)', () => {
  it('zeroes the grid track floor with minmax(0, 1fr), not bare 1fr', () => {
    const rule = /\.packet-distribution-grid\s*\{([^}]*)\}/.exec(appCss);
    expect(rule, '.packet-distribution-grid rule not found').not.toBeNull();
    // Bare `1fr` is `minmax(auto, 1fr)` and keeps a min-content floor, which is
    // what let a long-node-name legend push the row past the viewport.
    expect(rule![1]).toMatch(/minmax\(\s*0\s*,\s*1fr\s*\)/);
  });

  it('lets the donut tooltip overhang its 140px chart box instead of clipping', () => {
    // `CKL MeshNet - Lindsay East : 23 (` was cut mid-value by the card.
    expect(statsChart).toMatch(/allowEscapeViewBox=\{\{\s*x:\s*true/);
    expect(statsChart).toMatch(/whiteSpace:\s*'normal'/);
    // `overflow: hidden` on the card is what clipped it; `minWidth: 0` gives the
    // same grid shrink without clipping children (#5093).
    expect(statsChart).not.toMatch(/style=\{\{\s*overflow:\s*'hidden'\s*\}\}/);
  });
});
