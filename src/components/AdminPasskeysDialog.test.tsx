/**
 * @vitest-environment jsdom
 *
 * Admin passkey dialog (#5841 PR 3): lists a user's passkeys, revokes one
 * after confirming, and explains the server's last-passkey refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import AdminPasskeysDialog from './AdminPasskeysDialog';
import { ApiError } from '../services/api';

const client = vi.hoisted(() => ({
  adminListUserPasskeys: vi.fn(),
  adminRevokeUserPasskey: vi.fn(),
}));
vi.mock('../services/passkeyClient', () => client);

const showToast = vi.fn();
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast }) }));

const pk = (id: number, nickname: string) => ({
  id, userId: 9, nickname, deviceType: 'multiDevice', backedUp: true, transports: [],
  rpId: 'mesh.example.com', createdAt: Date.UTC(2026, 9, 1), lastUsedAt: null,
});

describe('AdminPasskeysDialog', () => {
  beforeEach(() => {
    client.adminListUserPasskeys.mockReset();
    client.adminRevokeUserPasskey.mockReset().mockResolvedValue(undefined);
    showToast.mockReset();
  });

  it('revokes a passkey after confirming and reports the new count', async () => {
    client.adminListUserPasskeys
      .mockResolvedValueOnce({ userId: 9, username: 'bob', passwordLoginDisabled: false, passkeys: [pk(1, 'Laptop'), pk(2, 'Phone')] })
      .mockResolvedValueOnce({ userId: 9, username: 'bob', passwordLoginDisabled: false, passkeys: [pk(2, 'Phone')] });
    const onChanged = vi.fn();
    render(<AdminPasskeysDialog userId={9} username="bob" onClose={vi.fn()} onChanged={onChanged} />);

    const [first] = await screen.findAllByTestId('admin-passkey-item');
    fireEvent.click(within(first).getByText('passkey_admin.revoke'));
    expect(within(first).getByText('passkey_admin.revoke_confirm')).toBeInTheDocument();
    fireEvent.click(within(first).getAllByText('passkey_admin.revoke').at(-1)!);

    await waitFor(() => expect(client.adminRevokeUserPasskey).toHaveBeenCalledWith(9, 1));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(1));
    expect(await screen.findAllByTestId('admin-passkey-item')).toHaveLength(1);
  });

  it("explains why a passkey-only user's last passkey stays", async () => {
    client.adminListUserPasskeys.mockResolvedValue({ userId: 9, username: 'bob', passwordLoginDisabled: true, passkeys: [pk(1, 'Laptop')] });
    client.adminRevokeUserPasskey.mockRejectedValue(new ApiError('no', 409, { code: 'LAST_PASSKEY' }));
    render(<AdminPasskeysDialog userId={9} username="bob" onClose={vi.fn()} />);

    expect(await screen.findByText('passkey_admin.password_off')).toBeInTheDocument();
    const [item] = await screen.findAllByTestId('admin-passkey-item');
    fireEvent.click(within(item).getByText('passkey_admin.revoke'));
    fireEvent.click(within(item).getAllByText('passkey_admin.revoke').at(-1)!);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('passkey_admin.last_passkey', 'error'));
  });
});
