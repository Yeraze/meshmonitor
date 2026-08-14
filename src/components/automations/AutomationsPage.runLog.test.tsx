/**
 * AutomationsPage — Runs view (#4711).
 *
 * The engine has always persisted the full triggering `ctx.fields` bag in
 * `automation_runs.triggerEvent`, and the API has always returned it; the Runs
 * view just never rendered it, leaving a raw JSON step dump as the only clue why
 * a rule fired. These prove the run row now leads with date/time, node, channel
 * and the message itself, and that the step trace is readable rather than raw.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AutomationsPage from './AutomationsPage';

// Same module-scope `setBaseUrl` requirement as AutomationsPage.templateGallery.test.tsx.
vi.mock('../../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), setBaseUrl: vi.fn() },
}));

import apiService from '../../services/api';

const mockedGet = apiService.get as unknown as ReturnType<typeof vi.fn>;

const AUTOMATION = {
  id: 'auto-1',
  name: 'Ping responder',
  description: null,
  enabled: true,
  config: JSON.stringify({ nodes: [{ id: 't1', type: 'trigger.message', params: {} }], edges: [] }),
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const TRIGGER_EVENT = {
  from: 1128074276, fromId: '!433d1ba4', fromName: 'Base Station',
  to: 4294967295, text: 'ping the mesh', channel: 2, channelName: 'gauntlet',
  isDM: false, isChannel: true, hops: 1, protocol: 'meshtastic', sourceId: 'src-1',
};

const STEPS = [
  { nodeId: 't1', type: 'trigger.message', outcome: 'activated' },
  { nodeId: 'a1', type: 'action.sendMessage', outcome: 'action:ok' },
];

function mockRuns(runs: unknown[]) {
  mockedGet.mockImplementation((url: string) => {
    if (url === '/api/automations') return Promise.resolve([AUTOMATION]);
    if (url.endsWith('/runs')) return Promise.resolve(runs);
    return Promise.resolve([]);
  });
}

async function openRuns() {
  render(<MemoryRouter><AutomationsPage /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: 'Runs' }));
}

beforeEach(() => { mockedGet.mockReset(); });

describe('AutomationsPage — Runs view', () => {
  it('shows the triggering node, channel and message text', async () => {
    mockRuns([{
      id: 'run-1', status: 'completed', sourceId: 'src-1', startedAt: 1_700_000_123_000,
      log: JSON.stringify(STEPS), triggerEvent: JSON.stringify(TRIGGER_EVENT),
    }]);
    await openRuns();

    expect(await screen.findByText('Runs: Ping responder')).toBeInTheDocument();
    expect(screen.getByText('Base Station')).toBeInTheDocument();
    expect(screen.getByText('gauntlet')).toBeInTheDocument();
    expect(screen.getByText('ping the mesh')).toBeInTheDocument();
    // Existing facts are kept, not replaced.
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText(new Date(1_700_000_123_000).toLocaleString())).toBeInTheDocument();
  });

  it('renders the step trace with labels instead of a raw JSON dump', async () => {
    mockRuns([{
      id: 'run-1', status: 'completed', sourceId: 'src-1', startedAt: 1_700_000_123_000,
      log: JSON.stringify(STEPS), triggerEvent: JSON.stringify(TRIGGER_EVENT),
    }]);
    await openRuns();

    expect(await screen.findByText('execution trace (2 steps)')).toBeInTheDocument();
    expect(screen.getByText('action.sendMessage')).toBeInTheDocument();
    expect(screen.getByText(/action ran/)).toBeInTheDocument();
    // The old behavior dumped the whole log array as one string.
    expect(screen.queryByText(JSON.stringify(STEPS))).not.toBeInTheDocument();
  });

  it('keeps the full captured payload available behind a details toggle, pretty-printed', async () => {
    const raw = JSON.stringify(TRIGGER_EVENT);
    mockRuns([{
      id: 'run-1', status: 'completed', sourceId: 'src-1', startedAt: 1_700_000_123_000,
      log: JSON.stringify(STEPS), triggerEvent: raw,
    }]);
    await openRuns();

    expect(await screen.findByText('trigger payload')).toBeInTheDocument();
    // `getByText` collapses whitespace, so assert on the element: the payload is
    // stored minified and rendered indented (#4716 review), losing nothing.
    const pre = document.querySelector('details .ae-run-raw') as HTMLElement;
    expect(pre).not.toBeNull();
    expect(JSON.parse(pre.textContent!)).toEqual(TRIGGER_EVENT);
    expect(pre.textContent).toContain('\n  "fromName": "Base Station"');
  });

  it('renders a DM run without inventing a channel', async () => {
    mockRuns([{
      id: 'run-dm', status: 'completed', sourceId: 'src-1', startedAt: 1_700_000_123_000,
      log: JSON.stringify(STEPS),
      triggerEvent: JSON.stringify({ from: 42, fromName: 'Kokoshell', text: 'hello', isDM: true, channel: 0 }),
    }]);
    await openRuns();

    expect(await screen.findByText('Kokoshell')).toBeInTheDocument();
    expect(screen.getByText('DM')).toBeInTheDocument();
    expect(screen.queryByText('ch 0')).not.toBeInTheDocument();
  });

  it('survives a run with a missing or malformed payload', async () => {
    mockRuns([
      { id: 'run-null', status: 'failed', sourceId: null, startedAt: 1_700_000_123_000, log: null, triggerEvent: null },
      { id: 'run-bad', status: 'failed', sourceId: null, startedAt: 1_700_000_124_000, log: '{oops', triggerEvent: '{oops' },
    ]);
    await openRuns();

    expect(await screen.findByText('Runs: Ping responder')).toBeInTheDocument();
    expect(screen.getAllByText('failed')).toHaveLength(2);
    // An unparseable log is still shown raw rather than silently dropped.
    expect(screen.getAllByText('{oops').length).toBeGreaterThan(0);
  });

  it('shows the empty state when the rule has never fired', async () => {
    mockRuns([]);
    await openRuns();
    expect(await screen.findByText('No runs yet.')).toBeInTheDocument();
  });
});
