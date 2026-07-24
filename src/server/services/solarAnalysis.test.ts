/**
 * solarAnalysis — node display-name resolution.
 *
 * Regression coverage for the multi-source name-clobber bug: the analysis
 * routes pass one NodeNameLookup entry per (node, source), and a source that
 * never received a node's NodeInfo contributes a blank row. The old map
 * builder did an unconditional set per row, so a blank row iterated after a
 * named one replaced the real name with the `!hexid` fallback (seen live as
 * "!20bb30bb" instead of its long name in the Solar Monitoring report).
 */
import { describe, it, expect } from 'vitest';
import {
  buildNodeNameMap,
  identifySolarNodes,
  type NodeNameLookup,
  type SolarTelemetryRow,
} from './solarAnalysis.js';

const NODE = 0x20bb30bb; // 549138619
const HEX_FALLBACK = '!20bb30bb';

describe('buildNodeNameMap', () => {
  it('a blank row from another source does not clobber an earlier named row', () => {
    const map = buildNodeNameMap([
      { nodeNum: NODE, longName: 'Parrish Creekside Commons', shortName: 'PCSC' },
      { nodeNum: NODE, longName: null, shortName: null },
    ]);
    expect(map.get(NODE)).toBe('Parrish Creekside Commons');
  });

  it('a blank row iterated before the named row does not win either', () => {
    const map = buildNodeNameMap([
      { nodeNum: NODE, longName: null, shortName: null },
      { nodeNum: NODE, longName: 'Parrish Creekside Commons', shortName: 'PCSC' },
    ]);
    expect(map.get(NODE)).toBe('Parrish Creekside Commons');
  });

  it('empty-string names count as blank, matching real MQTT rows', () => {
    const map = buildNodeNameMap([
      { nodeNum: NODE, longName: 'Named', shortName: 'NM' },
      { nodeNum: NODE, longName: '', shortName: '' },
    ]);
    expect(map.get(NODE)).toBe('Named');
  });

  it('prefers a longName from a later source over an earlier shortName-only row', () => {
    const map = buildNodeNameMap([
      { nodeNum: NODE, longName: null, shortName: 'PCSC' },
      { nodeNum: NODE, longName: 'Parrish Creekside Commons', shortName: null },
    ]);
    expect(map.get(NODE)).toBe('Parrish Creekside Commons');
  });

  it('falls back to shortName when no source has a longName', () => {
    const map = buildNodeNameMap([
      { nodeNum: NODE, longName: null, shortName: null },
      { nodeNum: NODE, longName: '', shortName: 'PCSC' },
    ]);
    expect(map.get(NODE)).toBe('PCSC');
  });

  it('leaves genuinely nameless nodes out of the map (hex fallback happens downstream)', () => {
    const map = buildNodeNameMap([
      { nodeNum: NODE, longName: null, shortName: null },
      { nodeNum: NODE, longName: '', shortName: '' },
    ]);
    expect(map.has(NODE)).toBe(false);
  });

  it('first named row wins within a tier (no later-row churn)', () => {
    const map = buildNodeNameMap([
      { nodeNum: NODE, longName: 'First Long', shortName: null },
      { nodeNum: NODE, longName: 'Second Long', shortName: null },
    ]);
    expect(map.get(NODE)).toBe('First Long');
  });
});

/**
 * Hourly batteryLevel rows tracing a clear solar day in UTC: overnight
 * discharge, morning low inside 06:00–10:00, charge to an afternoon peak
 * inside 12:00–18:00, then evening decline. Variance far exceeds the 10%
 * battery threshold.
 */
function solarDayRows(nodeNum: number, dayStartMs: number): SolarTelemetryRow[] {
  const byHour = [
    55, 52, 49, 46, 43, 41, // 00–05 overnight discharge
    39, 37, 36, 38,         // 06–09 morning low (min 36 @ 08:00)
    48, 60, 70, 80, 88,     // 10–14 charging
    90, 89, 86,             // 15–17 afternoon peak (max 90 @ 15:00)
    78, 72, 68, 64, 60, 57, // 18–23 evening decline
  ];
  return byHour.map((value, hour) => ({
    nodeNum,
    telemetryType: 'batteryLevel',
    timestamp: dayStartMs + hour * 3600_000,
    value,
  }));
}

describe('identifySolarNodes — node_name resolution', () => {
  const day0 = Date.UTC(2026, 6, 20);
  const rows: SolarTelemetryRow[] = [0, 1, 2].flatMap((d) =>
    solarDayRows(NODE, day0 + d * 24 * 3600_000),
  );

  it('uses the cross-source name even when a blank source row comes last', () => {
    const nodes: NodeNameLookup[] = [
      { nodeNum: NODE, longName: 'Parrish Creekside Commons', shortName: 'PCSC' },
      { nodeNum: NODE, longName: '', shortName: '' }, // e.g. Official MQTT
    ];
    const result = identifySolarNodes(rows, nodes, 3);
    expect(result.solar_nodes.length).toBeGreaterThan(0);
    const candidate = result.solar_nodes.find((n) => n.node_num === NODE);
    expect(candidate).toBeDefined();
    expect(candidate!.node_name).toBe('Parrish Creekside Commons');
  });

  it('falls back to the hex id only when no source knows a name', () => {
    const nodes: NodeNameLookup[] = [
      { nodeNum: NODE, longName: null, shortName: null },
    ];
    const result = identifySolarNodes(rows, nodes, 3);
    const candidate = result.solar_nodes.find((n) => n.node_num === NODE);
    expect(candidate).toBeDefined();
    expect(candidate!.node_name).toBe(HEX_FALLBACK);
  });
});
