/**
 * @vitest-environment jsdom
 *
 * Passkey sign-in controls on the login screens (#5841): hidden without a
 * secure context or WebAuthn, shown and wired up with both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import LoginModal from './LoginModal';
import LoginPage from './LoginPage';

const auth = vi.hoisted(() => ({
  loginWithPasskey: vi.fn(),
  recoverWithCode: vi.fn(),
  login: vi.fn(),
  verifyMfa: vi.fn(),
  loginWithOIDC: vi.fn(),
  localAuthDisabled: false,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    login: auth.login,
    verifyMfa: auth.verifyMfa,
    loginWithOIDC: auth.loginWithOIDC,
    loginWithPasskey: auth.loginWithPasskey,
    recoverWithCode: auth.recoverWithCode,
    authStatus: {
      authenticated: false,
      user: null,
      oidcEnabled: false,
      localAuthDisabled: auth.localAuthDisabled,
      anonymousDisabled: true,
      customTitle: null,
      customLogoUrl: null,
    },
  }),
}));

// Keep the real passkeysSupported() (it reads window); stub the parts that
// would load @simplewebauthn/browser.
vi.mock('../services/passkeyClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/passkeyClient')>();
  return {
    ...actual,
    passkeyAutofillSupported: vi.fn().mockResolvedValue(false),
    cancelPasskeyCeremony: vi.fn().mockResolvedValue(undefined),
  };
});

const originalSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalPKC = Object.getOwnPropertyDescriptor(window, 'PublicKeyCredential');

function setBrowser({ secure, webauthn }: { secure: boolean; webauthn: boolean }) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: secure });
  Object.defineProperty(window, 'PublicKeyCredential', {
    configurable: true,
    writable: true,
    value: webauthn ? function PublicKeyCredential() {} : undefined,
  });
}

function restoreBrowser() {
  if (originalSecure) Object.defineProperty(window, 'isSecureContext', originalSecure);
  else delete (window as { isSecureContext?: boolean }).isSecureContext;
  if (originalPKC) Object.defineProperty(window, 'PublicKeyCredential', originalPKC);
  else delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
}

const BUTTON = 'passkey.sign_in';

describe('passkey sign-in button', () => {
  beforeEach(() => {
    auth.loginWithPasskey.mockReset().mockResolvedValue(undefined);
    auth.localAuthDisabled = false;
  });
  afterEach(restoreBrowser);

  it('is hidden without a secure context', () => {
    setBrowser({ secure: false, webauthn: true });
    render(<LoginModal isOpen onClose={() => {}} />);
    expect(screen.queryByText(BUTTON)).toBeNull();
    expect(screen.getByLabelText('auth.username')).toHaveAttribute('autocomplete', 'username');
  });

  it('is hidden when the browser has no WebAuthn', () => {
    setBrowser({ secure: true, webauthn: false });
    render(<LoginModal isOpen onClose={() => {}} />);
    expect(screen.queryByText(BUTTON)).toBeNull();
  });

  it('is hidden when local auth is disabled', () => {
    setBrowser({ secure: true, webauthn: true });
    auth.localAuthDisabled = true;
    render(<LoginModal isOpen onClose={() => {}} />);
    expect(screen.queryByText(BUTTON)).toBeNull();
  });

  it('shows in a secure context and starts a passkey sign-in', async () => {
    setBrowser({ secure: true, webauthn: true });
    render(<LoginModal isOpen onClose={() => {}} />);
    expect(screen.getByLabelText('auth.username')).toHaveAttribute('autocomplete', 'username webauthn');
    fireEvent.click(screen.getByText(BUTTON));
    await waitFor(() => expect(auth.loginWithPasskey).toHaveBeenCalledWith());
  });

  it('shows an error when sign-in fails, but not when the user cancels', async () => {
    setBrowser({ secure: true, webauthn: true });
    render(<LoginModal isOpen onClose={() => {}} />);

    auth.loginWithPasskey.mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'NotAllowedError' }));
    fireEvent.click(screen.getByText(BUTTON));
    await waitFor(() => expect(auth.loginWithPasskey).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('passkey.login_failed')).toBeNull();

    auth.loginWithPasskey.mockRejectedValueOnce(new Error('server said no'));
    fireEvent.click(screen.getByText(BUTTON));
    expect(await screen.findByText('passkey.login_failed')).toBeInTheDocument();
  });

  it('appears on the full login page too', () => {
    setBrowser({ secure: true, webauthn: true });
    render(<LoginPage />);
    expect(screen.getByText(BUTTON)).toBeInTheDocument();
  });

  it('is hidden on the full login page without a secure context', () => {
    setBrowser({ secure: false, webauthn: true });
    render(<LoginPage />);
    expect(screen.queryByText(BUTTON)).toBeNull();
  });
});

describe('recovery-code link (#5841 PR 3)', () => {
  const LINK = 'passkey_only.lost_passkey';

  beforeEach(() => {
    auth.recoverWithCode.mockReset().mockResolvedValue(undefined);
    auth.localAuthDisabled = false;
    setBrowser({ secure: true, webauthn: true });
  });
  afterEach(restoreBrowser);

  it('opens a small form and signs in with a code', async () => {
    render(<LoginModal isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByText(LINK));
    const form = screen.getByRole('form', { name: 'passkey_only.recover_title' });
    fireEvent.change(within(form).getByLabelText('auth.username'), { target: { value: '  alice ' } });
    fireEvent.change(within(form).getByLabelText('passkey_only.recovery_code'), { target: { value: ' abcd1234 ' } });
    fireEvent.click(within(form).getByText('passkey_only.recover_submit'));
    await waitFor(() => expect(auth.recoverWithCode).toHaveBeenCalledWith('alice', 'abcd1234'));
  });

  it('shows one generic error when the code does not work', async () => {
    auth.recoverWithCode.mockRejectedValueOnce(new Error('401'));
    render(<LoginPage />);
    fireEvent.click(screen.getByText(LINK));
    const form = screen.getByRole('form', { name: 'passkey_only.recover_title' });
    fireEvent.change(within(form).getByLabelText('auth.username'), { target: { value: 'alice' } });
    fireEvent.change(within(form).getByLabelText('passkey_only.recovery_code'), { target: { value: 'WRONG' } });
    fireEvent.click(within(form).getByText('passkey_only.recover_submit'));
    expect(await screen.findByText('passkey_only.recover_failed')).toBeInTheDocument();
  });

  it('shows without WebAuthn too (codes need no passkey), but not when local auth is off', () => {
    setBrowser({ secure: false, webauthn: false });
    const { unmount } = render(<LoginModal isOpen onClose={() => {}} />);
    expect(screen.getByText(LINK)).toBeInTheDocument();
    unmount();

    auth.localAuthDisabled = true;
    render(<LoginModal isOpen onClose={() => {}} />);
    expect(screen.queryByText(LINK)).toBeNull();
  });
});
