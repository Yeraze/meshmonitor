/**
 * @vitest-environment jsdom
 *
 * Node detail "Direct RF" section (#6210).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// `get` records calls; `failNext` makes the client throw. The spy itself never
// throws or rejects: vitest reports a spy-tracked rejection as unhandled
// (see NetworkSurveyPanel.test.tsx).
const get = vi.fn();
let failNext = false;
vi.mock('../services/api', () => ({
  default: {
    get: async (...a: unknown[]) => {
      const res = get(...a);
      if (failNext) throw new Error('Forbidden');
      return res;
    },
    setBaseUrl: vi.fn(),
  },
}));
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('./icons', () => ({ UiIcon: ({ name }: { name: string }) => <i data-icon={name} /> }));

import { DirectRfSection } from './DirectRfSection';

const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY) * DAY;

beforeEach(() => {
  get.mockReset();
  failNext = false;
});

describe('DirectRfSection', () => {
  it('renders nothing without a source or a node key, and makes no request', () => {
    const { container } = render(<DirectRfSection sourceId={null} nodeKey="!aaaaaaaa" />);
    expect(container.innerHTML).toBe('');
    render(<DirectRfSection sourceId="src-a" nodeKey={null} />);
    expect(get).not.toHaveBeenCalled();
  });

  it('requests the node endpoint for the last 30 days with a lowercased key', async () => {
    get.mockResolvedValue({ success: true, data: { summary: null, daily: [], retentionDays: 30 } });
    render(<DirectRfSection sourceId="src a" nodeKey={'AB'.repeat(32)} />);
    await screen.findByTestId('direct-rf-section-empty');
    const url = get.mock.calls[0][0] as string;
    expect(url).toMatch(new RegExp(`^/api/sources/src%20a/direct-rf-contacts/node/${'ab'.repeat(32)}\\?from=\\d+&to=\\d+$`));
    const [, from, to] = /from=(\d+)&to=(\d+)/.exec(url)!.map(Number);
    expect(to - from).toBe(30 * DAY);
  });

  it('shows last/first heard, count, best SNR and one bar per day', async () => {
    get.mockResolvedValue({
      success: true,
      data: {
        retentionDays: 30,
        summary: {
          nodeKey: '!aaaaaaaa', nodeNum: 1, protocol: 'meshtastic', name: null, shortName: null,
          firstHeardAt: today - 2 * DAY, lastHeardAt: today + 1000, receptionCount: 7, daysHeard: 2,
          bestSnr: 9.5, avgSnr: 5, bestRssi: -70, avgRssi: -80, distanceKm: null,
        },
        daily: [
          { dayBucket: today - 2 * DAY, receptionCount: 3, firstHeardAt: 0, lastHeardAt: 0, bestSnr: 9.5, bestRssi: -70 },
          { dayBucket: today, receptionCount: 4, firstHeardAt: 0, lastHeardAt: 0, bestSnr: 2, bestRssi: -75 },
        ],
      },
    });
    render(<DirectRfSection sourceId="src-a" nodeKey="!aaaaaaaa" />);
    expect((await screen.findByTestId('direct-rf-count')).textContent).toBe('7');
    expect(screen.getByTestId('direct-rf-best-snr').textContent).toBe('9.5 dB');
    const bars = screen.getByTestId('direct-rf-spark').querySelectorAll('rect');
    expect(bars).toHaveLength(30);
    expect(bars[29].querySelector('title')!.textContent).toBe('4');
    expect(bars[27].querySelector('title')!.textContent).toBe('3');
  });

  it('renders nothing when the request fails (no nodes:read)', async () => {
    failNext = true;
    const { container } = render(<DirectRfSection sourceId="src-a" nodeKey="!aaaaaaaa" />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});
