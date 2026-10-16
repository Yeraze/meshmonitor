/**
 * @vitest-environment jsdom
 *
 * Profile passkey list (#5841): renders, renames, deletes, and explains
 * itself when the browser cannot do WebAuthn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import PasskeyManagement from './PasskeyManagement';
import { ApiError } from '../services/api';

const client = vi.hoisted(() => ({
  supported: true,
  listPasskeys: vi.fn(),
  deletePasskey: vi.fn(),
  renamePasskey: vi.fn(),
  registerPasskey: vi.fn(),
}));

vi.mock('../services/passkeyClient', () => ({
  passkeysSupported: () => client.supported,
  listPasskeys: client.listPasskeys,
  deletePasskey: client.deletePasskey,
  renamePasskey: client.renamePasskey,
  registerPasskey: client.registerPasskey,
  isPasskeyCancel: (err: { name?: string }) => err?.name === 'NotAllowedError',
  // The passkey-only switch below the list (PR 3); PasswordLoginControl.test.tsx covers it.
  LAST_ADMIN_CONFIRM: 'DISABLE',
  getPasswordLoginState: vi.fn().mockResolvedValue({ disabled: false, recoveryCodesLeft: 0 }),
  runStepUp: vi.fn(),
  turnOffPasswordLogin: vi.fn(),
  turnOnPasswordLogin: vi.fn(),
}));

const showToast = vi.fn();
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast }) }));

const passkey = (id: number, nickname: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  userId: 7,
  nickname,
  deviceType: 'multiDevice',
  backedUp: true,
  transports: ['internal'],
  rpId: 'mesh.example.com',
  createdAt: Date.UTC(2026, 9, 1),
  lastUsedAt: null,
  ...extra,
});

describe('PasskeyManagement', () => {
  beforeEach(() => {
    client.supported = true;
    client.listPasskeys.mockReset();
    client.deletePasskey.mockReset().mockResolvedValue(undefined);
    client.renamePasskey.mockReset().mockResolvedValue(undefined);
    client.registerPasskey.mockReset().mockResolvedValue(undefined);
    showToast.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('lists passkeys with nickname, hostname, created and last used', async () => {
    client.listPasskeys.mockResolvedValue([
      passkey(1, 'Laptop', { lastUsedAt: Date.UTC(2026, 9, 10) }),
      passkey(2, null),
    ]);
    render(<PasskeyManagement />);

    const items = await screen.findAllByTestId('passkey-item');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Laptop')).toBeInTheDocument();
    expect(within(items[0]).getByText(/passkey\.hostname/)).toBeInTheDocument();
    expect(within(items[1]).getByText('passkey.unnamed')).toBeInTheDocument();
    expect(screen.getByText('passkey.add')).toBeInTheDocument();
    expect(screen.queryByText('passkey.unsupported')).toBeNull();
  });

  it('deletes a passkey after confirming', async () => {
    client.listPasskeys
      .mockResolvedValueOnce([passkey(1, 'Laptop'), passkey(2, 'Phone')])
      .mockResolvedValueOnce([passkey(2, 'Phone')]);
    render(<PasskeyManagement />);

    const [first] = await screen.findAllByTestId('passkey-item');
    fireEvent.click(within(first).getByLabelText('passkey.delete'));
    expect(within(first).getByText('passkey.delete_confirm')).toBeInTheDocument();
    fireEvent.click(within(first).getByText('common.delete'));

    await waitFor(() => expect(client.deletePasskey).toHaveBeenCalledWith(1));
    await waitFor(() => expect(screen.getAllByTestId('passkey-item')).toHaveLength(1));
    expect(screen.queryByText('Laptop')).toBeNull();
    expect(showToast).toHaveBeenCalledWith('passkey.deleted', 'success');
  });

  it('explains the last-passkey refusal', async () => {
    client.listPasskeys.mockResolvedValue([passkey(1, 'Laptop')]);
    client.deletePasskey.mockRejectedValue(new ApiError('nope', 409, { code: 'LAST_PASSKEY' }));
    render(<PasskeyManagement />);

    const [item] = await screen.findAllByTestId('passkey-item');
    fireEvent.click(within(item).getByLabelText('passkey.delete'));
    fireEvent.click(within(item).getByText('common.delete'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('passkey.last_passkey', 'error'));
  });

  it('renames a passkey', async () => {
    client.listPasskeys
      .mockResolvedValueOnce([passkey(1, 'Laptop')])
      .mockResolvedValueOnce([passkey(1, 'Work laptop')]);
    render(<PasskeyManagement />);

    const [item] = await screen.findAllByTestId('passkey-item');
    fireEvent.click(within(item).getByLabelText('passkey.rename'));
    const input = within(item).getByLabelText('passkey.nickname');
    fireEvent.change(input, { target: { value: 'Work laptop' } });
    fireEvent.click(within(item).getByText('common.save'));

    await waitFor(() => expect(client.renamePasskey).toHaveBeenCalledWith(1, 'Work laptop'));
    expect(await screen.findByText('Work laptop')).toBeInTheDocument();
  });

  it('adds a passkey with a nickname', async () => {
    client.listPasskeys.mockResolvedValueOnce([]).mockResolvedValueOnce([passkey(3, 'Phone')]);
    render(<PasskeyManagement />);

    expect(await screen.findByText('passkey.none')).toBeInTheDocument();
    fireEvent.click(screen.getByText('passkey.add'));
    fireEvent.change(screen.getByLabelText('passkey.nickname'), { target: { value: '  Phone ' } });
    fireEvent.click(screen.getByText('passkey.continue'));

    await waitFor(() => expect(client.registerPasskey).toHaveBeenCalledWith('Phone'));
    expect(await screen.findByText('Phone')).toBeInTheDocument();
  });

  it('says why when the browser cannot use passkeys, and hides Add', async () => {
    client.supported = false;
    client.listPasskeys.mockResolvedValue([passkey(1, 'Laptop')]);
    render(<PasskeyManagement />);

    expect(screen.getByText('passkey.unsupported')).toBeInTheDocument();
    expect(await screen.findByText('Laptop')).toBeInTheDocument();
    expect(screen.queryByText('passkey.add')).toBeNull();
  });

  it('leaves the heading to the surrounding dialog when showHeading is false', async () => {
    client.listPasskeys.mockResolvedValue([]);
    const { container } = render(<PasskeyManagement showHeading={false} />);
    await waitFor(() => expect(client.listPasskeys).toHaveBeenCalled());
    const section = container.querySelector('section');
    expect(section?.getAttribute('aria-label')).toBeTruthy();
    expect(section?.hasAttribute('aria-labelledby')).toBe(false);
    expect(container.querySelector('h3')).toBeNull();
  });
});
