/**
 * MeshCoreTraceSnrCard + summarizeHopSnrLinks (#5722).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const getMock = vi.fn();
const deleteMock = vi.fn();
// Mocked the way the panel's own tests mock it: no ApiError export.
vi.mock('../../services/api', () => ({
  default: { get: (...a: unknown[]) => getMock(...a), delete: (...a: unknown[]) => deleteMock(...a) },
}));

import { MeshCoreTraceSnrCard } from './MeshCoreTraceSnrCard';
import {
  summarizeHopSnrLinks, sparklinePoints, hopSnrEndParam, parseHopSnrEndParam, HOP_SNR_POINTS_PER_LINK, type HopSnrSample,
} from '../../utils/meshcoreHopSnr';

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

describe('hopSnrEndParam / parseHopSnrEndParam (#5970)', () => {
  it('round-trips the three kinds of link end', () => {
    for (const end of [{ publicKey: ME, hash: null }, { publicKey: null, hash: 'c3' }, { publicKey: null, hash: null }]) {
      expect(parseHopSnrEndParam(hopSnrEndParam(end))).toEqual(end);
    }
    // A resolved key wins over its hash, as in summarizeHopSnrLinks.
    expect(hopSnrEndParam({ publicKey: ME.toUpperCase(), hash: 'aa' })).toBe(ME);
    expect(hopSnrEndParam({ publicKey: null, hash: 'C3' })).toBe('h:c3');
    expect(hopSnrEndParam({ publicKey: null, hash: null })).toBe('unknown');
  });

  it('rejects anything else', () => {
    for (const v of [undefined, '', 'zz', `${ME}0`, 'h:', 'h:abc', 'h:zz', 'h:0123456789', 'Unknown', [ME]]) {
      expect(parseHopSnrEndParam(v)).toBeNull();
    }
    expect(parseHopSnrEndParam('h:abcd1234')).toEqual({ publicKey: null, hash: 'abcd1234' });
  });
});

describe('MeshCoreTraceSnrCard clear one link (#5970)', () => {
  const base = `/api/sources/src-1/meshcore/hop-snr`;
  const now = Date.now();
  const outbound = sample({ snrQuarterDb: 20, timestamp: now - 120_000 });
  const reverse = sample({ senderPublicKey: REP, senderHash: 'bb', receiverPublicKey: ME, receiverHash: 'aa', timestamp: now - 60_000 });
  const hashed = sample({ senderPublicKey: null, senderHash: 'c3', senderCandidates: 2, receiverPublicKey: ME, timestamp: now - 30_000 });
  const all = summarizeHopSnrLinks([outbound, sample({ timestamp: now - 90_000 }), reverse, hashed]);
  const contacts = [{ publicKey: REP, name: 'Hilltop Repeater' }];
  const clearLabel = (receiver: string, sender: string) => `Clear history: ${receiver} heard ${sender}`;

  beforeEach(() => {
    getMock.mockReset();
    deleteMock.mockReset();
    getMock.mockResolvedValue({ success: true, data: { hours: 168, links: all } });
  });

  it('hides the clear buttons without traceroute:write', async () => {
    render(wrap(<MeshCoreTraceSnrCard sourceId="src-1" publicKey={ME} contacts={contacts} />));
    await screen.findByTestId('meshcore-trace-snr');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows one clear button per graph, each in its own row', async () => {
    render(wrap(<MeshCoreTraceSnrCard sourceId="src-1" publicKey={ME} contacts={contacts} canClear />));
    const card = await screen.findByTestId('meshcore-trace-snr');
    const rows = card.querySelectorAll('li');
    expect(rows).toHaveLength(3);
    rows.forEach((r) => expect(r.querySelectorAll('button')).toHaveLength(1));
    expect(screen.getByRole('button', { name: clearLabel('Hilltop Repeater', 'this contact') })).toHaveAttribute(
      'title', clearLabel('Hilltop Repeater', 'this contact'));
    expect(screen.getByRole('button', { name: clearLabel('this contact', 'Hilltop Repeater') })).toBeInTheDocument();
  });

  it('confirms naming the link, deletes only that link, then reloads and tells siblings', async () => {
    const onCleared = vi.fn();
    deleteMock.mockResolvedValue({ success: true, data: { deleted: 2 } });
    render(wrap(<MeshCoreTraceSnrCard sourceId="src-1" publicKey={ME.toUpperCase()} contacts={contacts} canClear onCleared={onCleared} />));
    fireEvent.click(await screen.findByRole('button', { name: clearLabel('Hilltop Repeater', 'this contact') }));
    expect(deleteMock).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent("Clear this link's trace SNR history?");
    expect(dialog).toHaveTextContent('where Hilltop Repeater heard this contact');

    getMock.mockResolvedValue({ success: true, data: { hours: 168, links: summarizeHopSnrLinks([reverse, hashed]) } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(`${base}?from=${ME}&to=${REP}`));
    expect(deleteMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(onCleared).toHaveBeenCalledTimes(1);
    // The other two graphs remain.
    await waitFor(() => expect(screen.getByTestId('meshcore-trace-snr').querySelectorAll('li')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: clearLabel('Hilltop Repeater', 'this contact') })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: clearLabel('this contact', 'Hilltop Repeater') })).toBeInTheDocument();
  });

  it('sends a hash end as h:<hash>', async () => {
    deleteMock.mockResolvedValue({ success: true, data: { deleted: 1 } });
    render(wrap(<MeshCoreTraceSnrCard sourceId="src-1" publicKey={ME} contacts={contacts} canClear />));
    fireEvent.click(await screen.findByRole('button', { name: clearLabel('this contact', 'c3 (2 contacts share it)') }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(`${base}?from=h%3Ac3&to=${ME}`));
  });

  it('cancel closes the dialog and does nothing', async () => {
    const onCleared = vi.fn();
    render(wrap(<MeshCoreTraceSnrCard sourceId="src-1" publicKey={ME} contacts={contacts} canClear onCleared={onCleared} />));
    fireEvent.click(await screen.findByRole('button', { name: clearLabel('Hilltop Repeater', 'this contact') }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('meshcore-trace-snr').querySelectorAll('li')).toHaveLength(3);
  });

  it('a failed delete shows an error and keeps the chart', async () => {
    const onCleared = vi.fn();
    deleteMock.mockRejectedValue(Object.assign(new Error('nope'), { status: 500 }));
    render(wrap(<MeshCoreTraceSnrCard sourceId="src-1" publicKey={ME} contacts={contacts} canClear onCleared={onCleared} />));
    fireEvent.click(await screen.findByRole('button', { name: clearLabel('Hilltop Repeater', 'this contact') }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear history' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not clear the trace SNR history.');
    expect(onCleared).not.toHaveBeenCalled();
    expect(screen.getByTestId('meshcore-trace-snr').querySelectorAll('li')).toHaveLength(3);
  });
});
