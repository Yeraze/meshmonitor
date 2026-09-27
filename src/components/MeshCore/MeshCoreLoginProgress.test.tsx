/**
 * @vitest-environment jsdom
 *
 * MeshCoreLoginProgress (#5400): the live "attempt n of 3" line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MeshCoreLoginProgress } from './MeshCoreLoginProgress';
import type { MeshCoreLoginProgressState } from './hooks/useMeshCoreLoginProgress';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, vars?: Record<string, unknown>) =>
      String(fallback ?? _key).replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars?.[k] ?? '')),
  }),
}));

const base: MeshCoreLoginProgressState = {
  requestId: 'req-12345678',
  phase: 'sending',
  attempt: 1,
  maxAttempts: 3,
  waitMs: null,
  waitEndsAt: null,
  cancelling: false,
};

describe('MeshCoreLoginProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the attempt while sending', () => {
    render(<MeshCoreLoginProgress progress={base} onCancel={() => {}} />);
    expect(screen.getByText('Attempt 1 of 3: sending login…')).toBeTruthy();
  });

  it('does not guess an attempt count before the server reports one', () => {
    render(<MeshCoreLoginProgress progress={{ ...base, phase: 'starting', maxAttempts: 0 }} onCancel={() => {}} />);
    expect(screen.getByText('Sending login…')).toBeTruthy();
  });

  it('counts the reply wait down as time passes', () => {
    const progress = { ...base, phase: 'waiting' as const, attempt: 2, waitMs: 12_000, waitEndsAt: Date.now() + 12_000 };
    render(<MeshCoreLoginProgress progress={progress} onCancel={() => {}} />);
    expect(screen.getByText('Attempt 2 of 3: waiting for a reply (12 s left)')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText('Attempt 2 of 3: waiting for a reply (7 s left)')).toBeTruthy();
  });

  it('says a retry is coming after silence', () => {
    const progress = { ...base, phase: 'retrying' as const, attempt: 1, waitMs: 2000, waitEndsAt: Date.now() + 2000 };
    render(<MeshCoreLoginProgress progress={progress} onCancel={() => {}} />);
    expect(screen.getByText('No reply to attempt 1. Trying again in 2 s (2 of 3)…')).toBeTruthy();
  });

  it('Cancel calls back, and is disabled while cancelling', () => {
    const onCancel = vi.fn();
    const { rerender } = render(<MeshCoreLoginProgress progress={base} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(<MeshCoreLoginProgress progress={{ ...base, cancelling: true }} onCancel={onCancel} />);
    expect(screen.getByText('Cancelling…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
