/**
 * @vitest-environment jsdom
 *
 * Queued and superseded states of the neighbours fetch (#6493).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MeshCoreNeighboursFetchProgress } from './MeshCoreNeighboursFetchProgress';
import type { MeshCoreNeighboursFetchState } from './hooks/useMeshCoreNeighboursFetch';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const state = (over: Partial<MeshCoreNeighboursFetchState>): MeshCoreNeighboursFetchState => ({
  requestId: 'req-12345678',
  publicKey: 'a'.repeat(64),
  phase: 'waiting',
  page: 0,
  plannedPages: 0,
  maxPages: 5,
  total: null,
  pagesFetched: 0,
  neighbours: [],
  waitMs: 30000,
  waitRemainingMs: 30000,
  cancelRequested: false,
  queued: false,
  queuePosition: null,
  outcome: null,
  stored: null,
  written: null,
  error: null,
  waitEndsAt: Date.now() + 30000,
  cancelling: false,
  ...over,
});

describe('MeshCoreNeighboursFetchProgress queue states', () => {
  it('shows "Queued — sending in N s" with the requests ahead while page 1 waits', () => {
    render(<MeshCoreNeighboursFetchProgress fetch={state({ queued: true, queuePosition: 3 })} onCancel={() => {}} />);
    const el = screen.getByTestId('meshcore-neighbours-fetch-progress');
    expect(el).toHaveTextContent(/Queued — sending in 30 s/);
    expect(el).toHaveTextContent(/2 ahead/);
    expect(el).not.toHaveTextContent(/Page 1/);
  });

  it('shows the superseded outcome as a notice', () => {
    render(
      <MeshCoreNeighboursFetchProgress
        fetch={state({ phase: 'done', outcome: 'superseded', waitEndsAt: null, waitRemainingMs: null })}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('meshcore-neighbours-fetch-notice')).toHaveTextContent('Replaced by your newer request');
  });
});
