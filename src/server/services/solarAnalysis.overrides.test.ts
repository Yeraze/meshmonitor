/**
 * identifySolarNodes manual overrides (#3195).
 *
 * The motivating case: a node whose panel and battery far outsize its load sits
 * near full all day, shows no charge/discharge cycle, and is never detected.
 */
import { describe, it, expect } from 'vitest';
import { identifySolarNodes, type SolarTelemetryRow } from './solarAnalysis.js';

const HOUR = 3_600_000;
const DAY0 = Date.UTC(2026, 5, 1);

/** A textbook solar day: overnight low, daytime charge to a peak, evening fall. */
function solarDay(nodeNum: number, dayIndex: number): SolarTelemetryRow[] {
  const base = DAY0 + dayIndex * 24 * HOUR;
  const curve: Array<[number, number]> = [
    [2, 55], [5, 50], [7, 52], [9, 65], [11, 80], [13, 92], [15, 95], [17, 90], [19, 80], [21, 70], [23, 62],
  ];
  return curve.map(([h, v]) => ({ nodeNum, telemetryType: 'batteryLevel', timestamp: base + h * HOUR, value: v }));
}

/** An over-specced node: pinned at 100% around the clock, no cycle to detect. */
function flatDay(nodeNum: number, dayIndex: number): SolarTelemetryRow[] {
  const base = DAY0 + dayIndex * 24 * HOUR;
  return [1, 5, 9, 13, 17, 21].map((h) => ({ nodeNum, telemetryType: 'batteryLevel', timestamp: base + h * HOUR, value: 100 }));
}

const SOLAR = 0x11111111;
const FLAT = 0x22222222;
const SILENT = 0x33333333;

const rows = [
  ...[0, 1, 2, 3, 4].flatMap((d) => solarDay(SOLAR, d)),
  ...[0, 1, 2, 3, 4].flatMap((d) => flatDay(FLAT, d)),
];
const names = [
  { nodeNum: SOLAR, longName: 'Sunny' },
  { nodeNum: FLAT, longName: 'Oversized' },
  { nodeNum: SILENT, longName: 'Quiet' },
];

describe('identifySolarNodes manual overrides (#3195)', () => {
  it('without overrides, detects the cycling node and misses the flat one', () => {
    const result = identifySolarNodes(rows, names, 7);
    const detected = result.solar_nodes.map((n) => n.node_num);
    expect(detected).toContain(SOLAR);
    expect(detected).not.toContain(FLAT);
    expect(result.solar_nodes.every((n) => n.manual_override === false)).toBe(true);
  });

  it('reports a node marked solar even though the detector found no pattern', () => {
    const result = identifySolarNodes(rows, names, 7, new Map([[FLAT, true]]));
    const flat = result.solar_nodes.find((n) => n.node_num === FLAT);
    expect(flat).toBeDefined();
    expect(flat!.manual_override).toBe(true);
    expect(flat!.node_name).toBe('Oversized');
    expect(flat!.solar_score).toBe(0);
    expect(flat!.metric_type).toBe('batteryLevel');
    // The card still charts what the node reported.
    expect(flat!.chart_data.length).toBeGreaterThan(0);
  });

  it('excludes a node marked not solar even though the detector matched it', () => {
    const result = identifySolarNodes(rows, names, 7, new Map([[SOLAR, false]]));
    expect(result.solar_nodes.map((n) => n.node_num)).not.toContain(SOLAR);
    expect(result.solar_nodes_count).toBe(result.solar_nodes.length);
  });

  it('flags a detected node the operator also marked solar, keeping its real score', () => {
    const plain = identifySolarNodes(rows, names, 7).solar_nodes.find((n) => n.node_num === SOLAR)!;
    const marked = identifySolarNodes(rows, names, 7, new Map([[SOLAR, true]])).solar_nodes.find((n) => n.node_num === SOLAR)!;
    expect(marked.manual_override).toBe(true);
    expect(marked.solar_score).toBe(plain.solar_score);
  });

  it('lists a node marked solar that has no telemetry in the window, with an empty chart', () => {
    const result = identifySolarNodes(rows, names, 7, new Map([[SILENT, true]]));
    const quiet = result.solar_nodes.find((n) => n.node_num === SILENT);
    expect(quiet).toBeDefined();
    expect(quiet!.chart_data).toEqual([]);
    expect(quiet!.days_analyzed).toBe(0);
  });

  it('exposes every node with telemetry as a picker candidate, named and sorted', () => {
    const result = identifySolarNodes(rows, names, 7);
    expect(result.analyzed_nodes).toEqual([
      { node_num: FLAT, node_name: 'Oversized' },
      { node_num: SOLAR, node_name: 'Sunny' },
    ]);
  });
});
