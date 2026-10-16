/**
 * @vitest-environment jsdom
 *
 * Passkey-only switch (#5841 PR 3): the turn-off flow with its step-up
 * prompt, the last-admin DISABLE confirm, turning it back on, and the
 * recovery-codes dialog that cannot close until "I saved these" is ticked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PasswordLoginControl from './PasswordLoginControl';
import RecoveryCodesDialog from './RecoveryCodesDialog';
import { ApiError } from '../services/api';

const client = vi.hoisted(() => ({
  getPasswordLoginState: vi.fn(),
  runStepUp: vi.fn(),
  turnOffPasswordLogin: vi.fn(),
  turnOnPasswordLogin: vi.fn(),
}));

vi.mock('../services/passkeyClient', () => ({
  LAST_ADMIN_CONFIRM: 'DISABLE',
  getPasswordLoginState: client.getPasswordLoginState,
  runStepUp: client.runStepUp,
  turnOffPasswordLogin: client.turnOffPasswordLogin,
  turnOnPasswordLogin: client.turnOnPasswordLogin,
  isPasskeyCancel: (err: { name?: string }) => err?.name === 'NotAllowedError',
}));

const showToast = vi.fn();
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast }) }));

const CODES = ['AAAA1111', 'BBBB2222', 'CCCC3333', 'DDDD4444', 'EEEE5555', 'FFFF6666', 'AAAA7777', 'BBBB8888', 'CCCC9999', 'DDDD0000'];
const ASSERTION = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {}, clientExtensionResults: {} };

describe('PasswordLoginControl', () => {
  beforeEach(() => {
    client.getPasswordLoginState.mockReset().mockResolvedValue({ disabled: false, recoveryCodesLeft: 0 });
    client.runStepUp.mockReset().mockResolvedValue(ASSERTION);
    client.turnOffPasswordLogin.mockReset();
    client.turnOnPasswordLogin.mockReset().mockResolvedValue(undefined);
    showToast.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('turns password sign-in off after a step-up prompt and shows the codes', async () => {
    client.turnOffPasswordLogin.mockResolvedValue({ disabled: true, recoveryCodes: CODES });
    render(<PasswordLoginControl passkeyCount={1} supported />);

    fireEvent.click(await screen.findByText('passkey_only.turn_off'));
    // Explains first; nothing has run yet.
    expect(screen.getByText('passkey_only.explain_codes')).toBeInTheDocument();
    expect(client.runStepUp).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('passkey_only.continue'));
    await waitFor(() => expect(screen.getByText('AAAA1111')).toBeInTheDocument());
    expect(client.runStepUp).toHaveBeenCalledTimes(1);
    expect(client.turnOffPasswordLogin).toHaveBeenCalledWith(ASSERTION, undefined);
    expect(screen.getAllByRole('listitem').filter(li => /^[A-F0-9]{8}$/.test(li.textContent ?? ''))).toHaveLength(10);
  });

  it('asks the only admin to type DISABLE, then resends the same assertion', async () => {
    client.turnOffPasswordLogin
      .mockResolvedValueOnce({ requireConfirm: true })
      .mockResolvedValueOnce({ disabled: true, recoveryCodes: CODES });
    render(<PasswordLoginControl passkeyCount={2} supported />);

    fireEvent.click(await screen.findByText('passkey_only.turn_off'));
    fireEvent.click(screen.getByText('passkey_only.continue'));

    await screen.findByText('passkey_only.last_admin_warning');
    const confirmButton = screen.getByRole('button', { name: 'passkey_only.confirm_off' });
    expect(confirmButton).toBeDisabled();

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'disable' } });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(input, { target: { value: 'DISABLE' } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() => expect(screen.getByText('AAAA1111')).toBeInTheDocument());
    // One browser prompt for both requests.
    expect(client.runStepUp).toHaveBeenCalledTimes(1);
    expect(client.turnOffPasswordLogin).toHaveBeenNthCalledWith(2, ASSERTION, 'DISABLE');
  });

  it('closing the browser prompt is not an error', async () => {
    client.runStepUp.mockRejectedValue(Object.assign(new Error('closed'), { name: 'NotAllowedError' }));
    render(<PasswordLoginControl passkeyCount={1} supported />);
    fireEvent.click(await screen.findByText('passkey_only.turn_off'));
    fireEvent.click(screen.getByText('passkey_only.continue'));
    await waitFor(() => expect(client.runStepUp).toHaveBeenCalled());
    expect(client.turnOffPasswordLogin).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a failed step-up shows why and keeps password sign-in', async () => {
    client.turnOffPasswordLogin.mockRejectedValue(new ApiError('no', 401, { code: 'STEP_UP_FAILED' }));
    render(<PasswordLoginControl passkeyCount={1} supported />);
    fireEvent.click(await screen.findByText('passkey_only.turn_off'));
    fireEvent.click(screen.getByText('passkey_only.continue'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('passkey_only.step_up_failed', 'error'));
    expect(screen.getByText('passkey_only.turn_off')).toBeInTheDocument();
  });

  it('cannot turn off without a passkey', async () => {
    render(<PasswordLoginControl passkeyCount={0} supported />);
    expect(await screen.findByText('passkey_only.turn_off')).toBeDisabled();
    expect(screen.getByText('passkey_only.need_passkey')).toBeInTheDocument();
  });

  it('turns password sign-in back on', async () => {
    client.getPasswordLoginState
      .mockResolvedValueOnce({ disabled: true, recoveryCodesLeft: 7 })
      .mockResolvedValueOnce({ disabled: false, recoveryCodesLeft: 0 });
    render(<PasswordLoginControl passkeyCount={1} supported />);
    fireEvent.click(await screen.findByText('passkey_only.turn_on'));
    await waitFor(() => expect(client.turnOnPasswordLogin).toHaveBeenCalled());
    expect(await screen.findByText('passkey_only.turn_off')).toBeInTheDocument();
  });
});

describe('RecoveryCodesDialog', () => {
  it('cannot close until "I saved these" is ticked', () => {
    const onClose = vi.fn();
    render(<RecoveryCodesDialog codes={CODES} username="alice" onClose={onClose} />);

    const done = screen.getByRole('button', { name: 'common.done' });
    expect(done).toBeDisabled();
    fireEvent.click(done);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    // The overlay does not close it either.
    fireEvent.click(screen.getByRole('presentation'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('AAAA1111')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('copies and downloads the codes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    render(<RecoveryCodesDialog codes={CODES} username="alice" onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('passkey_only.copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODES.join('\n')));
    expect(await screen.findByText('passkey_only.copied')).toBeInTheDocument();

    fireEvent.click(screen.getByText('passkey_only.download'));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });
});
