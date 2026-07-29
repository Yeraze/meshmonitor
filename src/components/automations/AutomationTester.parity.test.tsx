/**
 * AutomationTester — Phase 3 parity additions (#4340 WP4 §5.3).
 *
 * Two one-liners from the spec:
 *  - `hwModel` joins the Subject-node facts form (`buildNode()`'s `numFact`
 *    list) so a dry-run of `node.completeness` doesn't report a false
 *    'incomplete' for an otherwise-complete synthetic node — isNodeComplete()
 *    (src/utils/nodeHelpers.ts) requires an hwModel.
 *  - The `action.sendMessage` result headline reports the DM resend cap
 *    (`maxAttempts`, added to `action.sendMessage` by WP3/catalog.ts) when
 *    present, proving the param crossed the deps boundary into the dry-run.
 *
 * Modeled on AutomationBuilder.emojiMode.test.tsx's rendering conventions,
 * but drives AutomationTester directly — this file owns AutomationTester.tsx,
 * not AutomationBuilder.tsx (#4340 Phase 3 §7 WP4 hard constraint).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AutomationTester, { type SimResult } from './AutomationTester';

vi.mock('../../services/api', () => ({
  default: { post: vi.fn() },
}));

import apiService from '../../services/api';

const mockedPost = apiService.post as unknown as ReturnType<typeof vi.fn>;

function baseConfig() {
  return { ok: true as const, config: { trigger: { type: 'trigger.message', params: {} }, rules: [] }, triggerType: 'trigger.message' };
}

function renderTester() {
  return render(<AutomationTester getConfig={baseConfig} variables={[]} sources={[]} />);
}

function simResult(actions: SimResult['actions']): SimResult {
  return {
    matched: true,
    status: 'completed',
    triggerType: 'trigger.message',
    fields: {},
    conditionResults: {},
    actions,
    variableWrites: [],
    steps: [],
  };
}

describe('AutomationTester — subject-node hwModel fact (#4340 Phase 3)', () => {
  beforeEach(() => {
    mockedPost.mockReset();
    mockedPost.mockResolvedValue(simResult([]));
  });

  it('renders an "HW model (#)" input under Subject-node facts', async () => {
    const user = userEvent.setup();
    renderTester();
    await user.click(screen.getByText(/Subject-node facts & variable overrides/));
    expect(screen.getByText('HW model (#)')).toBeInTheDocument();
  });

  it('forwards the entered hwModel as a numeric node fact on the test POST body', async () => {
    const user = userEvent.setup();
    renderTester();
    await user.click(screen.getByText(/Subject-node facts & variable overrides/));

    const label = screen.getByText('HW model (#)');
    const input = label.closest('.ae-field')?.querySelector('input');
    if (!input) throw new Error('HW model input not found');
    await user.type(input, '43');

    await user.click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    const body = mockedPost.mock.calls[0][1] as { node?: Record<string, unknown> };
    expect(body.node?.hwModel).toBe(43);
  });
});

describe('AutomationTester — action.sendMessage headline reports maxAttempts (#4340 Phase 3)', () => {
  beforeEach(() => {
    mockedPost.mockReset();
  });

  it('shows "up to N attempts" for a DM result carrying maxAttempts', async () => {
    const user = userEvent.setup();
    mockedPost.mockResolvedValue(simResult([
      { nodeId: 'a1', type: 'action.sendMessage', ok: true, resolvedParams: { destination: 123, maxAttempts: 3, text: 'hi' } },
    ]));
    renderTester();
    await user.click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(screen.getByText(/DM to node 123/)).toBeInTheDocument());
    expect(screen.getByText(/up to 3 attempts/)).toBeInTheDocument();
  });

  it('omits the attempts clause for a DM result with no maxAttempts', async () => {
    const user = userEvent.setup();
    mockedPost.mockResolvedValue(simResult([
      { nodeId: 'a1', type: 'action.sendMessage', ok: true, resolvedParams: { destination: 123, text: 'hi' } },
    ]));
    renderTester();
    await user.click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(screen.getByText(/DM to node 123/)).toBeInTheDocument());
    expect(screen.queryByText(/attempts/)).not.toBeInTheDocument();
  });

  it('omits the attempts clause for a channel result even when maxAttempts is set', async () => {
    const user = userEvent.setup();
    mockedPost.mockResolvedValue(simResult([
      { nodeId: 'a1', type: 'action.sendMessage', ok: true, resolvedParams: { channel: 0, maxAttempts: 3, text: 'hi' } },
    ]));
    renderTester();
    await user.click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(screen.getByText(/channel 0/)).toBeInTheDocument());
    expect(screen.queryByText(/attempts/)).not.toBeInTheDocument();
  });
});
