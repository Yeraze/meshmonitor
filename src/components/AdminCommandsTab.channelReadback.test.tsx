/**
 * @vitest-environment jsdom
 *
 * The read-back after a channel save or import on a remote node.
 *
 * Each `/api/admin/get-channel` is an admin packet over the mesh. The
 * read-back used to send up to three more on any error holding `404`,
 * `timeout` or `not received`, 1.5 s apart, and then said nothing. Pinned
 * here: one request whatever the error, and a warning that says the save went
 * through and only the read-back failed.
 *
 * Nothing here reaches a radio: `apiService` is mocked.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  showToast: vi.fn(),
  apiPost: vi.fn(),
  apiSendAdminCommand: vi.fn(),
}));

// `t` must keep one identity across renders (see AdminCommandsTab.txDisabled.test.tsx).
vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: string | Record<string, unknown>) => (typeof fallback === 'string' ? fallback : key);
  return { useTranslation: () => ({ t }) };
});
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock('../hooks/useResolvedSourceId', () => ({ useResolvedSourceId: () => 'source-1' }));
vi.mock('../hooks/useTxStatus', () => ({ useTxStatus: () => ({ isTxDisabled: false }) }));
vi.mock('../services/api', () => ({
  default: {
    setBaseUrl: vi.fn(),
    post: h.apiPost,
    sendAdminCommand: h.apiSendAdminCommand,
    exportChannel: vi.fn(),
    importChannel: vi.fn(),
    getAllChannels: vi.fn().mockResolvedValue([]),
    ensureSessionPasskey: vi.fn().mockResolvedValue({ success: true, hasPasskey: true, remainingSeconds: 300 }),
  },
}));
vi.mock('./SectionNav', () => ({ default: () => null }));
vi.mock('./configuration/ImportConfigModal', () => ({ ImportConfigModal: () => null }));
vi.mock('./configuration/ExportConfigModal', () => ({ ExportConfigModal: () => null }));
vi.mock('./admin-commands/AutoFavoriteManagementSection', () => ({ default: () => null }));

import AdminCommandsTab from './AdminCommandsTab';

const LOCAL_NODE_ID = '!00000064';
const localNode = { nodeNum: 100, user: { id: LOCAL_NODE_ID, longName: 'Local Node', shortName: 'LOC1' } };
const remoteNode = { nodeNum: 200, user: { id: '!000000c8', longName: 'Remote Node', shortName: 'REM1' } };
const CHANNELS_ID = 'admin-channel-config';
const en = JSON.parse(readFileSync(join(__dirname, '../../public/locales/en.json'), 'utf8')) as Record<string, string>;

function renderTabOnRemoteNode() {
  localStorage.setItem('adminCommandsExpandedSections', JSON.stringify({ 'radio-config': true, [CHANNELS_ID]: true }));
  render(<AdminCommandsTab nodes={[localNode, remoteNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);
  fireEvent.focus(screen.getByPlaceholderText('Local Node'));
  fireEvent.click(screen.getByText('Remote Node'));
}

const channels = () => within(document.getElementById(CHANNELS_ID) as HTMLElement);
const readBacks = () =>
  h.apiPost.mock.calls.filter(([endpoint]) => endpoint === '/api/admin/get-channel').map(([, body]) => body as { channelIndex: number });
const setChannelCommands = () =>
  h.apiSendAdminCommand.mock.calls.map(([body]) => body as { command: string; channelIndex?: number }).filter(c => c.command === 'setChannel');
const toasts = (kind: string) => h.showToast.mock.calls.filter(([, k]) => k === kind).map(([message]) => message as string);

/** Longer than the old gap between retries (1.5 s): a retry would have gone out by now. */
const waitPastOldRetry = () => new Promise(resolve => setTimeout(resolve, 1800));

/** Open the edit modal for slot 1 and press Save. */
async function saveChannelOne() {
  fireEvent.click(channels().getAllByRole('button', { name: /common\.edit/ })[1]);
  fireEvent.click(await screen.findByRole('button', { name: 'admin_commands.save_channel' }));
  await waitFor(() => expect(setChannelCommands()).toHaveLength(1));
}

/** Every "the node did not answer" shape the old retry matched on, plus the route's own wording. */
const NO_ANSWER_ERRORS = [
  'HTTP 404',
  'Request timeout',
  'Channel 1 not received from remote node 200',
  'Remote node 200 is not reachable',
];

let readBackAnswer: () => unknown;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  readBackAnswer = () => ({ channel: { name: 'Fresh', psk: 'AQ==', role: 2 } });
  h.apiPost.mockImplementation(async (endpoint: string) => {
    if (endpoint === '/api/admin/get-channel') return readBackAnswer();
    return {};
  });
  h.apiSendAdminCommand.mockResolvedValue({ success: true, message: 'Channel sent' });
});

describe('AdminCommandsTab channel read-back', () => {
  it('reads the saved channel back with one request and shows the answer', async () => {
    renderTabOnRemoteNode();

    await saveChannelOne();

    await waitFor(() => expect(readBacks()).toHaveLength(1), { timeout: 4000 });
    expect(readBacks()[0].channelIndex).toBe(1);
    expect(await channels().findByText(/Fresh/)).toBeTruthy();
    expect(toasts('success')).toEqual(['Channel sent']);
    expect(toasts('warning')).toEqual([]);
    expect(toasts('error')).toEqual([]);
  }, 15000);

  it.each(NO_ANSWER_ERRORS)('sends one read-back, not four, after "%s"', async (message) => {
    readBackAnswer = () => {
      throw new Error(message);
    };
    renderTabOnRemoteNode();

    await saveChannelOne();
    await waitFor(() => expect(readBacks()).toHaveLength(1), { timeout: 4000 });
    await waitPastOldRetry();

    // One set_channel, one get_channel: the old code sent three more of the second.
    expect(setChannelCommands()).toHaveLength(1);
    expect(readBacks()).toHaveLength(1);

    // The save is reported as a success; only the read-back is reported as failed.
    expect(toasts('success')).toEqual(['Channel sent']);
    expect(toasts('warning')).toEqual(['admin_commands.channel_readback_failed']);
    expect(toasts('error')).toEqual([]);
    // The row still shows the old values, so the section must not read as loaded.
    expect(channels().queryByTitle('admin_commands.section_load_failed')).not.toBeNull();
    expect(channels().queryByTitle('admin_commands.section_loaded')).toBeNull();
  }, 15000);

  it('the warning says the save went through and names the read-back as what failed', () => {
    const text = en['admin_commands.channel_readback_failed'];
    expect(text).toMatch(/^Channel \{\{index\}\} was saved\./);
    expect(text).toMatch(/Only the read-back failed \(\{\{error\}\}\)/);
    expect(text).not.toMatch(/save failed|not saved/i);
  });

  it('a failed save sends no read-back and is not called a read-back failure', async () => {
    h.apiSendAdminCommand.mockRejectedValue(new Error('No ACK from node'));
    renderTabOnRemoteNode();

    fireEvent.click(channels().getAllByRole('button', { name: /common\.edit/ })[1]);
    fireEvent.click(await screen.findByRole('button', { name: 'admin_commands.save_channel' }));
    await waitFor(() => expect(toasts('error')).toEqual(['No ACK from node']));
    await waitPastOldRetry();

    expect(readBacks()).toHaveLength(0);
    expect(toasts('warning')).toEqual([]);
    expect(toasts('success')).toEqual([]);
  }, 15000);
});
