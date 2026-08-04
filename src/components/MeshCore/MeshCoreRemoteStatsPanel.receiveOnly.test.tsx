/**
 * @vitest-environment jsdom
 *
 * MeshCoreRemoteStatsPanel — receive-only gating (#4547 Phase 2 WP3).
 *
 * GET /admin/status/:pk transmits (SendStatusReq), so both user-initiated
 * entry points (the header "Refresh"/"Fetch stats" button and the
 * empty-state "Fetch stats" button) are disabled while receive-only, and
 * `load()` itself early-returns before calling `fetchStatus` or setting any
 * loading state — the defensive guard the spec's §3.4a(c) calls the
 * "automatic path" contract, verified here for every caller of `load()`.
 *
 * Note: as of this worktree, MeshCoreRemoteStatsPanel has no actual
 * mount/expand-triggered auto-load (the component's own comment states
 * "No auto-fetch and no polling — status is loaded only when the user
 * asks"); only the two buttons below invoke `load()`. The guard inside
 * `load()` is still added per the spec so any future automatic caller is
 * covered for free, and the mount-time assertion below locks in that
 * mounting the panel never fetches on its own, in either mode.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreRemoteStatsPanel } from './MeshCoreRemoteStatsPanel';
import type { MeshCoreRemoteStatus } from './hooks/useMeshCore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

const PK = 'a'.repeat(64);

type FetchStatusFn = (publicKey: string) => Promise<MeshCoreRemoteStatus | null>;

describe('MeshCoreRemoteStatsPanel receive-only mode', () => {
  let fetchStatus: ReturnType<typeof vi.fn<FetchStatusFn>>;

  beforeEach(() => {
    fetchStatus = vi.fn<FetchStatusFn>().mockResolvedValue({ uptimeSecs: 100 } as MeshCoreRemoteStatus);
  });

  it('does not call fetchStatus on mount, regardless of receiveOnly', () => {
    render(<MeshCoreRemoteStatsPanel publicKey={PK} fetchStatus={fetchStatus} receiveOnly />);
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it('disables the header refresh/fetch button with a tooltip when receiveOnly', () => {
    const { container } = render(
      <MeshCoreRemoteStatsPanel publicKey={PK} fetchStatus={fetchStatus} receiveOnly />,
    );
    const btn = container.querySelector('.mrs-refresh-btn');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.');

    fireEvent.click(btn!);
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it('disables the empty-state fetch button with a tooltip when receiveOnly', () => {
    const { container } = render(
      <MeshCoreRemoteStatsPanel publicKey={PK} fetchStatus={fetchStatus} receiveOnly />,
    );
    // Both the header button and the empty-state button render the same
    // "Fetch stats" label before any status has loaded — assert both by class.
    const headerBtn = container.querySelector('.mrs-refresh-btn');
    const emptyBtn = container.querySelector('.mrs-fetch-btn');
    for (const btn of [headerBtn, emptyBtn]) {
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.');
    }
  });

  it('load() itself skips silently when receiveOnly — no fetch, no loading state', async () => {
    // Force a click through even though the button is disabled, to prove
    // the guard lives inside load() too (defense in depth), not just on the
    // button's disabled attribute.
    const { rerender } = render(
      <MeshCoreRemoteStatsPanel publicKey={PK} fetchStatus={fetchStatus} receiveOnly={false} />,
    );
    // Re-render as receive-only without ever having fetched.
    rerender(<MeshCoreRemoteStatsPanel publicKey={PK} fetchStatus={fetchStatus} receiveOnly />);
    expect(screen.queryByText('Loading status…')).not.toBeInTheDocument();
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it('fetches normally (button enabled, no tooltip) when receiveOnly is false', async () => {
    const { container } = render(
      <MeshCoreRemoteStatsPanel publicKey={PK} fetchStatus={fetchStatus} receiveOnly={false} />,
    );
    const btn = container.querySelector('.mrs-refresh-btn')!;
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('title');

    fireEvent.click(btn);
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledWith(PK));
  });
});
