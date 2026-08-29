/**
 * meshIssueTypes — pure helper unit tests (#4964 Phase 3 WP4).
 *
 * `formatDurationMs` and `coverageNotes` are pure functions with no React
 * dependency; this file exercises them directly (no rendering, no DOM), as
 * the spec's test plan calls for, complementing the rendering-level
 * assertions in `MeshIssuesReport.test.tsx`.
 */
import { describe, it, expect } from 'vitest';
import { coverageNotes, formatDurationMs, type MeshIssuesCoverageWire } from './meshIssueTypes';

describe('formatDurationMs', () => {
  it('renders "just now" for zero', () => {
    expect(formatDurationMs(0)).toBe('just now');
  });

  it('renders an em dash for a negative value', () => {
    expect(formatDurationMs(-1)).toBe('—');
    expect(formatDurationMs(-3_600_000)).toBe('—');
  });

  it('renders an em dash for NaN and other non-finite values', () => {
    expect(formatDurationMs(NaN)).toBe('—');
    expect(formatDurationMs(Infinity)).toBe('—');
    expect(formatDurationMs(-Infinity)).toBe('—');
  });

  it('stays "just now" right up to the minute boundary, then switches to "1 minute" at exactly 60_000ms', () => {
    expect(formatDurationMs(59_999)).toBe('just now');
    expect(formatDurationMs(60_000)).toBe('1 minute');
  });

  it('formats whole minutes, singular and plural', () => {
    expect(formatDurationMs(60_000)).toBe('1 minute');
    expect(formatDurationMs(2 * 60_000)).toBe('2 minutes');
    expect(formatDurationMs(17 * 60_000)).toBe('17 minutes');
  });

  it('rounds to the nearest minute rather than truncating', () => {
    // 17 min 20s -> 17.33 minutes -> rounds to 17.
    expect(formatDurationMs(17 * 60_000 + 20_000)).toBe('17 minutes');
    // 17 min 40s -> 17.67 minutes -> rounds to 18.
    expect(formatDurationMs(17 * 60_000 + 40_000)).toBe('18 minutes');
  });

  it('stays in minutes right up to the hour boundary, then switches to hours at exactly 60 minutes', () => {
    expect(formatDurationMs(59 * 60_000)).toBe('59 minutes');
    expect(formatDurationMs(60 * 60_000)).toBe('1 hour');
  });

  it('formats whole hours, singular and plural', () => {
    expect(formatDurationMs(3_600_000)).toBe('1 hour');
    expect(formatDurationMs(3 * 3_600_000)).toBe('3 hours');
    expect(formatDurationMs(23 * 3_600_000)).toBe('23 hours');
  });

  it('stays in hours right up to the day boundary, then switches to days at exactly 24 hours', () => {
    expect(formatDurationMs(23 * 3_600_000)).toBe('23 hours');
    expect(formatDurationMs(24 * 3_600_000)).toBe('1 day');
  });

  it('formats whole days, singular and plural', () => {
    expect(formatDurationMs(86_400_000)).toBe('1 day');
    expect(formatDurationMs(6 * 86_400_000)).toBe('6 days');
  });

  it('stays in days right up to the week boundary, then switches to weeks at exactly 7 days', () => {
    expect(formatDurationMs(6 * 86_400_000)).toBe('6 days');
    expect(formatDurationMs(7 * 86_400_000)).toBe('1 week');
  });

  it('formats whole weeks, singular and plural, with no upper bound', () => {
    expect(formatDurationMs(7 * 86_400_000)).toBe('1 week');
    expect(formatDurationMs(3 * 7 * 86_400_000)).toBe('3 weeks');
    expect(formatDurationMs(52 * 7 * 86_400_000)).toBe('52 weeks');
  });
});

