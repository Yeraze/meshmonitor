/**
 * @vitest-environment jsdom
 *
 * CoverageSummaryPanel (#5277 Phase 4a WP3, spec §2a.6/§3). Presentational
 * only — every number comes in as a prop from WP1's pure functions
 * (`coverageSummary.ts` / `coverageGaps.ts`), so these tests build fixture
 * `CoverageSummary` / `CoverageGapResult` objects directly rather than
 * importing WP1 (owned by a parallel work package, not yet merged into this
 * worktree — see COVERAGE_P4_SPEC.md §4).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      if (typeof fallback === 'string') {
        const vars = (opts ?? {}) as Record<string, unknown>;
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
      }
      return _key;
    },
  }),
}));

import { CoverageSummaryPanel } from './CoverageSummaryPanel';
import type { CoverageSummary, CoverageGapResult } from '../../types/coverageAnalysis';
import type { CoverageReceiverDto } from '../../types/coverage';

function summary(overrides: Partial<CoverageSummary> = {}): CoverageSummary {
  return {
    fixesHeard: 42,
    receptions: 120,
    bestSnr: 9.5,
    worstSnr: -18.25,
    bestRssi: -60,
    worstRssi: -118,
    receivers: [],
    distancePoints: [],
    ...overrides,
  };
}

function gapResult(overrides: Partial<CoverageGapResult> = {}): CoverageGapResult {
  return {
    intervalSec: 30,
    intervalSource: 'observed',
    gaps: [],
    breaks: 0,
    heard: 42,
    expected: 50,
    ...overrides,
  };
}

function receiverDto(overrides: Partial<CoverageReceiverDto> = {}): CoverageReceiverDto {
  return {
    sourceId: 'src-a',
    sourceName: 'Source A',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aaaaaaaa',
    receiverNodeNum: 1,
    longName: 'Receiver One',
    shortName: 'R1',
    latitude: 26.1,
    longitude: -80.2,
    lastReceivedAt: 1000,
    receptionCount: 10,
    ...overrides,
  };
}

describe('CoverageSummaryPanel', () => {
  it('always shows the sender-independent tiles', () => {
    render(
      <CoverageSummaryPanel
        summary={summary()}
        gapResult={null}
        receivers={[]}
        distanceUnit="km"
        truncated={false}
      />,
    );
    expect(screen.getByText('42')).toBeInTheDocument(); // plain fixesHeard, no gapResult
    expect(screen.getByText('120')).toBeInTheDocument(); // receptions
    expect(screen.getByText('9.5 dB')).toBeInTheDocument(); // best SNR
    expect(screen.getByText('-18.3 dB')).toBeInTheDocument(); // worst SNR (toFixed(1))
    expect(screen.getByText('-60 dBm')).toBeInTheDocument(); // best RSSI
    expect(screen.getByText('-118 dBm')).toBeInTheDocument(); // worst RSSI
  });

  it('shows the pick-a-sender hint and hides gap tiles when gapResult is null', () => {
    render(
      <CoverageSummaryPanel
        summary={summary()}
        gapResult={null}
        receivers={[]}
        distanceUnit="km"
        truncated={false}
      />,
    );
    expect(screen.getByText('Pick one sender to see gaps and expected fixes.')).toBeInTheDocument();
    expect(screen.queryByText('Likely gaps')).not.toBeInTheDocument();
  });

  it('shows heard-of-expected, interval and gap count when gapResult is present', () => {
    render(
      <CoverageSummaryPanel
        summary={summary()}
        gapResult={gapResult({ gaps: [{} as never, {} as never], heard: 42, expected: 50, intervalSec: 30, intervalSource: 'observed' })}
        receivers={[]}
        distanceUnit="km"
        truncated={false}
      />,
    );
    expect(screen.getByText('42 of 50 expected (84%)')).toBeInTheDocument();
    expect(screen.getByText('Interval 30 s (observed)')).toBeInTheDocument();
    expect(screen.getByText('Likely gaps')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('Pick one sender to see gaps and expected fixes.')).not.toBeInTheDocument();
  });

  it('labels the interval source via the configured/observed/default keys', () => {
    render(
      <CoverageSummaryPanel
        summary={summary()}
        gapResult={gapResult({ intervalSource: 'configured', intervalSec: 60 })}
        receivers={[]}
        distanceUnit="km"
        truncated={false}
      />,
    );
    expect(screen.getByText('Interval 60 s (configured)')).toBeInTheDocument();
  });

  it('shows the truncated note using the reception count when truncated', () => {
    render(
      <CoverageSummaryPanel
        summary={summary({ receptions: 10000 })}
        gapResult={null}
        receivers={[]}
        distanceUnit="km"
        truncated
      />,
    );
    expect(
      screen.getByText((_, node) => node?.textContent === 'Showing the first 10000 receptions in this window — narrow the time range or pick a sender to see the rest.'),
    ).toBeInTheDocument();
  });

  it('does not show the truncated note when not truncated', () => {
    render(
      <CoverageSummaryPanel
        summary={summary()}
        gapResult={null}
        receivers={[]}
        distanceUnit="km"
        truncated={false}
      />,
    );
    expect(screen.queryByText(/narrow the time range/)).not.toBeInTheDocument();
  });

  it('renders no per-receiver table when there are no receiver stats', () => {
    render(
      <CoverageSummaryPanel
        summary={summary()}
        gapResult={null}
        receivers={[]}
        distanceUnit="km"
        truncated={false}
      />,
    );
    expect(screen.queryByText('Receivers')).not.toBeInTheDocument();
  });

  it('renders per-receiver rows resolving name/source via the receivers prop', () => {
    const stat = {
      key: 'src-a|!aaaaaaaa',
      sourceId: 'src-a',
      receiverId: '!aaaaaaaa',
      receiverKind: 'local' as const,
      fixesHeard: 12,
      medianSnr: 4.25,
      furthestDirectM: 5300,
    };
    render(
      <CoverageSummaryPanel
        summary={summary({ receivers: [stat] })}
        gapResult={null}
        receivers={[receiverDto()]}
        distanceUnit="km"
        truncated={false}
      />,
    );
    expect(screen.getByText('Receivers')).toBeInTheDocument();
    expect(screen.getByText('Receiver One')).toBeInTheDocument();
    expect(screen.getByText('Source A')).toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('4.3 dB')).toBeInTheDocument();
    expect(screen.getByText('5.3 km')).toBeInTheDocument();
  });

  it('labels a MeshCore mqtt_gateway row Observer, and a Meshtastic one Gateway', () => {
    const gatewayStat = {
      key: 'src-a|!aaaaaaaa',
      sourceId: 'src-a',
      receiverId: '!aaaaaaaa',
      receiverKind: 'mqtt_gateway' as const,
      fixesHeard: 3,
      medianSnr: null,
      furthestDirectM: null,
    };
    const observerStat = {
      key: 'src-b|abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
      sourceId: 'src-b',
      receiverId: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
      receiverKind: 'mqtt_gateway' as const,
      fixesHeard: 7,
      medianSnr: null,
      furthestDirectM: null,
    };
    render(
      <CoverageSummaryPanel
        summary={summary({ receivers: [gatewayStat, observerStat] })}
        gapResult={null}
        receivers={[
          receiverDto({ sourceId: 'src-a', receiverId: '!aaaaaaaa', protocol: 'meshtastic', receiverKind: 'mqtt_gateway' }),
          receiverDto({
            sourceId: 'src-b',
            receiverId: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
            protocol: 'meshcore',
            receiverKind: 'mqtt_gateway',
            longName: 'Observer One',
          }),
        ]}
        distanceUnit="km"
        truncated={false}
      />,
    );
    expect(screen.getByText('Gateway')).toBeInTheDocument();
    expect(screen.getByText('Observer')).toBeInTheDocument();
  });

  it('shows an em dash for null median SNR / furthest direct, and formats furthest in miles', () => {
    const stat = {
      key: 'src-a|!aaaaaaaa',
      sourceId: 'src-a',
      receiverId: '!aaaaaaaa',
      receiverKind: 'local' as const,
      fixesHeard: 1,
      medianSnr: null,
      furthestDirectM: 1609.34,
    };
    render(
      <CoverageSummaryPanel
        summary={summary({ receivers: [stat] })}
        gapResult={null}
        receivers={[receiverDto()]}
        distanceUnit="mi"
        truncated={false}
      />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('1.0 mi')).toBeInTheDocument();
  });

  it('falls back to the formatted node id when no receiver dto matches', () => {
    const stat = {
      key: 'src-z|!deadbeef',
      sourceId: 'src-z',
      receiverId: '!deadbeef',
      receiverKind: 'local' as const,
      fixesHeard: 1,
      medianSnr: null,
      furthestDirectM: null,
    };
    render(
      <CoverageSummaryPanel
        summary={summary({ receivers: [stat] })}
        gapResult={null}
        receivers={[]}
        distanceUnit="km"
        truncated={false}
      />,
    );
    expect(screen.getByText('!deadbeef')).toBeInTheDocument();
    expect(screen.getByText('src-z')).toBeInTheDocument();
  });
});
