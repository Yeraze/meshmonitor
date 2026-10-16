/**
 * Browser side of passkey sign-in and management (#5841).
 *
 * `@simplewebauthn/browser` loads on first use through a dynamic import, so it
 * stays out of the main chunk (check:bundle-size). The calls to
 * /api/auth/passkey go through ApiService like every other request.
 */
import api from './api.js';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

/** One of the caller's passkeys, as GET /api/auth/passkey lists it. */
export interface PasskeySummary {
  id: number;
  userId: number;
  nickname: string | null;
  deviceType: string | null;
  backedUp: boolean;
  transports: string[];
  /** Hostname the passkey works on. */
  rpId: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface Envelope<T> {
  success: boolean;
  data: T;
}

const BASE = '/api/auth/passkey';

type BrowserLib = typeof import('@simplewebauthn/browser');
let browserLib: Promise<BrowserLib> | null = null;

function loadBrowserLib(): Promise<BrowserLib> {
  if (!browserLib) {
    browserLib = import('@simplewebauthn/browser').catch((err) => {
      browserLib = null;
      throw err;
    });
  }
  return browserLib;
}

/**
 * WebAuthn needs a secure context (HTTPS, or http://localhost). On a plain-HTTP
 * LAN address the browser API is missing, so every passkey control hides.
 */
export function passkeysSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return window.isSecureContext === true && typeof window.PublicKeyCredential === 'function';
}

/** True when the browser can offer passkeys in the username field's autofill. */
export async function passkeyAutofillSupported(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  try {
    const lib = await loadBrowserLib();
    return await lib.browserSupportsWebAuthnAutofill();
  } catch {
    return false;
  }
}

/**
 * Run the sign-in ceremony and post the result. Resolves once the server has
 * built the session. With `autofill`, waits for the user to pick a passkey
 * from the username field's autofill list (conditional UI).
 */
export async function signInWithPasskey(opts: { autofill?: boolean } = {}): Promise<void> {
  const lib = await loadBrowserLib();
  const options = await api.post<Envelope<PublicKeyCredentialRequestOptionsJSON>>(`${BASE}/login/options`, {});
  const response: AuthenticationResponseJSON = await lib.startAuthentication({
    optionsJSON: options.data,
    useBrowserAutofill: opts.autofill === true,
  });
  await api.post(`${BASE}/login/verify`, { response });
}

/** Stop a pending ceremony (for example the autofill wait when a page unmounts). */
export async function cancelPasskeyCeremony(): Promise<void> {
  if (!browserLib) return;
  try {
    const lib = await browserLib;
    lib.WebAuthnAbortService.cancelCeremony();
  } catch {
    // Nothing to cancel.
  }
}

/** Create a passkey on this device for the signed-in user. */
export async function registerPasskey(nickname: string | null): Promise<PasskeySummary> {
  const lib = await loadBrowserLib();
  const options = await api.post<Envelope<PublicKeyCredentialCreationOptionsJSON>>(`${BASE}/register/options`, {});
  const response: RegistrationResponseJSON = await lib.startRegistration({ optionsJSON: options.data });
  const result = await api.post<Envelope<PasskeySummary>>(`${BASE}/register/verify`, { response, nickname });
  return result.data;
}

export async function listPasskeys(): Promise<PasskeySummary[]> {
  const result = await api.get<Envelope<PasskeySummary[]>>(BASE);
  return result.data ?? [];
}

export async function renamePasskey(id: number, nickname: string | null): Promise<PasskeySummary> {
  const result = await api.patch<Envelope<PasskeySummary>>(`${BASE}/${id}`, { nickname });
  return result.data;
}

export async function deletePasskey(id: number): Promise<void> {
  await api.delete(`${BASE}/${id}`);
}

// ── Passkey-only accounts (#5841 PR 3) ───────────────────────────────────────

export interface PasswordLoginState {
  disabled: boolean;
  recoveryCodesLeft: number;
}

/** The server's reply to a password-login change. */
export type PasswordLoginResult =
  | { requireConfirm: true }
  | { disabled: true; recoveryCodes: string[] }
  | { disabled: false };

/** What the last admin types to confirm turning password sign-in off (D3). */
export const LAST_ADMIN_CONFIRM = 'DISABLE';

export async function getPasswordLoginState(): Promise<PasswordLoginState> {
  const result = await api.get<Envelope<PasswordLoginState>>(`${BASE}/password-login`);
  return result.data;
}

/**
 * Run the step-up passkey prompt (D6): options limited to the caller's own
 * passkeys, then the browser's prompt. The assertion goes to
 * `turnOffPasswordLogin`.
 */
export async function runStepUp(): Promise<AuthenticationResponseJSON> {
  const lib = await loadBrowserLib();
  const options = await api.post<Envelope<PublicKeyCredentialRequestOptionsJSON>>(`${BASE}/step-up/options`, {});
  return lib.startAuthentication({ optionsJSON: options.data });
}

/**
 * Turn password sign-in off with a step-up assertion. Resolves with
 * `requireConfirm` when the caller is the only admin and has not yet typed
 * the confirmation; send the same assertion again with `confirm`.
 */
export async function turnOffPasswordLogin(
  assertion: AuthenticationResponseJSON,
  confirm?: string,
): Promise<PasswordLoginResult> {
  const result = await api.post<Envelope<PasswordLoginResult>>(`${BASE}/password-login`, {
    disabled: true,
    assertion,
    ...(confirm ? { confirm } : {}),
  });
  return result.data;
}

export async function turnOnPasswordLogin(): Promise<void> {
  await api.post(`${BASE}/password-login`, { disabled: false });
}

/** Sign in with a recovery code. Password sign-in comes back on. */
export async function recoverWithCode(username: string, code: string): Promise<void> {
  await api.post(`${BASE}/recover`, { username, code });
}

/** Admin: one user's passkeys and passkey-only state. */
export interface AdminUserPasskeys {
  userId: number;
  username: string;
  passwordLoginDisabled: boolean;
  passkeys: PasskeySummary[];
}

export async function adminListUserPasskeys(userId: number): Promise<AdminUserPasskeys> {
  const result = await api.get<Envelope<AdminUserPasskeys>>(`${BASE}/admin/users/${userId}`);
  return result.data;
}

export async function adminRevokeUserPasskey(userId: number, id: number): Promise<void> {
  await api.delete(`${BASE}/admin/users/${userId}/${id}`);
}

/**
 * True when the error means the user closed the browser's passkey prompt (or
 * it timed out). Not worth an error message.
 */
export function isPasskeyCancel(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  const code = (err as { code?: string }).code;
  return name === 'NotAllowedError' || name === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED';
}
