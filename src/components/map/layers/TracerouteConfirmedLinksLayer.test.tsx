/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { NeighborLinkDescriptor } from './NeighborLinksLayer';
import type { TracerouteConfirmedLinkDto, TracerouteConfirmedLinksResponse } from '../../../types/crossSourceLinks';
import {
  TRACEROUTE_CONFIRMED_LINK_COLORS,
  CROSS_SOURCE_LINK_COLOR_RF,
  CROSS_SOURCE_LINK_COLOR_GATEWAY,
} from '../../../utils/crossSourceLinkStyle';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

const h = vi.hoisted(() => ({
  hookArgs: null as null | { enabled: boolean; sources: string[]; lookbackHours: number },
  data: undefined as undefined | TracerouteConfirmedLinksResponse,
  rendered: [] as unknown[],
}));

vi.mock('../../../hooks/useTracerouteConfirmedLinks', () => ({
  useTracerouteConfirmedLinks: (args: { enabled: boolean; sources: string[]; lookbackHours: number }) => {
    h.hookArgs = args;
    return { data: args.enabled ? h.data : undefined };
  },
}));

vi.mock('./NeighborLinksLayer', () => ({
  NeighborLinksLayer: ({ links }: { links: NeighborLinkDescriptor[] }) => {
    h.rendered = links;
    return (
      <div data-testid="links">
        {links.map((l) => (
          <div key={l.key} data-testid="link">{l.children}</div>
        ))}
      </div>
    );
  },
}));

vi.mock('react-leaflet', () => ({
  Popup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { TracerouteConfirmedLinksLayer } from './TracerouteConfirmedLinksLayer';

const link = (o: Partial<TracerouteConfirmedLinkDto> = {}): TracerouteConfirmedLinkDto => ({
  key: 'a|!01|!02|rf', sourceId: 'a', sourceName: 'Source A',
  localNodeNum: 1, localNodeId: '!00000001', localName: 'SKYB',
  neighborNodeNum: 2, neighborNodeId: '!00000002', neighborName: 'PARC',
  transportClass: 'rf', count: 4, directCount: 3, snrOutAvg: -8.25, snrBackAvg: -11.3,
  lastConfirmedAt: Date.now() - 1000,
  from: [30.1, -90.1], to: [30.2, -90.2],
  ...o,
});

const response = (links: TracerouteConfirmedLinkDto[]): TracerouteConfirmedLinksResponse => ({
  links, sinceMs: Date.now() - 3_600_000, truncated: false, historyLimitPerPair: 50,
});

beforeEach(() => {
  h.hookArgs = null;
  h.data = undefined;
  h.rendered = [];
});

describe('TracerouteConfirmedLinksLayer (#5580)', () => {
  it('renders nothing and asks the hook for nothing while disabled', () => {
    h.data = response([link()]);
    const { container } = render(<TracerouteConfirmedLinksLayer enabled={false} sourceIds={['a']} lookbackHours={24} />);
    expect(container).toBeEmptyDOMElement();
    expect(h.hookArgs).toMatchObject({ enabled: false });
  });

  it('passes the sources and lookback to the hook', () => {
    render(<TracerouteConfirmedLinksLayer enabled sourceIds={['a', 'b']} lookbackHours={12} />);
    expect(h.hookArgs).toEqual({ enabled: true, sources: ['a', 'b'], lookbackHours: 12 });
  });

  it('renders nothing when there are no confirmed links', () => {
    h.data = response([]);
    const { container } = render(<TracerouteConfirmedLinksLayer enabled sourceIds={['a']} lookbackHours={24} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws a double-headed line: one arrowhead toward each end', () => {
    h.data = response([link()]);
    render(<TracerouteConfirmedLinksLayer enabled sourceIds={['a']} lookbackHours={24} />);
    const [d] = h.rendered as NeighborLinkDescriptor[];
    // Our radio is positions[1], the neighbour positions[0].
    expect(d.positions).toEqual([[30.2, -90.2], [30.1, -90.1]]);
    expect(d.arrows?.fractions).toEqual([0.8]);
    expect(d.arrows?.reverseFractions).toEqual([0.2]);
    expect(d.className).toBe('traceroute-confirmed-link');
    expect(d.key).toBe('trc-a|!01|!02|rf');
  });

  it('uses a style no one-way "heard here" edge uses', () => {
    h.data = response([link()]);
    render(<TracerouteConfirmedLinksLayer enabled sourceIds={['a']} lookbackHours={24} />);
    const [d] = h.rendered as NeighborLinkDescriptor[];
    expect(d.pathOptions.dashArray).toBe('12 5 2 5');
    expect(['2 7', '10 6', undefined]).not.toContain(d.pathOptions.dashArray);
    expect(d.pathOptions.color).toBe(TRACEROUTE_CONFIRMED_LINK_COLORS.rf);
    expect([CROSS_SOURCE_LINK_COLOR_RF, CROSS_SOURCE_LINK_COLOR_GATEWAY]).not.toContain(d.pathOptions.color);
  });

  it('colours each transport class apart', () => {
    h.data = response([
      link({ key: 'rf' }),
      link({ key: 'mqtt', transportClass: 'mqtt' }),
      link({ key: 'udp', transportClass: 'udp' }),
    ]);
    render(<TracerouteConfirmedLinksLayer enabled sourceIds={['a']} lookbackHours={24} />);
    const colors = (h.rendered as NeighborLinkDescriptor[]).map((d) => d.pathOptions.color);
    expect(new Set(colors).size).toBe(3);
    expect(screen.getByText('RF')).toBeInTheDocument();
    expect(screen.getByText('MQTT')).toBeInTheDocument();
    expect(screen.getByText('UDP')).toBeInTheDocument();
  });

  it('the popup names both ends, the transport, the SNR each way and the run count', () => {
    h.data = response([link()]);
    render(<TracerouteConfirmedLinksLayer enabled sourceIds={['a']} lookbackHours={24} />);
    expect(screen.getByTestId('traceroute-confirmed-link-popup')).toBeInTheDocument();
    expect(screen.getByText('SKYB and PARC hear each other')).toBeInTheDocument();
    expect(screen.getByText('Source A')).toBeInTheDocument();
    expect(screen.getByText('PARC hears SKYB')).toBeInTheDocument();
    expect(screen.getByText('-8.3 dB')).toBeInTheDocument();
    expect(screen.getByText('SKYB hears PARC')).toBeInTheDocument();
    expect(screen.getByText('-11.3 dB')).toBeInTheDocument();
    expect(screen.getByText('4 (3 direct)')).toBeInTheDocument();
    // The retention caveat is stated where the count is read.
    expect(screen.getByText('Only the newest 50 traceroutes per node pair are kept.')).toBeInTheDocument();
  });

  it('says so when a direction has no SNR sample, and falls back to node ids for names', () => {
    h.data = response([link({ snrOutAvg: null, localName: null, neighborName: null })]);
    render(<TracerouteConfirmedLinksLayer enabled sourceIds={['a']} lookbackHours={24} />);
    expect(screen.getByText('!00000001 and !00000002 hear each other')).toBeInTheDocument();
    expect(screen.getByText('not reported')).toBeInTheDocument();
    expect(screen.getByText('-11.3 dB')).toBeInTheDocument();
  });
});
