/**
 * The Test panel and the shared step list for a send the airtime cutoff held
 * back: "would be skipped now" with the figures, the rendered text still
 * shown, and distinct step labels for a full and a partial skip.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AutomationTester, { type SimResult } from './AutomationTester';
import { StepList } from './outcomeMeta';

vi.mock('../../services/api', () => ({ default: { post: vi.fn() } }));
import apiService from '../../services/api';
const mockedPost = apiService.post as unknown as ReturnType<typeof vi.fn>;

const SKIP = { skipped: true, airtimeCutoff: true, sourceId: 'mt', channelUtilization: 45, threshold: 30, reason: 'airtime cutoff' };

describe('AutomationTester — airtime cutoff', () => {
  beforeEach(() => mockedPost.mockReset());

  function result(resolvedParams: unknown): SimResult {
    return {
      matched: true, status: 'completed', triggerType: 'trigger.message', fields: {}, conditionResults: {},
      actions: [{ nodeId: 's', type: 'action.sendMessage', ok: true, resolvedParams }],
      variableWrites: [], steps: [],
    };
  }
  const getConfig = () => ({ ok: true as const, config: { trigger: { type: 'trigger.message', params: {} }, rules: [] }, triggerType: 'trigger.message' });

  it('says the send would be skipped now, with the figures, and shows the text', async () => {
    const user = userEvent.setup();
    mockedPost.mockResolvedValue(result({ ...SKIP, text: 'pong ping' }));
    render(<AutomationTester getConfig={getConfig} variables={[]} sources={[]} />);
    await user.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(screen.getByText(/would be skipped now on mt: airtime 45% > 30%/)).toBeInTheDocument());
    expect(screen.getByText('pong ping')).toBeInTheDocument();
  });

  it('rounds a long neighbour-average reading to one decimal', async () => {
    const user = userEvent.setup();
    mockedPost.mockResolvedValue(result({ ...SKIP, channelUtilization: 33.333333 }));
    render(<AutomationTester getConfig={getConfig} variables={[]} sources={[]} />);
    await user.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(screen.getByText(/airtime 33\.3% > 30%/)).toBeInTheDocument());
  });

  it('a partial skip keeps the normal headline and adds a note', async () => {
    const user = userEvent.setup();
    mockedPost.mockResolvedValue(result([SKIP, { sourceId: 'mt2', text: 'pong', channel: 0 }]));
    render(<AutomationTester getConfig={getConfig} variables={[]} sources={[]} />);
    await user.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(screen.getByText(/Partly sent: would be skipped now on mt/)).toBeInTheDocument());
  });
});

describe('StepList — airtime cutoff labels', () => {
  it('labels a held-back send and a partial one', () => {
    render(<StepList steps={[
      { type: 'action.sendMessage', outcome: 'action:ok', detail: { ...SKIP } },
      { type: 'action.requestData', outcome: 'action:ok', detail: { partial: true, airtimeCutoff: true, airtimeSkipped: ['mt'], reason: 'partly sent: x' } },
      { type: 'engine', outcome: 'airtime:bypassed', detail: { reason: 'Run now ignored the airtime cutoff on mt' } },
    ]} />);
    expect(screen.getByText(/paused: airtime over cutoff/)).toBeInTheDocument();
    expect(screen.getByText(/^partly sent — partly sent: x$/)).toBeInTheDocument();
    expect(screen.getByText(/airtime cutoff ignored \(Run now\)/)).toBeInTheDocument();
  });
});
