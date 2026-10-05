/**
 * AutomationTester — sample script output per named step, and how a held
 * (empty) send is shown (#5636). A test sends nothing either way.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AutomationTester, { type SimResult } from './AutomationTester';
import { namedStepOutputs } from './automationTesterHelpers';

vi.mock('../../services/api', () => ({ default: { post: vi.fn() } }));
import apiService from '../../services/api';
const mockedPost = apiService.post as unknown as ReturnType<typeof vi.fn>;

const config = (scriptParams: Record<string, unknown>) => ({
  version: 1,
  nodes: [
    { id: 't', type: 'trigger.message', params: {} },
    { id: 'a0', type: 'action.runScript', params: { scriptPath: 'joke.py', ...scriptParams } },
    { id: 'a1', type: 'action.sendMessage', params: { text: '{{ steps.joke.output }}' } },
  ],
  edges: [{ from: 't', to: 'a0' }, { from: 'a0', to: 'a1' }],
});
const getConfig = (scriptParams: Record<string, unknown>) => () =>
  ({ ok: true as const, config: config(scriptParams), triggerType: 'trigger.message' });

const result = (over: Partial<SimResult>): SimResult => ({
  matched: true, status: 'completed', triggerType: 'trigger.message', fields: {}, conditionResults: {},
  actions: [], variableWrites: [], steps: [], ...over,
});

describe('namedStepOutputs', () => {
  it('lists the names Run a script steps store, once each', () => {
    expect(namedStepOutputs(config({ outputName: 'joke' }))).toEqual(['joke']);
    expect(namedStepOutputs(config({}))).toEqual([]);
    expect(namedStepOutputs(config({ outputName: 'Bad Name' }))).toEqual([]);
    expect(namedStepOutputs(undefined)).toEqual([]);
    expect(namedStepOutputs({ nodes: 'nope' })).toEqual([]);
  });
});

describe('AutomationTester — sample step output (#5636)', () => {
  beforeEach(() => mockedPost.mockReset());

  it('shows no sample box when no step stores a run output', () => {
    render(<AutomationTester getConfig={getConfig({})} variables={[]} sources={[]} />);
    expect(screen.queryByText('Sample script output')).toBeNull();
  });

  it('sends the typed sample for each named step and shows the rendered message', async () => {
    const user = userEvent.setup();
    mockedPost.mockResolvedValue(result({
      actions: [
        { nodeId: 'a0', type: 'action.runScript', ok: true, resolvedParams: { scriptPath: 'joke.py', success: true } },
        { nodeId: 'a1', type: 'action.sendMessage', ok: true, resolvedParams: { action: 'sendMessage', text: 'A mesh walks into a bar.', channel: 0 } },
      ],
    }));
    render(<AutomationTester getConfig={getConfig({ outputName: 'joke' })} variables={[]} sources={[]} />);
    expect(screen.getByText('Sample script output')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^joke/), 'A mesh walks into a bar.');
    await user.click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1));
    const [url, body] = mockedPost.mock.calls[0];
    expect(url).toBe('/api/automations/test');
    expect(body.stepOutputs).toEqual({ joke: 'A mesh walks into a bar.' });
    await waitFor(() => expect(screen.getByText('A mesh walks into a bar.', { selector: '.ae-test-sent' })).toBeInTheDocument());
    expect(screen.getByText('Run script joke.py (not run in a test)')).toBeInTheDocument();
  });

  it('a blank sample is sent as an empty output', async () => {
    const user = userEvent.setup();
    mockedPost.mockResolvedValue(result({}));
    render(<AutomationTester getConfig={getConfig({ outputName: 'joke' })} variables={[]} sources={[]} />);
    await user.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1));
    expect(mockedPost.mock.calls[0][1].stepOutputs).toEqual({ joke: '' });
  });

  it('shows a held empty send as not sent, with the reason, in the action and in the trace', async () => {
    const user = userEvent.setup();
    const reason = 'the message text rendered empty, so nothing was sent';
    mockedPost.mockResolvedValue(result({
      actions: [{ nodeId: 'a1', type: 'action.sendMessage', ok: true, resolvedParams: { skipped: true, emptySend: true, reason } }],
      steps: [{ nodeId: 'a1', type: 'action.sendMessage', outcome: 'action:ok', detail: { skipped: true, reason } }],
    }));
    render(<AutomationTester getConfig={getConfig({ outputName: 'joke' })} variables={[]} sources={[]} />);
    await user.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(screen.getByText('Send message: not sent')).toBeInTheDocument());
    expect(screen.getByText(`Skipped: ${reason}.`)).toBeInTheDocument();
    expect(screen.getByText(`action ran — ${reason}`)).toBeInTheDocument();
  });

  it('shows a refused variable write as the step\'s error', async () => {
    const user = userEvent.setup();
    const error = 'script "joke.py" ran, but its result was not stored in variable "gone": unknown variable "gone"';
    mockedPost.mockResolvedValue(result({
      status: 'failed',
      actions: [{ nodeId: 'a0', type: 'action.runScript', ok: false, error }],
      steps: [{ nodeId: 'a0', type: 'action.runScript', outcome: 'action:error', error }],
    }));
    render(<AutomationTester getConfig={getConfig({ resultVariable: 'gone' })} variables={[]} sources={[]} />);
    await user.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(screen.getByText(error)).toBeInTheDocument());
    expect(screen.getByText(`action error — ${error}`)).toBeInTheDocument();
  });
});
