/**
 * @vitest-environment jsdom
 *
 * #5612: the Protection Level picker in the Admin Commands Security block.
 *
 * What is pinned here is the payload: the policy goes out ONLY when the user
 * changed it, and only after the confirm for the value chosen. Left out, the
 * server keeps the value it reads from the node.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
vi.mock('./admin-commands/ModuleConfigurationSection', () => ({ ModuleConfigurationSection: () => null }));
vi.mock('./admin-commands/AutoFavoriteManagementSection', () => ({ default: () => null }));
vi.mock('./admin-commands/DeviceConfigurationSection', () => ({ DeviceConfigurationSection: () => null }));

import AdminCommandsTab from './AdminCommandsTab';

const COMPATIBLE = 0;
const BALANCED = 1;
const STRICT = 2;
const LOCAL_NODE_ID = '!00000064';
const localNode = { nodeNum: 100, user: { id: LOCAL_NODE_ID, longName: 'Local Node', shortName: 'LOC1' } };
const remoteNode = { nodeNum: 200, user: { id: '!000000c8', longName: 'Remote Node', shortName: 'REM1' } };

/** What /load-config answers for the security section. */
let securityAnswer: Record<string, unknown>;

function securitySection(): HTMLElement {
  return document.getElementById('admin-security-config') as HTMLElement;
}
const picker = () => within(securitySection()).getByRole('combobox') as HTMLSelectElement;

const selectRemoteNode = () => {
  fireEvent.focus(screen.getByPlaceholderText('Local Node'));
  fireEvent.click(screen.getByText('Remote Node'));
};

async function renderAndLoad(nodes: unknown[] = [localNode], target: 'local' | 'remote' = nodes.length > 1 ? 'remote' : 'local') {
  localStorage.setItem('adminCommandsExpandedSections', JSON.stringify({ 'radio-config': true, 'admin-security-config': true }));
  render(<AdminCommandsTab nodes={nodes} currentNodeId={LOCAL_NODE_ID} channels={[]} />);
  if (target === 'remote') selectRemoteNode();
  expect(securitySection(), 'security section is rendered').not.toBeNull();
  fireEvent.click(within(securitySection()).getByRole('button', { name: 'Load' }));
  await waitFor(() => expect(within(securitySection()).getByText('admin_commands.save_security_config').closest('button')).toBeEnabled());
}

