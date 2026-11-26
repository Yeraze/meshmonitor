/**
 * @vitest-environment jsdom
 *
 * Walkabout map panel (#5891 P2): chips, session override, refresh.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WalkaboutSessionDto } from '../../types/walkabout';

const stub = vi.fn();
vi.mock('./walkaboutHexMapLazy', () => ({
  WalkaboutHexMapLazy: (props: unknown) => {
    stub(props);
    return <div data-testid="hex-map-stub" />;
  },
}));
const hasPermission = vi.fn((_r: string, _a: string, _o?: { sourceId?: string }) => false);
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission }),
}));
const apiGet = vi.fn(async (_url: string): Promise<Record<string, string>> => ({}));
const apiPost = vi.fn(async (_url: string, _body: unknown) => ({ success: true }));
vi.mock('../../services/api', () => ({
  default: {
    get: (url: string) => apiGet(url),
    post: (url: string, body: unknown) => apiPost(url, body),
  },
}));
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import WalkaboutMapPanel from './WalkaboutMapPanel';

const sess = (id: string, name: string): WalkaboutSessionDto => ({
  id, sourceId: 'a', name, startedAt: 1_700_000_000_000, endedAt: 1_700_000_060_000,
  endsAt: 1_700_007_000_000, isLive: false, endReason: 'user', startedByMe: true,
  sampleCount: 1, receptionCount: 1, nodeCount: 1, lastSampleAt: null,
});
const SESSIONS = [sess('s1', 'Loop'), sess('s2', 'Hill')];

function setup(selected: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(qc, 'invalidateQueries');
  const onSelect = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <WalkaboutMapPanel sourceId="a" sessions={SESSIONS} selectedSessionId={selected} onSelectSession={onSelect} />
    </QueryClientProvider>,
  );
  return { spy, onSelect };
}
const last = () => stub.mock.calls[stub.mock.calls.length - 1][0];

beforeEach(() => {
  stub.mockClear();
  hasPermission.mockReset().mockReturnValue(false);
  apiGet.mockReset().mockResolvedValue({});
  apiPost.mockReset().mockResolvedValue({ success: true });
});

describe('WalkaboutMapPanel', () => {
  it('defaults to the 7d window', () => {
    setup();
    expect(last()).toEqual({
      sourceId: 'a',
      query: { kind: 'window', window: '7d' },
      fitKey: 'a|window|7d',
      snrBands: { strong: 0, medium: -5, weak: -10 },
    });
  });

  it('a chip changes the query and clears the session', () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByTestId('walkabout-window-30d'));
    expect(last().query).toEqual({ kind: 'window', window: '30d' });
    expect(last().fitKey).toBe('a|window|30d');
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('a selected session overrides the chips', () => {
    setup('s2');
    expect(last().query).toEqual({ kind: 'session', sessionId: 's2' });
    expect(last().fitKey).toBe('a|session|s2');
  });

  it('the session select reports the pick', () => {
    const { onSelect } = setup();
    fireEvent.change(screen.getByTestId('walkabout-map-session'), { target: { value: 's1' } });
    expect(onSelect).toHaveBeenCalledWith('s1');
  });

  it('an unknown session id falls back to window mode', () => {
    setup('gone');
    expect(last().query.kind).toBe('window');
  });

  it('Refresh invalidates cells and track for the source', () => {
    const { spy } = setup();
    fireEvent.click(screen.getByTestId('walkabout-map-refresh'));
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(['walkabout', 'a', 'cells']);
    expect(keys).toContainEqual(['walkabout', 'a', 'track']);
  });

  describe('SNR bands (#6571)', () => {
    it('passes the source\'s stored bands to the map', async () => {
      apiGet.mockResolvedValue({ walkaboutSnrBands: '-10,-15,-20' });
      setup();
      await waitFor(() => expect(last().snrBands).toEqual({ strong: -10, medium: -15, weak: -20 }));
      expect(apiGet).toHaveBeenCalledWith('/api/settings?sourceId=a');
    });

    it('falls back to the defaults on a bad stored value', async () => {
      apiGet.mockResolvedValue({ walkaboutSnrBands: '0,0,0' });
      setup();
      await waitFor(() => expect(apiGet).toHaveBeenCalled());
      expect(last().snrBands).toEqual({ strong: 0, medium: -5, weak: -10 });
    });

    it('hides the editor without settings:write on the source', () => {
      setup();
      expect(screen.queryByTestId('walkabout-snr-bands-editor')).toBeNull();
      expect(hasPermission).toHaveBeenCalledWith('settings', 'write', { sourceId: 'a' });
    });

    it('validates edges and saves them for the source', async () => {
      hasPermission.mockReturnValue(true);
      setup();
      const save = screen.getByTestId('walkabout-snr-bands-save') as HTMLButtonElement;
      expect(save.disabled).toBe(true); // not dirty

      fireEvent.change(screen.getByTestId('walkabout-snr-band-medium'), { target: { value: '1' } });
      expect(screen.getByTestId('walkabout-snr-bands-error').textContent).toMatch(/go down/);
      expect(save.disabled).toBe(true);

      fireEvent.change(screen.getByTestId('walkabout-snr-band-strong'), { target: { value: '-10' } });
      fireEvent.change(screen.getByTestId('walkabout-snr-band-medium'), { target: { value: '-15' } });
      fireEvent.change(screen.getByTestId('walkabout-snr-band-weak'), { target: { value: '-31' } });
      expect(screen.getByTestId('walkabout-snr-bands-error').textContent).toMatch(/between -30 and 20/);

      fireEvent.change(screen.getByTestId('walkabout-snr-band-weak'), { target: { value: '-20' } });
      expect(screen.queryByTestId('walkabout-snr-bands-error')).toBeNull();
      fireEvent.click(save);
      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith('/api/settings?sourceId=a', { walkaboutSnrBands: '-10,-15,-20' }),
      );
    });

    it('reset posts a blank value', async () => {
      hasPermission.mockReturnValue(true);
      apiGet.mockResolvedValue({ walkaboutSnrBands: '-10,-15,-20' });
      setup();
      await waitFor(() =>
        expect((screen.getByTestId('walkabout-snr-band-strong') as HTMLInputElement).value).toBe('-10'),
      );
      fireEvent.click(screen.getByTestId('walkabout-snr-bands-reset'));
      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith('/api/settings?sourceId=a', { walkaboutSnrBands: '' }),
      );
    });

    it('shows the slow-preset hint', () => {
      hasPermission.mockReturnValue(true);
      setup();
      expect(screen.getByTestId('walkabout-snr-bands-editor').textContent).toMatch(/-20 dB/);
    });
  });
});