describe('coverageNotes', () => {
  /** Fully-available coverage — every evidence class present, no rule
   * skipped, no sentinel hops dropped. `coverageNotes` must return []. */
  function fullyAvailableCoverage(overrides: Partial<MeshIssuesCoverageWire> = {}): MeshIssuesCoverageWire {
    return {
      evidence: { neighborInfo: true, traceroute: true, mqttGateway: true, packetLog: true },
      neighborInfoRowCount: 10,
      neighborInfoEdgeCount: 20,
      tracerouteEdgeCount: 30,
      tracerouteSentinelHopsDropped: 0,
      gatewayCount: 3,
      gatewayDirectEdgeCount: 5,
      gatewayCoReceptionEdgeCount: 2,
      gatewayCellsSkipped: 0,
      directEdgeCount: 10,
      totalEdgeCount: 15,
      graphNodeCount: 40,
      snrDirectionsWithMinSamples: 5,
      hopHorizonSource: 'packet_log',
      hopHorizonNodeCount: 8,
      skippedRules: [],
      ...overrides,
    };
  }

  it('returns an empty array when coverage is fully available', () => {
    expect(coverageNotes(fullyAvailableCoverage())).toEqual([]);
  });

  it('notes missing traceroute evidence for B1/B4/B5/B7', () => {
    const notes = coverageNotes(
      fullyAvailableCoverage({ evidence: { neighborInfo: true, traceroute: false, mqttGateway: true, packetLog: true } }),
    );
    expect(notes).toContainEqual({
      rule: 'B1, B4, B5, B7',
      note: 'needs traceroutes; none were collected in the window',
      severity: 'blocked',
    });
  });

  it('notes zero directional SNR samples for B3', () => {
    const notes = coverageNotes(fullyAvailableCoverage({ snrDirectionsWithMinSamples: 0 }));
    expect(notes).toContainEqual({
      rule: 'B3',
      note: 'needs traceroutes or the MQTT packet log: no link has 3 or more SNR samples in one direction',
      severity: 'blocked',
    });
  });

  it('notes a null hop-horizon source for B6', () => {
    const notes = coverageNotes(fullyAvailableCoverage({ hopHorizonSource: null }));
    expect(notes).toContainEqual({
      rule: 'B6',
      note: 'needs a packet monitor: enable the Meshtastic packet log or the MQTT packet log',
      severity: 'blocked',
    });
  });

  it('notes the MQTT packet log being off for B3/B7 as a hint', () => {
    const notes = coverageNotes(
      fullyAvailableCoverage({ evidence: { neighborInfo: true, traceroute: true, mqttGateway: false, packetLog: true } }),
    );
    expect(notes).toContainEqual({
      rule: 'B3, B7',
      note: 'the MQTT packet log is off, so gateway receptions are not contributing RF evidence',
      severity: 'hint',
    });
  });

  it('notes the Meshtastic packet log being off for B6 as blocked', () => {
    const notes = coverageNotes(
      fullyAvailableCoverage({ evidence: { neighborInfo: true, traceroute: true, mqttGateway: true, packetLog: false } }),
    );
    expect(notes).toContainEqual({
      rule: 'B6',
      note: 'the Meshtastic packet log is off',
      severity: 'blocked',
    });
  });

  it('surfaces each skipped rule verbatim, one note per entry', () => {
    const notes = coverageNotes(
      fullyAvailableCoverage({
        skippedRules: [
          { rule: 'B2', reason: 'insufficient neighbor data' },
          { rule: 'B5', reason: 'no area had enough corpus samples' },
        ],
      }),
    );
    expect(notes).toContainEqual({ rule: 'B2', note: 'insufficient neighbor data', severity: 'blocked' });
    expect(notes).toContainEqual({ rule: 'B5', note: 'no area had enough corpus samples', severity: 'blocked' });
  });

  it('notes dropped sentinel hops for B1-B5 as a hint, with the real count interpolated', () => {
    const notes = coverageNotes(fullyAvailableCoverage({ tracerouteSentinelHopsDropped: 7 }));
    expect(notes).toContainEqual({
      rule: 'B1-B5',
      note: '7 traceroute hops were dropped as MQTT-injected (SNR sentinel)',
      severity: 'hint',
    });
  });

  it('omits the sentinel-hops note when the count is zero', () => {
    const notes = coverageNotes(fullyAvailableCoverage({ tracerouteSentinelHopsDropped: 0 }));
    expect(notes.some((n) => n.rule === 'B1-B5')).toBe(false);
  });

  it('returns every applicable note together when multiple flags are degraded at once', () => {
    const notes = coverageNotes(
      fullyAvailableCoverage({
        evidence: { neighborInfo: true, traceroute: false, mqttGateway: false, packetLog: false },
        snrDirectionsWithMinSamples: 0,
        hopHorizonSource: null,
        tracerouteSentinelHopsDropped: 3,
        skippedRules: [{ rule: 'B4', reason: 'no idle-router candidates' }],
      }),
    );
    // One note per degraded condition: traceroute, B3 SNR, B6 hop-horizon,
    // mqttGateway hint, packetLog, the B4 skip, and the sentinel-hops hint.
    expect(notes).toHaveLength(7);
    expect(notes.map((n) => n.rule)).toEqual([
      'B1, B4, B5, B7',
      'B3',
      'B6',
      'B3, B7',
      'B6',
      'B4',
      'B1-B5',
    ]);
  });
});
