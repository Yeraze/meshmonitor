/**
 * @vitest-environment jsdom
 *
 * Trace Path map card (#6260 WP4): live result wins, a stored trace is the
 * fallback, and the map hides when any hop has no position.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MeshCoreTracePathMap } from './MeshCoreTracePathMap';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';
import api from '../../services/api';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/SettingsContext', () => ({ useSettings: () => ({}) }));
vi.mock('../../services/api', () => ({ default: { get: vi.fn() } }));

const flow = vi.fn();
vi.mock('../map/RouteFlowMap', () => ({
  RouteFlowMap: (p: { points: { label: string }[]; segments: { avgSnr: number | null }[] }) => {
    flow(p);
    return <div data-testid="flow">{p.points.map((x) => x.label).join('|')}</div>;
  },
}));

const K_LOCAL = '1'.repeat(64);
const K_R1 = 'aa' + '1'.repeat(62);
const K_R2 = 'bb' + '2'.repeat(62);
const K_TARGET = 'cc' + '3'.repeat(62);

const local: MeshCoreContact = { publicKey: K_LOCAL, advName: 'Me', advType: 1, isLocal: true, latitude: 30, longitude: -90 };
const r1: MeshCoreContact = { publicKey: K_R1, advName: 'Relay One', advType: 2, latitude: 30.1, longitude: -90.1 };
const r2: MeshCoreContact = { publicKey: K_R2, advName: 'Relay Two', advType: 2, latitude: 30.2, longitude: -90.2 };
const target: MeshCoreContact = { publicKey: K_TARGET, advName: 'Target', advType: 1, latitude: 30.3, longitude: -90.3 };

const props = (over: Partial<React.ComponentProps<typeof MeshCoreTracePathMap>> = {}) => ({
  sourceId: 'src', contact: target, contacts: [local, r1, r2, target], traceResult: null, ...over,
});

describe('MeshCoreTracePathMap', () => {
  beforeEach(() => {
    flow.mockClear();
    vi.mocked(api.get).mockReset();
    vi.mocked(api.get).mockResolvedValue({ data: { trace: null } });
  });

  it('draws the live result: local -> hops -> contact, with per-hop SNR', async () => {
    render(<MeshCoreTracePathMap {...props({
      traceResult: { hops: [{ index: 0, snr: 6 }, { index: 1, snr: -3 }], lastSnr: 2, path: ['aa', 'bb'] },
    })} />);
    expect((await screen.findByTestId('flow')).textContent).toBe('You|#1 Relay One|#2 Relay Two|Target');
    const last = flow.mock.calls[flow.mock.calls.length - 1][0];
    expect(last.segments.map((s: { avgSnr: number | null }) => s.avgSnr)).toEqual([6, -3, null]);
  });

  it('falls back to the stored trace when there is no live result', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: { trace: { hops: [
        { hopIndex: 0, receiverHash: 'aa', snr: 4 },
        { hopIndex: 1, receiverHash: 'bb', snr: 1 },
        { hopIndex: 2, receiverHash: null, snr: 9 },
      ] } },
    });
    render(<MeshCoreTracePathMap {...props()} />);
    expect((await screen.findByTestId('flow')).textContent).toContain('#2 Relay Two');
    expect(vi.mocked(api.get).mock.calls[0][0]).toContain(`/api/sources/src/meshcore/hop-snr/latest-trace?publicKey=${K_TARGET}`);
  });

  it('hides the map when a hop has no position', async () => {
    const noPos: MeshCoreContact = { ...r2, latitude: undefined, longitude: undefined };
    const { container } = render(<MeshCoreTracePathMap {...props({
      contacts: [local, r1, noPos, target],
      traceResult: { hops: [{ index: 0, snr: 6 }, { index: 1, snr: -3 }], lastSnr: 2, path: ['aa', 'bb'] },
    })} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByTestId('flow')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when there is no stored trace and no live result', async () => {
    const { container } = render(<MeshCoreTracePathMap {...props()} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });
});
