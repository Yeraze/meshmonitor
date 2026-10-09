/**
 * @vitest-environment jsdom
 *
 * Node Details "Encrypted requests" card (#5691): read-only view of the
 * Reliable PKI exchange state for one node on one source.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PkiExchangeStatusCard } from './PkiExchangeStatusCard';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn() }));
vi.mock('../services/api', () => ({
  default: { getPkiExchangeState: getStateMock },
}));

const base = {
  stateChangedAt: Date.now() - 60_000, lastSuccessAt: null, failingSince: null,
  lastFailureReason: null, lastPrimedAt: null, nextPrimingAllowedAt: null, mode: 'asNeeded' as const,
};

describe('PkiExchangeStatusCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when nothing is recorded', async () => {
    getStateMock.mockResolvedValue(null);
    const { container } = render(<PkiExchangeStatusCard sourceId="s" nodeNum={1} />);
    await waitFor(() => expect(getStateMock).toHaveBeenCalledWith('s', 1));
    expect(container.innerHTML).toBe('');
  });

  it('does not fetch without a source', () => {
    render(<PkiExchangeStatusCard sourceId={null} nodeNum={1} />);
    expect(getStateMock).not.toHaveBeenCalled();
  });

  it('shows a success line', async () => {
    getStateMock.mockResolvedValue({ ...base, state: 'successful', lastSuccessAt: Date.now() - 60_000 });
    render(<PkiExchangeStatusCard sourceId="s" nodeNum={1} />);
    expect((await screen.findByTestId('pki-exchange-state')).textContent).toMatch(/Last answered/);
  });

  it('shows failing since, the reason and the last priming', async () => {
    getStateMock.mockResolvedValue({
      ...base, state: 'failed', failingSince: Date.now() - 120_000, lastFailureReason: 'pki_unknown_pubkey',
      lastPrimedAt: Date.now() - 30_000,
    });
    render(<PkiExchangeStatusCard sourceId="s" nodeNum={1} />);
    expect((await screen.findByTestId('pki-exchange-state')).textContent).toMatch(/Failing since/);
    expect(screen.getByText(/does not have your public key/)).toBeTruthy();
    expect(screen.getByTestId('pki-exchange-primed').textContent).toMatch(/node info was last sent/);
  });

  it('shows unknown for a stale pending row', async () => {
    getStateMock.mockResolvedValue({ ...base, state: 'unknown' });
    render(<PkiExchangeStatusCard sourceId="s" nodeNum={1} />);
    expect((await screen.findByTestId('pki-exchange-state')).textContent).toMatch(/No answer recorded/);
  });
});