const save = () => fireEvent.click(within(securitySection()).getByText('admin_commands.save_security_config'));
const sentConfigs = () =>
  h.apiSendAdminCommand.mock.calls
    .map(([body]) => body as { command: string; config: Record<string, unknown> })
    .filter((body) => body.command === 'setSecurityConfig')
    .map((body) => body.config);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  securityAnswer = {
    adminKeys: [],
    isManaged: false,
    serialEnabled: true,
    debugLogApiEnabled: false,
    adminChannelEnabled: false,
    packetSignaturePolicy: COMPATIBLE,
    firmwareVersion: '2.8.0.abcdef0',
  };
  h.apiPost.mockImplementation(async (endpoint: string, body: { configType?: string }) =>
    endpoint === '/api/admin/load-config' && body?.configType === 'security' ? { config: securityAnswer } : {},
  );
  h.apiSendAdminCommand.mockResolvedValue({ success: true, message: 'ok' });
  // The generic "overwrite this node's security config?" confirm.
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('AdminCommandsTab packet signature policy (#5612)', () => {
  it('is "unknown" and disabled until the node\'s security config is loaded', () => {
    localStorage.setItem('adminCommandsExpandedSections', JSON.stringify({ 'radio-config': true, 'admin-security-config': true }));
    render(<AdminCommandsTab nodes={[localNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    expect(picker()).toBeDisabled();
    expect(picker().value).toBe('');
  });

  it('shows the policy the node holds', async () => {
    securityAnswer.packetSignaturePolicy = STRICT;
    await renderAndLoad();

    expect(picker()).toBeEnabled();
    expect(picker().value).toBe(String(STRICT));
  });

  it('sends no policy when the user did not change it', async () => {
    securityAnswer.packetSignaturePolicy = STRICT;
    await renderAndLoad();

    save();

    await waitFor(() => expect(sentConfigs()).toHaveLength(1));
    expect('packetSignaturePolicy' in sentConfigs()[0]).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never sends a key', async () => {
    await renderAndLoad();
    save();
    await waitFor(() => expect(sentConfigs()).toHaveLength(1));
    expect(Object.keys(sentConfigs()[0])).not.toEqual(expect.arrayContaining(['privateKey']));
    expect(Object.keys(sentConfigs()[0])).not.toEqual(expect.arrayContaining(['publicKey']));
  });

  it('Balanced: a plain confirm, then the policy is sent', async () => {
    const user = userEvent.setup();
    await renderAndLoad();
    await user.selectOptions(picker(), String(BALANCED));

    save();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(sentConfigs()).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'signature_policy.confirm_balanced_button' }));

    await waitFor(() => expect(sentConfigs()).toHaveLength(1));
    expect(sentConfigs()[0].packetSignaturePolicy).toBe(BALANCED);
  });

  it('Strict on a remote node: locked until its short name is typed', async () => {
    const user = userEvent.setup();
    await renderAndLoad([localNode, remoteNode]);
    await user.selectOptions(picker(), String(STRICT));
    expect(within(securitySection()).getByTestId('signature-policy-strict-warning')).toBeInTheDocument();

    save();
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'signature_policy.confirm_strict_button' });
    expect(confirm).toBeDisabled();

    // The local node's name does not unlock a remote node's change.
    await user.type(within(dialog).getByRole('textbox'), 'LOC1');
    expect(confirm).toBeDisabled();
    await user.clear(within(dialog).getByRole('textbox'));
    await user.type(within(dialog).getByRole('textbox'), 'REM1');
    expect(confirm).toBeEnabled();
    expect(sentConfigs()).toHaveLength(0);

    await user.click(confirm);

    await waitFor(() => expect(sentConfigs()).toHaveLength(1));
    expect(sentConfigs()[0].packetSignaturePolicy).toBe(STRICT);
    expect(h.apiSendAdminCommand.mock.calls.at(-1)?.[0]).toMatchObject({ nodeNum: 200 });
  });

  it('cancelling the confirm sends nothing', async () => {
    const user = userEvent.setup();
    await renderAndLoad();
    await user.selectOptions(picker(), String(STRICT));

    save();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'common.cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sentConfigs()).toHaveLength(0);
  });

  it('back to Compatible: no policy dialog, and an explicit 0 is sent', async () => {
    const user = userEvent.setup();
    securityAnswer.packetSignaturePolicy = STRICT;
    await renderAndLoad();
    await user.selectOptions(picker(), String(COMPATIBLE));

    save();

    await waitFor(() => expect(sentConfigs()).toHaveLength(1));
    expect(sentConfigs()[0].packetSignaturePolicy).toBe(COMPATIBLE);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('after a save that worked, the next save sends no policy', async () => {
    const user = userEvent.setup();
    securityAnswer.packetSignaturePolicy = STRICT;
    await renderAndLoad();
    await user.selectOptions(picker(), String(COMPATIBLE));
    save();
    await waitFor(() => expect(sentConfigs()).toHaveLength(1));

    await waitFor(() => expect(within(securitySection()).getByText('admin_commands.save_security_config').closest('button')).toBeEnabled());
    save();

    await waitFor(() => expect(sentConfigs()).toHaveLength(2));
    expect('packetSignaturePolicy' in sentConfigs()[1]).toBe(false);
  });

  it('after a save that failed, the change is still pending and is confirmed again', async () => {
    const user = userEvent.setup();
    h.apiSendAdminCommand.mockRejectedValueOnce(new Error('The node is restarting'));
    await renderAndLoad();
    await user.selectOptions(picker(), String(BALANCED));

    save();
    await user.click(await screen.findByRole('button', { name: 'signature_policy.confirm_balanced_button' }));
    await waitFor(() => expect(sentConfigs()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    save();
    await user.click(await screen.findByRole('button', { name: 'signature_policy.confirm_balanced_button' }));

    await waitFor(() => expect(sentConfigs()).toHaveLength(2));
    expect(sentConfigs()[1].packetSignaturePolicy).toBe(BALANCED);
  });

  it.each([
    ['below 2.8.0', '2.7.15.567b8ea', 'signature_policy.reason_firmware_too_old'],
    ['with no known firmware', null, 'signature_policy.reason_firmware_unknown'],
  ])('a node %s gets a disabled picker with the reason', async (_name, firmwareVersion, reason) => {
    securityAnswer.firmwareVersion = firmwareVersion;
    await renderAndLoad();

    expect(picker()).toBeDisabled();
    expect(within(securitySection()).getByTestId('signature-policy-reason')).toHaveTextContent(reason);

    save();
    await waitFor(() => expect(sentConfigs()).toHaveLength(1));
    expect('packetSignaturePolicy' in sentConfigs()[0]).toBe(false);
  });

  it('switching nodes forgets the policy that was on screen', async () => {
    securityAnswer.packetSignaturePolicy = STRICT;
    await renderAndLoad([localNode, remoteNode], 'local');
    expect(picker().value).toBe(String(STRICT));

    selectRemoteNode();

    await waitFor(() => expect(picker()).toBeDisabled());
    expect(picker().value).toBe('');
  });
});
