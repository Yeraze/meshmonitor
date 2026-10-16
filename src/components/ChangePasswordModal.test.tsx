/**
 * @vitest-environment jsdom
 *
 * The forced new-password step after a passkey recovery-code sign-in
 * (#5841 PR 3): no current-password field, and no way to dismiss it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChangePasswordModal from './ChangePasswordModal';

const post = vi.hoisted(() => vi.fn());
vi.mock('../services/api', () => ({ default: { post } }));

describe('ChangePasswordModal', () => {
  beforeEach(() => {
    post.mockReset().mockResolvedValue({ success: true });
  });

  it('forced: asks only for the new password and cannot be dismissed', async () => {
    const onClose = vi.fn();
    render(<ChangePasswordModal isOpen forced onClose={onClose} />);

    expect(screen.getByText('change_password.forced_title')).toBeInTheDocument();
    expect(screen.queryByLabelText('change_password.current_password')).toBeNull();
    expect(screen.queryByText('common.cancel')).toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('presentation'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('change_password.new_password'), { target: { value: 'brand-new-pass' } });
    fireEvent.change(screen.getByLabelText('change_password.confirm_password'), { target: { value: 'brand-new-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'change_password.title' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/auth/change-password', { newPassword: 'brand-new-pass' }));
    expect(await screen.findByText('change_password.success')).toBeInTheDocument();
  });

  it('normal: still needs the current password and can be cancelled', () => {
    const onClose = vi.fn();
    render(<ChangePasswordModal isOpen onClose={onClose} />);
    expect(screen.getByLabelText('change_password.current_password')).toBeInTheDocument();
    fireEvent.click(screen.getByText('common.cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});
