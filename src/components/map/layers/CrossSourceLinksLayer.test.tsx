/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { NeighborLinkDescriptor } from './NeighborLinksLayer';
import type { CrossSourceLinkDto } from '../../../types/crossSourceLinks';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

const h = vi.hoisted(() => ({
  hookArgs: null as null | { enabled: boolean; sources: string[]; lookbackHours: number },
  data: undefined as undefined | { links: unknown[]; sinceMs: number; retentionDays: number },
  rendered: [] as unknown[],
}));

vi.mock('../../../hooks/useCrossSourceLinks', () => ({
  useCrossSourceLinks: (args: { enabled: boolean; sources: string[]; lookbackHours: number }) => {
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

import { CrossSourceLinksLayer } from './CrossSourceLinksLayer';

const link = (o: Partial<CrossSourceLinkDto> = {}): CrossSourceLinkDto => ({
  key: 'a|!a|b|!b|origin|rf', protocol: 'meshtastic', kind: 'origin', inferred: false, transportClass: 'rf',
  txSourceId: 'a', txSourceName: 'Source A', txNodeId: '!a', txName: 'Radio A',
  rxSourceId: 'b', rxSourceName: 'Source B', rxNodeId: '!b', rxName: 'Radio B',
  count: 12, snrMin: 1, snrAvg: 4.25, snrMax: 9, rssiAvg: -88.4, lastHeardAt: Date.now() - 1000,
  from: [30.1, -90.1], to: [30.2, -90.2],
  ...o,
});

beforeEach(() => {
  h.hookArgs = null;
  h.data = undefined;
  h.rendered = [];
});

describe('CrossSourceLinksLayer (#5561)', () => {
  it('renders nothing and asks the hook for nothing while disabled', () => {
    h.data = { links: [link()], sinceMs: Date.now() - 3_600_000, retentionDays: 7 };
    const { container } = render(<CrossSourceLinksLayer enabled={false} sourceIds={['a']} lookbackHours={24} />);
    expect(container).toBeEmptyDOMElement();
    expect(h.hookArgs).toMatchObject({ enabled: false });
  });

  it('passes the sources and lookback to the hook', () => {
    render(<CrossSourceLinksLayer enabled sourceIds={['a', 'b']} lookbackHours={12} />);
    expect(h.hookArgs).toEqual({ enabled: true, sources: ['a', 'b'], lookbackHours: 12 });
  });

  it('draws a directional edge: arrow tail at the transmitter, head at the hearer', () => {
    h.data = { links: [link()], sinceMs: Date.now() - 3_600_000, retentionDays: 7 };
    render(<CrossSourceLinksLayer enabled sourceIds={['a']} lookbackHours={24} />);
    const [d] = h.rendered as NeighborLinkDescriptor[];
    // NeighborLinksLayer arrows point FROM positions[1] TO positions[0].
    expect(d.positions).toEqual([[30.2, -90.2], [30.1, -90.1]]);
    expect(d.arrows).toBeDefined();
    expect(d.pathOptions.dashArray).toBeUndefined();
    expect(screen.getByText('Radio A heard by Radio B')).toBeInTheDocument();
    expect(screen.getByText('12 times')).toBeInTheDocument();
    expect(screen.getByText('RF')).toBeInTheDocument();
    expect(screen.getByText('4.3 dB (1.0 / 9.0)')).toBeInTheDocument();
    expect(screen.getByText('-88 dBm')).toBeInTheDocument();
  });

  it('a likely relay is dotted and says it is inferred', () => {
    h.data = {
      links: [link({ key: 'r', kind: 'relay', inferred: true })],
      sinceMs: Date.now() - 3_600_000, retentionDays: 7,
    };
    render(<CrossSourceLinksLayer enabled sourceIds={['a']} lookbackHours={24} />);
    expect((h.rendered as NeighborLinkDescriptor[])[0].pathOptions.dashArray).toBe('2 7');
    expect(screen.getByText('Radio A likely relayed to Radio B')).toBeInTheDocument();
    expect(screen.getByText(/Inferred from the relay hash/)).toBeInTheDocument();
  });

  it('an MQTT-gateway hearing uses the dashed gateway style', () => {
    h.data = {
      links: [link({ key: 'g', transportClass: 'mqtt_gateway', snrAvg: null, rssiAvg: null })],
      sinceMs: Date.now() - 3_600_000, retentionDays: 7,
    };
    render(<CrossSourceLinksLayer enabled sourceIds={['a']} lookbackHours={24} />);
    expect((h.rendered as NeighborLinkDescriptor[])[0].pathOptions.dashArray).toBe('10 6');
    expect(screen.getByText('MQTT gateway (RF)')).toBeInTheDocument();
  });
});
