/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import apiService, { type AdminVerifyJob } from '../../services/api';
import { VerifyJobsPanel } from './VerifyJobsPanel';

vi.mock('react-i18next', () => {
  const t = (_k: string, def: string, opts?: Record<string, unknown>) =>
    Object.entries(opts ?? {}).reduce((s, [k, v]) => s.replace(`{{${k}}}`, String(v)), def);
  return { useTranslation: () => ({ t }) };
});

const job = (over: Partial<AdminVerifyJob>): AdminVerifyJob => ({
  id: 'j1', sourceId: 's', destinationNodeNum: 0xabc, command: 'setLoRaConfig', section: 'lora',
  status: 'waiting', createdAt: 0, completedAt: null, deadline: 0, sends: 1, maxSends: 5, checks: 0,
  nextCheckAt: null, lastCheckOutcome: null, pendingFields: [], differingFields: [], error: null, ...over,
});

function renderPanel() {
  return render(<VerifyJobsPanel nodeName={(n) => `node-${n}`} />);
}

describe('VerifyJobsPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders nothing with no jobs', async () => {
    vi.spyOn(apiService, 'getVerifyJobs').mockResolvedValue([]);
    const { container } = renderPanel();
    await waitFor(() => expect(apiService.getVerifyJobs).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('lists jobs, shows stuck fields, and cancels a running one', async () => {
    vi.spyOn(apiService, 'getVerifyJobs').mockResolvedValue([
      job({ id: 'run', status: 'resending', pendingFields: ['hopLimit'] }),
      job({ id: 'done', status: 'refused', destinationNodeNum: 7 }),
    ]);
    const cancel = vi.spyOn(apiService, 'cancelVerifyJob').mockResolvedValue(job({ status: 'cancelled' }));
    renderPanel();

    expect(await screen.findByText('Still old: hopLimit')).toBeTruthy();
    expect(screen.getByText('node-7')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Cancel' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('run'));
  });
});
