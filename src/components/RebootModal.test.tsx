/**
 * @vitest-environment jsdom
 *
 * RebootModal waits for the reboot the firmware starts after a config save
 * (#5823). It sends no reboot command.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  getConnectionStatus: vi.fn(),
  getCurrentConfig: vi.fn(),
  refreshNodes: vi.fn(),
  rebootDevice: vi.fn(),
}));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../contexts/SourceContext', () => ({ useSource: () => ({ sourceId: 'source-1', sourceName: 'test-source' }) }));
vi.mock('../services/api', () => ({
  default: {
    getConnectionStatus: h.getConnectionStatus,
    getCurrentConfig: h.getCurrentConfig,
    refreshNodes: h.refreshNodes,
    rebootDevice: h.rebootDevice,
  },
}));

import { RebootModal } from './RebootModal';

/** Runs the modal's 30 s wait and every poll. */
async function runSequence() {
  for (let i = 0; i < 40; i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h.getConnectionStatus.mockResolvedValue({ connected: true });
  h.refreshNodes.mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RebootModal (#5823)', () => {
  it('a possible reboot that does not happen closes after a few polls', async () => {
    h.getCurrentConfig.mockResolvedValue({ localNodeInfo: { rebootCount: 4 } });
    const onClose = vi.fn();
    render(<RebootModal isOpen expectation="possible" onClose={onClose} />);
    expect(screen.getByText(/reboot\.title_possible/)).toBeTruthy();

    await runSequence();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.refreshNodes).toHaveBeenCalledTimes(5);
    expect(h.rebootDevice).not.toHaveBeenCalled();
  });

  it('a reboot that is over by the first poll counts against the count read at open', async () => {
    // Read at open: 4. The node restarts; every later read sees 5.
    h.getCurrentConfig
      .mockResolvedValueOnce({ localNodeInfo: { rebootCount: 4 } })
      .mockResolvedValue({ localNodeInfo: { rebootCount: 5 } });
    const onClose = vi.fn();
    render(<RebootModal isOpen expectation="always" onClose={onClose} />);
    expect(screen.getByText(/reboot\.title$/)).toBeTruthy();

    await runSequence();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.refreshNodes).toHaveBeenCalledTimes(1);
    expect(h.rebootDevice).not.toHaveBeenCalled();
  });
});
