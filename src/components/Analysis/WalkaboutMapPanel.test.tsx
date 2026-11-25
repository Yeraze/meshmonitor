/**
 * @vitest-environment jsdom
 *
 * Walkabout map panel (#5891 P2): chips, session override, refresh.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WalkaboutSessionDto } from '../../types/walkabout';

const stub = vi.fn();
vi.mock('./walkaboutHexMapLazy', () => ({
  WalkaboutHexMapLazy: (props: unknown) => {
    stub(props);
    return <div data-testid="hex-map-stub" />;
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
  const qc = new QueryClient();
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

beforeEach(() => { stub.mockClear(); });

describe('WalkaboutMapPanel', () => {
  it('defaults to the 7d window', () => {
    setup();
    expect(last()).toEqual({ sourceId: 'a', query: { kind: 'window', window: '7d' }, fitKey: 'a|window|7d' });
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
});
