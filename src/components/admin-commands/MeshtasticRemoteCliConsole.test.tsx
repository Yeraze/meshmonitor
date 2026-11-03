/**
 * @vitest-environment jsdom
 *
 * Tests for the Meshtastic free-form remote-admin CLI console (#6154):
 *  - the fixed `meshtastic --dest !id` prefix is shown ahead of the input,
 *  - command output is rendered in the transcript,
 *  - a destructive command routes through the typed-name danger modal and
 *    only sends with confirm:true,
 *  - the console is remote-only (disabled for a local node).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../services/api', () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    body?: unknown;
    constructor(message: string, status: number, opts?: { code?: string; body?: unknown }) {
      super(message);
      this.status = status;
      this.code = opts?.code;
      this.body = opts?.body;
    }
  }
  return {
    default: { sendMeshtasticCli: vi.fn() },
    ApiError,
  };
});

import apiService, { ApiError } from '../../services/api';
import { MeshtasticRemoteCliConsole } from './MeshtasticRemoteCliConsole';

const sendMock = apiService.sendMeshtasticCli as unknown as ReturnType<typeof vi.fn>;

const DEST = '!aabbccdd';

describe('MeshtasticRemoteCliConsole', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sessionStorage.clear();
  });

  it('shows the fixed meshtastic --dest prefix', () => {
    render(<MeshtasticRemoteCliConsole sourceId="s1" destNodeId={DEST} destNodeName="Node Alpha" isLocalNode={false} />);
    expect(screen.getByText(`meshtastic --dest ${DEST}`)).toBeTruthy();
  });

  it('sends args and renders the output', async () => {
    sendMock.mockResolvedValue({ output: 'role=CLIENT', stdout: 'role=CLIENT', stderr: '', exitCode: 0, elapsedMs: 5 });
    render(<MeshtasticRemoteCliConsole sourceId="s1" destNodeId={DEST} destNodeName="Node Alpha" isLocalNode={false} />);

    const input = screen.getByPlaceholderText(/CLI arguments/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '--get device.role' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => expect(sendMock).toHaveBeenCalledWith('s1', DEST, '--get device.role', undefined));
    expect(await screen.findByText('role=CLIENT')).toBeTruthy();
  });

  it('routes a destructive command through the typed-name modal and sends with confirm:true', async () => {
    sendMock.mockResolvedValue({ output: 'Rebooting', stdout: 'Rebooting', stderr: '', exitCode: 0, elapsedMs: 5 });
    render(<MeshtasticRemoteCliConsole sourceId="s1" destNodeId={DEST} destNodeName="Node Alpha" isLocalNode={false} />);

    const input = screen.getByPlaceholderText(/CLI arguments/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '--reboot' } });
    fireEvent.click(screen.getByText('Send'));

    // Modal opened; nothing sent yet.
    expect(screen.getByText('Confirm destructive command')).toBeTruthy();
    expect(sendMock).not.toHaveBeenCalled();

    // Type the node name to unlock, then confirm.
    const confirmInput = screen.getByPlaceholderText('Node Alpha') as HTMLInputElement;
    fireEvent.change(confirmInput, { target: { value: 'Node Alpha' } });
    fireEvent.click(screen.getByText('Send --reboot'));

    await waitFor(() => expect(sendMock).toHaveBeenCalledWith('s1', DEST, '--reboot', { confirm: true }));
  });

  it('opens the danger modal for a Meshtastic-specific destructive flag (shared pattern)', () => {
    render(<MeshtasticRemoteCliConsole sourceId="s1" destNodeId={DEST} destNodeName="Node Alpha" isLocalNode={false} />);
    const input = screen.getByPlaceholderText(/CLI arguments/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '--reset-nodedb' } });
    fireEvent.click(screen.getByText('Send'));
    // --reset-nodedb is Meshtastic-specific and NOT in the shared MeshCore
    // pattern — the modal only appears because the console passes its own
    // dangerPattern to CliConsoleBody.
    expect(screen.getByText('Confirm destructive command')).toBeTruthy();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('renders the server error output and code on failure', async () => {
    sendMock.mockRejectedValue(new ApiError('nonzero', 422, { code: 'CLI_NONZERO_EXIT', body: { output: 'Error: no route to node' } }));
    render(<MeshtasticRemoteCliConsole sourceId="s1" destNodeId={DEST} destNodeName="Node Alpha" isLocalNode={false} />);

    const input = screen.getByPlaceholderText(/CLI arguments/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '--info' } });
    fireEvent.click(screen.getByText('Send'));

    expect(await screen.findByText('Error: no route to node')).toBeTruthy();
  });

  it('is disabled (remote-only) for a local node', () => {
    render(<MeshtasticRemoteCliConsole sourceId="s1" destNodeId={DEST} destNodeName="Node Alpha" isLocalNode={true} />);
    const input = screen.getByPlaceholderText(/remote-only/) as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});
