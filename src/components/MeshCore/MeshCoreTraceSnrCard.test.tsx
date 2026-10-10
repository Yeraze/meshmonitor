/**
 * MeshCoreTraceSnrCard + summarizeHopSnrLinks (#5722).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const getMock = vi.fn();
// Mocked the way the panel's own tests mock it: no ApiError export.
vi.mock('../../services/api', () => ({ default: { get: (...a: unknown[]) => getMock(...a) } }));

import { MeshCoreTraceSnrCard } from './MeshCoreTraceSnrCard';
import { summarizeHopSnrLinks, sparklinePoints, HOP_SNR_POINTS_PER_LINK, type HopSnrSample } from '../../utils/meshcoreHopSnr';

const ME = 'a'.repeat(64);
const REP = 'b'.repeat(64);
const LOCAL = 'c'.repeat(64);

const sample = (over: Partial<HopSnrSample> = {}): HopSnrSample => ({
  senderPublicKey: ME, senderHash: 'aa', senderCandidates: 1,
  receiverPublicKey: REP, receiverHash: 'bb', receiverCandidates: 1,
  snrQuarterDb: 20, initiated: false, timestamp: 1000, ...over,
});

const wrap = (children: ReactNode) => <>{children}</>;

describe('summarizeHopSnrLinks (#5722)', () => {
  it('keeps the two directions of a link apart and computes stats in dB', () => {
    const links = summarizeHopSnrLinks([
      sample({ snrQuarterDb: 20, timestamp: 1000 }),
      sample({ snrQuarterDb: -8, timestamp: 3000, initiated: true }),
      sample({ senderPublicKey: REP, senderHash: 'bb', receiverPublicKey: ME, receiverHash: 'aa', snrQuarterDb: 4, timestamp: 2000 }),
    ]);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      sender: { publicKey: ME, hash: null }, receiver: { publicKey: REP },
      count: 2, lastSnr: -2, avgSnr: 1.5, minSnr: -2, maxSnr: 5, lastTimestamp: 3000, initiatedCount: 1,
      points: [[1000, 5], [3000, -2]],
    });
    expect(links[1]).toMatchObject({ sender: { publicKey: REP }, receiver: { publicKey: ME }, count: 1, lastSnr: 1 });
  });

  it('groups unresolved ends by hash and unknown senders together', () => {
    const links = summarizeHopSnrLinks([
      sample({ senderPublicKey: null, senderHash: 'c3', senderCandidates: 2 }),
      sample({ senderPublicKey: null, senderHash: 'c3', senderCandidates: 2, timestamp: 2000 }),
      sample({ senderPublicKey: null, senderHash: null, senderCandidates: 0 }),
    ]);
    expect(links).toHaveLength(2);
    expect(links.find((l) => l.sender.hash === 'c3')).toMatchObject({ count: 2, sender: { candidates: 2 } });
    expect(links.find((l) => l.sender.hash === null && l.sender.publicKey === null)?.count).toBe(1);
  });

  it('caps the points per link', () => {
    const many = Array.from({ length: HOP_SNR_POINTS_PER_LINK + 30 }, (_, i) => sample({ timestamp: i }));
    const [link] = summarizeHopSnrLinks(many);
    expect(link.count).toBe(HOP_SNR_POINTS_PER_LINK + 30);
    expect(link.points).toHaveLength(HOP_SNR_POINTS_PER_LINK);
    expect(link.points.at(-1)![0]).toBe(HOP_SNR_POINTS_PER_LINK + 29);
  });
});

describe('sparklinePoints (#5722)', () => {
  it('maps samples into the box, and a flat series does not divide by zero', () => {
    expect(sparklinePoints([])).toBe('');
    expect(sparklinePoints([[0, 1], [1, 1]])).not.toContain('NaN');
    const pts = sparklinePoints([[0, -5], [1, 5]]).split(' ');
    expect(pts).toHaveLength(2);
    expect(Number(pts[0].split(',')[1])).toBeGreaterThan(Number(pts[1].split(',')[1])); // lower SNR draws lower
  });
});

describe('MeshCoreTraceSnrCard (#5722)', () => {
  beforeEach(() => getMock.mockReset());

  const links = summarizeHopSnrLinks([
    sample({ snrQuarterDb: 20, timestamp: Date.now() - 120_000 }),
    sample({ snrQuarterDb: 12, timestamp: Date.now() - 60_000 }),
    sample({ senderPublicKey: REP, senderHash: 'bb', receiverPublicKey: ME, receiverHash: 'aa', snrQuarterDb: -30, timestamp: Date.now() - 30_000 }),
    sample({ senderPublicKey: null, senderHash: 'c3', senderCandidates: 2, receiverPublicKey: ME, timestamp: Date.now() - 10_000 }),
    sample({ senderPublicKey: ME, receiverPublicKey: LOCAL, receiverHash: null, timestamp: Date.now() - 5_000 }),
  ]);

  it('lists each direction with names, stats and a sparkline', async () => {
    getMock.mockResolvedValue({ success: true, data: { hours: 168, links } });
    render(wrap(
      <MeshCoreTraceSnrCard sourceId="src-1" publicKey={ME} localPublicKey={LOCAL}
        contacts={[{ publicKey: REP, name: 'Hilltop Repeater' }]} />,
    ));
    const card = await screen.findByTestId('meshcore-trace-snr');
    expect(getMock).toHaveBeenCalledWith(`/api/sources/src-1/meshcore/hop-snr?publicKey=${ME}`);
    const rows = card.querySelectorAll('li');
    expect(rows).toHaveLength(4);
    const text = Array.from(rows).map((r) => r.textContent);
    // Direction is explicit: receiver "heard" sender.
    expect(text.some((x) => x?.startsWith('Hilltop Repeater heard this contact'))).toBe(true);
    expect(text.some((x) => x?.startsWith('this contact heard Hilltop Repeater') && x.includes('-7.50 dB'))).toBe(true);
    expect(text.some((x) => x?.includes('c3 (2 contacts share it)'))).toBe(true);
    expect(text.some((x) => x?.startsWith('This node heard this contact'))).toBe(true);
    // Two samples → a sparkline; one sample → none.
    expect(card.querySelectorAll('svg polyline')).toHaveLength(1);
    expect(card.querySelector('[data-direction="in"]')).not.toBeNull();
    expect(card.querySelector('[data-direction="out"]')).not.toBeNull();
  });

  it('renders nothing with no history, without the grant, or with no source', async () => {
    getMock.mockResolvedValue({ success: true, data: { hours: 168, links: [] } });
    const { unmount } = render(wrap(<MeshCoreTraceSnrCard sourceId="src-1" publicKey={ME} />));
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(screen.queryByTestId('meshcore-trace-snr')).not.toBeInTheDocument();
    unmount();

    getMock.mockReset();
    getMock.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    render(wrap(<MeshCoreTraceSnrCard sourceId="src-1" publicKey={ME} />));
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(screen.queryByTestId('meshcore-trace-snr')).not.toBeInTheDocument();

    getMock.mockReset();
    render(wrap(<MeshCoreTraceSnrCard sourceId={null} publicKey={ME} />));
    expect(getMock).not.toHaveBeenCalled();
  });
});
