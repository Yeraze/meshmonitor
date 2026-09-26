/**
 * @vitest-environment jsdom
 *
 * CoverageExportButtons (#5277 Phase 4a WP3, spec §2a.4/§2a.6/§3). This
 * component owns no export logic — it calls WP1's pure builders
 * (`src/utils/coverageExport.ts`, owned by a parallel work package) and
 * `downloadTextFile` (`src/utils/nodeExport.ts`). Both are mocked so this
 * file tests only the wiring: which builder runs for which button, what
 * filename/mime it downloads with, and the disabled/tooltip states.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

const buildCoverageCsv = vi.fn(() => 'csv-content');
const buildCoverageGeoJson = vi.fn(() => 'geojson-content');
const coverageExportFilename = vi.fn(
  (ext: string, senderId: string | null, sinceMs: number, untilMs: number) =>
    `coverage-${senderId ?? 'all'}-${sinceMs}-${untilMs}.${ext}`,
);
vi.mock('../../utils/coverageExport', () => ({
  buildCoverageCsv: (...args: unknown[]) => buildCoverageCsv(...(args as [never, never])),
  buildCoverageGeoJson: (...args: unknown[]) => buildCoverageGeoJson(...(args as [never, never])),
  coverageExportFilename: (...args: unknown[]) =>
    coverageExportFilename(...(args as [string, string | null, number, number])),
}));

const downloadTextFile = vi.fn();
vi.mock('../../utils/nodeExport', () => ({
  downloadTextFile: (...args: unknown[]) => downloadTextFile(...(args as [string, string, string])),
}));

import { CoverageExportButtons } from './CoverageExportButtons';
import type { CoverageReceptionDto } from '../../types/coverage';
import type { CoverageExportContext, CoverageGap } from '../../types/coverageAnalysis';

function ctx(overrides: Partial<CoverageExportContext> = {}): CoverageExportContext {
  return {
    senderNames: new Map(),
    receiverNames: new Map(),
    sourceNames: new Map(),
    truncated: false,
    generatedAt: 1234,
    filters: {},
    ...overrides,
  };
}

function reception(id: number): CoverageReceptionDto {
  return {
    id,
    sourceId: 'src-a',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aaaaaaaa',
    receiverNodeNum: 1,
    receiverLatitude: 26.1,
    receiverLongitude: -80.2,
    senderId: '!bbbbbbbb',
    senderNodeNum: 2,
    packetKey: `pk-${id}`,
    packetId: id,
    pathKey: 'direct',
    latitude: 26.2,
    longitude: -80.3,
    altitude: null,
    precisionBits: null,
    snr: 4.5,
    rssi: -80,
    hopStart: 3,
    hopLimit: 3,
    hopsAway: 0,
    relayNode: null,
    transportMechanism: null,
    channel: 0,
    rxTime: 1700000000,
    receivedAt: 1700000000000,
  };
}

const gaps: CoverageGap[] = [];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CoverageExportButtons', () => {
  it('disables both buttons when items is empty', () => {
    render(
      <CoverageExportButtons items={[]} gaps={gaps} ctx={ctx()} senderId={null} sinceMs={0} untilMs={1} disabled={false} />,
    );
    expect(screen.getByText('CSV').closest('button')).toBeDisabled();
    expect(screen.getByText('GeoJSON').closest('button')).toBeDisabled();
  });

  it('disables both buttons when disabled=true even with items present', () => {
    render(
      <CoverageExportButtons
        items={[reception(1)]}
        gaps={gaps}
        ctx={ctx()}
        senderId={null}
        sinceMs={0}
        untilMs={1}
        disabled
      />,
    );
    expect(screen.getByText('CSV').closest('button')).toBeDisabled();
    expect(screen.getByText('GeoJSON').closest('button')).toBeDisabled();
  });

  it('enables both buttons with items and disabled=false', () => {
    render(
      <CoverageExportButtons
        items={[reception(1)]}
        gaps={gaps}
        ctx={ctx()}
        senderId="!bbbbbbbb"
        sinceMs={100}
        untilMs={200}
        disabled={false}
      />,
    );
    expect(screen.getByText('CSV').closest('button')).toBeEnabled();
    expect(screen.getByText('GeoJSON').closest('button')).toBeEnabled();
  });

  it('CSV button builds via buildCoverageCsv and downloads with text/csv', () => {
    const items = [reception(1), reception(2)];
    const c = ctx();
    render(
      <CoverageExportButtons items={items} gaps={gaps} ctx={c} senderId="!bbbbbbbb" sinceMs={100} untilMs={200} disabled={false} />,
    );
    fireEvent.click(screen.getByText('CSV'));
    expect(buildCoverageCsv).toHaveBeenCalledWith(items, c);
    expect(downloadTextFile).toHaveBeenCalledWith('coverage-!bbbbbbbb-100-200.csv', 'csv-content', 'text/csv');
  });

  it('GeoJSON button builds via buildCoverageGeoJson with gaps merged into ctx, downloads application/geo+json', () => {
    const items = [reception(1)];
    const c = ctx();
    const someGaps: CoverageGap[] = [
      {
        from: { packetKey: 'pk-1', firstReceivedAt: 1, latitude: 1, longitude: 1 },
        to: { packetKey: 'pk-2', firstReceivedAt: 2, latitude: 2, longitude: 2 },
        durationSec: 100,
        distanceM: 500,
        missedEstimate: 2,
      },
    ];
    render(
      <CoverageExportButtons
        items={items}
        gaps={someGaps}
        ctx={c}
        senderId={null}
        sinceMs={0}
        untilMs={1}
        disabled={false}
      />,
    );
    fireEvent.click(screen.getByText('GeoJSON'));
    expect(buildCoverageGeoJson).toHaveBeenCalledWith(items, { ...c, gaps: someGaps });
    expect(downloadTextFile).toHaveBeenCalledWith(
      'coverage-all-0-1.geojson',
      'geojson-content',
      'application/geo+json',
    );
  });

  it('shows the truncated tooltip on both buttons when ctx.truncated is true', () => {
    render(
      <CoverageExportButtons
        items={[reception(1), reception(2)]}
        gaps={gaps}
        ctx={ctx({ truncated: true })}
        senderId={null}
        sinceMs={0}
        untilMs={1}
        disabled={false}
      />,
    );
    expect(screen.getByText('CSV').closest('button')).toHaveAttribute(
      'title',
      'Exports the first 2 receptions loaded.',
    );
    expect(screen.getByText('GeoJSON').closest('button')).toHaveAttribute(
      'title',
      'Exports the first 2 receptions loaded.',
    );
  });

  it('has no tooltip when ctx.truncated is false', () => {
    render(
      <CoverageExportButtons
        items={[reception(1)]}
        gaps={gaps}
        ctx={ctx({ truncated: false })}
        senderId={null}
        sinceMs={0}
        untilMs={1}
        disabled={false}
      />,
    );
    expect(screen.getByText('CSV').closest('button')).not.toHaveAttribute('title');
  });
});
