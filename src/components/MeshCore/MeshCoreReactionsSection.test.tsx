/**
 * MeshCoreReactionsSection (#5759): the per-source "show reactions" switch,
 * the global Auto-Acknowledge switch, and its always-visible airtime warning.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeshCoreReactionsSection } from './MeshCoreReactionsSection';
import { MESHCORE_REACTIONS_OUTBOUND_DEFAULT } from '../../utils/meshcoreReactionTarget';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const h = vi.hoisted(() => ({ csrfFetch: vi.fn(), showToast: vi.fn() }));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => h.csrfFetch }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));

const SOURCE_URL = '/mm/api/settings?sourceId=src-1';
const GLOBAL_URL = '/mm/api/settings';

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
});

function mockServer(settings: Record<string, unknown>, postStatus = 200) {
  h.csrfFetch.mockImplementation(async (_url: string, init?: { method?: string }) =>
    init?.method === 'POST' ? json({ success: postStatus === 200 }, postStatus) : json(settings));
}
const posts = () => h.csrfFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
const inbound = () => screen.getByTestId('meshcore-reactions-inbound') as HTMLInputElement;
const outbound = () => screen.getByTestId('meshcore-reactions-outbound') as HTMLInputElement;
const ack = () => screen.getByTestId('meshcore-reactions-ack') as HTMLInputElement;

describe('MeshCoreReactionsSection (#5759)', () => {
  beforeEach(() => {
    h.csrfFetch.mockReset();
    h.showToast.mockReset();
  });

  it('defaults to reactions shown and Auto-Acknowledge off, with the warning visible', async () => {
    mockServer({});
    render(<MeshCoreReactionsSection baseUrl="/mm" sourceId="src-1" />);
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalledWith(SOURCE_URL));
    expect(inbound().checked).toBe(true);
    expect(ack().checked).toBe(false);
    expect(screen.getByTestId('meshcore-reactions-ack-warning')).toHaveTextContent('Leave it off on busy channels');
  });

  it('loads both stored values', async () => {
    mockServer({ meshcoreReactionsInboundEnabled: 'false', meshcoreReactionsAckOnReceive: 'true' });
    render(<MeshCoreReactionsSection baseUrl="/mm" sourceId="src-1" />);
    await waitFor(() => expect(inbound().checked).toBe(false));
    expect(ack().checked).toBe(true);
  });

  it('saves the inbound switch to this source', async () => {
    mockServer({});
    render(<MeshCoreReactionsSection baseUrl="/mm" sourceId="src-1" />);
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
    await userEvent.click(inbound());
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0];
    expect(url).toBe(SOURCE_URL);
    expect(JSON.parse(init.body)).toEqual({ meshcoreReactionsInboundEnabled: false });
    expect(inbound().checked).toBe(false);
  });

  it('saves the Auto-Acknowledge switch globally', async () => {
    mockServer({});
    render(<MeshCoreReactionsSection baseUrl="/mm" sourceId="src-1" />);
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
    await userEvent.click(ack());
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0];
    expect(url).toBe(GLOBAL_URL);
    expect(JSON.parse(init.body)).toEqual({ meshcoreReactionsAckOnReceive: true });
    expect(ack().checked).toBe(true);
  });

  it('reverts the box and shows a toast on a 403', async () => {
    mockServer({}, 403);
    render(<MeshCoreReactionsSection baseUrl="/mm" sourceId="src-1" />);
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
    await userEvent.click(ack());
    await waitFor(() => expect(h.showToast).toHaveBeenCalledWith('Failed to save the reaction setting', 'error'));
    expect(ack().checked).toBe(false);
  });

  it('starts the send switch at the shared default and shows its warning', async () => {
    mockServer({});
    render(<MeshCoreReactionsSection baseUrl="/mm" sourceId="src-1" />);
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalledWith(SOURCE_URL));
    expect(outbound().checked).toBe(MESHCORE_REACTIONS_OUTBOUND_DEFAULT);
    expect(screen.getByTestId('meshcore-reactions-outbound-warning')).toHaveTextContent('every repeater in range');
  });

  it('loads a stored send value', async () => {
    mockServer({ meshcoreReactionsOutboundEnabled: !MESHCORE_REACTIONS_OUTBOUND_DEFAULT });
    render(<MeshCoreReactionsSection baseUrl="/mm" sourceId="src-1" />);
    await waitFor(() => expect(outbound().checked).toBe(!MESHCORE_REACTIONS_OUTBOUND_DEFAULT));
  });

  it('saves the send switch to this source and calls onOutboundChanged', async () => {
    mockServer({});
    const onOutboundChanged = vi.fn();
    render(<MeshCoreReactionsSection baseUrl="/mm" sourceId="src-1" onOutboundChanged={onOutboundChanged} />);
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
    await userEvent.click(outbound());
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0];
    expect(url).toBe(SOURCE_URL);
    expect(JSON.parse(init.body)).toEqual({ meshcoreReactionsOutboundEnabled: !MESHCORE_REACTIONS_OUTBOUND_DEFAULT });
    await waitFor(() => expect(onOutboundChanged).toHaveBeenCalledTimes(1));
  });

  it('does not call onOutboundChanged when the save fails', async () => {
    mockServer({}, 403);
    const onOutboundChanged = vi.fn();
    render(<MeshCoreReactionsSection baseUrl="/mm" sourceId="src-1" onOutboundChanged={onOutboundChanged} />);
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
    await userEvent.click(outbound());
    await waitFor(() => expect(h.showToast).toHaveBeenCalled());
    expect(onOutboundChanged).not.toHaveBeenCalled();
    expect(outbound().checked).toBe(MESHCORE_REACTIONS_OUTBOUND_DEFAULT);
  });
});
