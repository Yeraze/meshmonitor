/**
 * Passkey (WebAuthn) routes, mounted at /api/auth/passkey (#5841, PR 2 of 4).
 *
 * A passkey is a second credential on a LOCAL user (D4). Signing in with one
 * builds the same session as password login, with `authProvider: 'local'`, and
 * skips the TOTP step (D5): a passkey with user verification is already two
 * factors.
 *
 * Challenges live in the session with a 5-minute expiry and are deleted on
 * first use, whether verification passes or fails.
 *
 * PR 3 adds the passkey-only switch (step-up options + password-login),
 * recovery-code sign-in, and the admin view and revoke (spec §8).
 *
 * See docs/internal/dev-notes/PASSKEY_5841_SPEC.md.
 */
import { Router, type Request, type Response } from 'express';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import { requireAuth, requireAdmin } from '../auth/authMiddleware.js';
import { authLimiter } from '../middleware/rateLimiters.js';
import { regenerateSession } from '../auth/regenerateSession.js';
import databaseService from '../../services/database.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { notifyAccessChange } from '../../db/accessChanges.js';
import { stripUserSecrets } from '../utils/userSecrets.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import { PASSKEY_NICKNAME_MAX, type DbPasskey } from '../../db/repositories/passkeys.js';
import { mfaService } from '../services/mfa.js';
import type { User } from '../../types/auth.js';

const router = Router();

/**
 * Passkey management needs a signed-in browser session, not an API token.
 * `requireAuth` also accepts a Bearer token, and a leaked token must not be
 * able to remove a user's passkeys (or, from PR 3, turn off their password
 * login). Registration needs the session for its challenge anyway.
 */
function requireSessionUser(req: Request, res: Response, next: () => void): void {
  if (!req.session?.userId) {
    fail(res, 401, 'SESSION_REQUIRED', 'Passkeys can only be managed from a signed-in browser session');
    return;
  }
  next();
}

/** How long a challenge stays valid (spec §6). */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Same message for every failed passkey login, so a failure reveals nothing. */
const LOGIN_FAILED_MESSAGE = 'Passkey sign-in failed';

interface RelyingParty {
  rpID: string;
  origins: string[];
}

/**
 * The RP ID and allowed origins for this request. WEBAUTHN_RP_ID /
 * WEBAUTHN_ORIGINS win; otherwise both come from the request, which is right
 * behind a proxy only when TRUST_PROXY is right (D7).
 */
export function resolveRelyingParty(req: Request): RelyingParty {
  const env = getEnvironmentConfig();
  const rpID = env.webauthnRpId ?? req.hostname;
  const origins = env.webauthnOrigins.length > 0
    ? env.webauthnOrigins
    : [`${req.protocol}://${req.get('host') ?? req.hostname}`];
  return { rpID, origins };
}

/**
 * The WebAuthn user handle for a user: stable, so a second registration on the
 * same authenticator replaces the first rather than piling up, and free of
 * personal data.
 */
function userHandleText(userId: number): string {
  return `meshmonitor:${userId}`;
}

interface TakenChallenge {
  challenge: string;
  rpId: string;
  origins: string[];
}

/** Take the session's challenge, deleting it whatever happens next. */
function takeChallenge(
  req: Request,
  purpose: 'register' | 'login' | 'step-up',
  userId?: number,
): TakenChallenge | null {
  const stored = req.session.webauthnChallenge;
  req.session.webauthnChallenge = undefined;
  if (!stored) return null;
  if (stored.purpose !== purpose) return null;
  if (stored.expiresAt < Date.now()) return null;
  if (purpose !== 'login' && stored.userId !== userId) return null;
  return { challenge: stored.challenge, rpId: stored.rpId, origins: stored.origins };
}

/**
 * Sign `user` in on a fresh session id (no session fixation), with the same
 * fields POST /api/auth/login sets. False when the session store failed.
 */
async function startLocalSession(req: Request, user: User): Promise<boolean> {
  const previousSessionId = req.sessionID;
  try {
    await regenerateSession(req);
  } catch (err) {
    logger.error('Session regeneration failed:', err);
    return false;
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.authProvider = 'local';
  req.session.isAdmin = user.isAdmin;
  if (previousSessionId && previousSessionId !== req.sessionID) {
    notifyAccessChange({ kind: 'session', sessionId: previousSessionId });
  }
  return true;
}

/**
 * Check a WebAuthn assertion made with `passkey` against a taken challenge,
 * and store the new counter when it passes. Login and step-up share this, so
 * both use the same library call and the same counter rule (§7). Returns null
 * on success, or the failure reason.
 */
async function verifyAssertion(
  passkey: DbPasskey,
  response: AuthenticationResponseJSON,
  challenge: TakenChallenge,
): Promise<string | null> {
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origins,
      expectedRPID: challenge.rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: isoBase64URL.toBuffer(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports as AuthenticatorTransportFuture[],
      },
      requireUserVerification: false,
    });
  } catch (err) {
    logger.debug('Passkey authentication verification threw:', err);
    verification = null;
  }
  if (!verification || !verification.verified) return 'verify_failed';

  // §7: a non-zero counter must go up. Synced passkeys report 0 forever.
  const newCounter = verification.authenticationInfo.newCounter;
  if (newCounter !== 0 && newCounter <= passkey.counter) return 'counter_regression';
  await databaseService.updatePasskeyCounterAsync(passkey.id, Math.max(newCounter, passkey.counter));
  return null;
}

/**
 * Local users only (D4). OIDC users have no local credential to add to, and a
 * proxy-auth session is the proxy's to manage even when it maps onto a local
 * user row.
 */
function isLocalSession(req: Request, user: User): boolean {
  if (user.authProvider !== 'local') return false;
  const sessionProvider = req.session.authProvider;
  return sessionProvider !== 'oidc' && sessionProvider !== 'proxy';
}

/** Undefined when the body has no nickname; null when it is cleared; Error when invalid. */
function parseNickname(raw: unknown): string | null | undefined | Error {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') return new Error('Nickname must be a string');
  const trimmed = raw.trim();
  if (trimmed.length > PASSKEY_NICKNAME_MAX) {
    return new Error(`Nickname must be ${PASSKEY_NICKNAME_MAX} characters or fewer`);
  }
  return trimmed === '' ? null : trimmed;
}

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function audit(userId: number | null, action: string, details: Record<string, unknown>, req: Request): void {
  void databaseService.auditLogAsync(userId, action, 'auth', JSON.stringify(details), req.ip || null);
}

/** Guards shared by the routes that act for a signed-in user on their own passkeys. */
function requireLocalUser(req: Request, res: Response): User | null {
  const user = req.user as User | undefined;
  if (!user) {
    fail(res, 401, 'UNAUTHORIZED', 'Authentication required');
    return null;
  }
  if (!isLocalSession(req, user)) {
    fail(res, 403, 'PASSKEY_LOCAL_ONLY', 'Passkeys are only available for local accounts');
    return null;
  }
  return user;
}

// ── Registration ─────────────────────────────────────────────────────────────

router.post('/register/options', requireAuth(), requireSessionUser, async (req: Request, res: Response) => {
  try {
    if (getEnvironmentConfig().disableLocalAuth) {
      return fail(res, 403, 'LOCAL_AUTH_DISABLED', 'Local authentication is disabled');
    }
    const user = requireLocalUser(req, res);
    if (!user) return;

    const { rpID, origins } = resolveRelyingParty(req);
    const existing = await databaseService.listPasskeysForUserAsync(user.id);
    const options = await generateRegistrationOptions({
      rpName: getEnvironmentConfig().customTitle || 'MeshMonitor',
      rpID,
      userName: user.username,
      userDisplayName: user.displayName || user.username,
      userID: isoUint8Array.fromUTF8String(userHandleText(user.id)),
      attestationType: 'none',
      excludeCredentials: existing.map(p => ({
        id: p.credentialId,
        transports: p.transports,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    req.session.webauthnChallenge = {
      challenge: options.challenge,
      purpose: 'register',
      userId: user.id,
      rpId: rpID,
      origins,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    };
    return ok(res, options);
  } catch (error) {
    logger.error('Passkey registration options error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

router.post('/register/verify', requireAuth(), requireSessionUser, async (req: Request, res: Response) => {
  try {
    if (getEnvironmentConfig().disableLocalAuth) {
      req.session.webauthnChallenge = undefined;
      return fail(res, 403, 'LOCAL_AUTH_DISABLED', 'Local authentication is disabled');
    }
    const user = requireLocalUser(req, res);
    if (!user) {
      req.session.webauthnChallenge = undefined;
      return;
    }

    const challenge = takeChallenge(req, 'register', user.id);
    if (!challenge) {
      return fail(res, 400, 'PASSKEY_CHALLENGE_EXPIRED', 'The passkey request expired. Please try again.');
    }

    const nickname = parseNickname(req.body?.nickname);
    if (nickname instanceof Error) {
      return fail(res, 400, 'INVALID_NICKNAME', nickname.message);
    }

    // A missing or malformed response fails inside verifyRegistrationResponse.
    const response = (req.body?.response ?? {}) as RegistrationResponseJSON;

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origins,
        expectedRPID: challenge.rpId,
        requireUserVerification: false,
      });
    } catch (err) {
      logger.debug('Passkey registration verification threw:', err);
      verification = null;
    }
    if (!verification || !verification.verified) {
      audit(user.id, 'passkey_register_failed', { username: user.username }, req);
      return fail(res, 400, 'PASSKEY_VERIFY_FAILED', 'The passkey could not be verified');
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    if (await databaseService.getPasskeyByCredentialIdAsync(credential.id)) {
      return fail(res, 409, 'PASSKEY_EXISTS', 'This passkey is already registered');
    }

    const id = await databaseService.createPasskeyAsync({
      userId: user.id,
      credentialId: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? response.response?.transports ?? null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      rpId: challenge.rpId,
      nickname: nickname ?? null,
    });

    audit(user.id, 'passkey_registered', {
      username: user.username,
      passkeyId: id,
      rpId: challenge.rpId,
      nickname: nickname ?? null,
    }, req);
    notifyAccessChange({ kind: 'user', userId: user.id });

    const summaries = await databaseService.listPasskeySummariesForUserAsync(user.id);
    return ok(res, summaries.find(p => p.id === id) ?? null);
  } catch (error) {
    logger.error('Passkey registration error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

// ── Login ────────────────────────────────────────────────────────────────────

router.post('/login/options', authLimiter, async (req: Request, res: Response) => {
  try {
    if (getEnvironmentConfig().disableLocalAuth) {
      return fail(res, 403, 'LOCAL_AUTH_DISABLED', 'Local authentication is disabled');
    }
    const { rpID, origins } = resolveRelyingParty(req);
    // Empty allowCredentials: the browser offers any passkey it holds for this
    // RP, so no username is asked for and none can be probed.
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: [],
      userVerification: 'preferred',
    });
    req.session.webauthnChallenge = {
      challenge: options.challenge,
      purpose: 'login',
      rpId: rpID,
      origins,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    };
    return ok(res, options);
  } catch (error) {
    logger.error('Passkey login options error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

router.post('/login/verify', authLimiter, async (req: Request, res: Response) => {
  try {
    if (getEnvironmentConfig().disableLocalAuth) {
      req.session.webauthnChallenge = undefined;
      return fail(res, 403, 'LOCAL_AUTH_DISABLED', 'Local authentication is disabled');
    }

    const challenge = takeChallenge(req, 'login');
    if (!challenge) {
      return fail(res, 400, 'PASSKEY_CHALLENGE_EXPIRED', 'The passkey request expired. Please try again.');
    }

    // A missing or malformed response finds no credential, or fails inside
    // verifyAuthenticationResponse; both end as a failed login.
    const response = (req.body?.response ?? {}) as AuthenticationResponseJSON;
    const credentialId = String(response.id ?? '');

    const loginFailed = (userId: number | null, reason: string) => {
      audit(userId, 'login_failed', { method: 'passkey', reason }, req);
      return fail(res, 401, 'PASSKEY_LOGIN_FAILED', LOGIN_FAILED_MESSAGE);
    };

    const passkey = await databaseService.getPasskeyByCredentialIdAsync(credentialId);
    if (!passkey) return loginFailed(null, 'unknown_credential');

    const user = await databaseService.findUserByIdAsync(passkey.userId) as User | null;
    if (!user) return loginFailed(null, 'unknown_user');
    if (!user.isActive) return loginFailed(user.id, 'inactive');
    if (user.authProvider !== 'local') return loginFailed(user.id, 'not_local');

    // The account comes from the stored credential row, never from the
    // response: the user handle is unsigned, so it is not consulted.

    const failure = await verifyAssertion(passkey, response, challenge);
    if (failure) return loginFailed(user.id, failure);

    // Same session as POST /api/auth/login. No TOTP step (D5).
    if (!(await startLocalSession(req, user))) {
      return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }

    audit(user.id, 'login_success', {
      username: user.username,
      authProvider: 'local',
      method: 'passkey',
      passkeyId: passkey.id,
    }, req);

    return ok(res, { user: stripUserSecrets(user) });
  } catch (error) {
    logger.error('Passkey login error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

// ── The caller's own passkeys ────────────────────────────────────────────────

router.get('/', requireAuth(), requireSessionUser, async (req: Request, res: Response) => {
  try {
    const user = requireLocalUser(req, res);
    if (!user) return;
    const passkeys = await databaseService.listPasskeySummariesForUserAsync(user.id);
    return ok(res, passkeys);
  } catch (error) {
    logger.error('Passkey list error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

router.patch('/:id', requireAuth(), requireSessionUser, async (req: Request, res: Response) => {
  try {
    const user = requireLocalUser(req, res);
    if (!user) return;
    const id = parseId(String(req.params.id));
    if (id === null) return fail(res, 400, 'INVALID_ID', 'Invalid passkey id');

    const nickname = parseNickname(req.body?.nickname);
    if (nickname instanceof Error) return fail(res, 400, 'INVALID_NICKNAME', nickname.message);
    if (nickname === undefined) return fail(res, 400, 'INVALID_NICKNAME', 'A nickname is required');

    const renamed = await databaseService.renamePasskeyAsync(user.id, id, nickname);
    if (!renamed) return fail(res, 404, 'PASSKEY_NOT_FOUND', 'Passkey not found');

    audit(user.id, 'passkey_renamed', { username: user.username, passkeyId: id, nickname }, req);
    const summaries = await databaseService.listPasskeySummariesForUserAsync(user.id);
    return ok(res, summaries.find(p => p.id === id) ?? null);
  } catch (error) {
    logger.error('Passkey rename error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

router.delete('/:id', requireAuth(), requireSessionUser, async (req: Request, res: Response) => {
  try {
    const user = requireLocalUser(req, res);
    if (!user) return;
    const id = parseId(String(req.params.id));
    if (id === null) return fail(res, 400, 'INVALID_ID', 'Invalid passkey id');

    const owned = await databaseService.listPasskeySummariesForUserAsync(user.id);
    if (!owned.some(p => p.id === id)) return fail(res, 404, 'PASSKEY_NOT_FOUND', 'Passkey not found');

    // A passkey-only account with one passkey left would be locked out.
    const state = await databaseService.getPasskeyOnlyStateAsync(user.id);
    if (state?.passwordLoginDisabled && owned.length <= 1) {
      return fail(
        res,
        409,
        'LAST_PASSKEY',
        'This is your only passkey and password sign-in is off. Turn password sign-in back on first.',
      );
    }

    const deleted = await databaseService.deletePasskeyAsync(user.id, id);
    if (!deleted) return fail(res, 404, 'PASSKEY_NOT_FOUND', 'Passkey not found');

    audit(user.id, 'passkey_deleted', { username: user.username, passkeyId: id }, req);
    notifyAccessChange({ kind: 'user', userId: user.id });
    return ok(res);
  } catch (error) {
    logger.error('Passkey delete error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

// ── Passkey-only accounts (§8) ───────────────────────────────────────────────

/** What a recovery code must be told apart by. Generous: codes are 8 hex chars. */
const RECOVERY_CODE_MAX = 32;

/** Same reply for every failed recovery, so a failure reveals nothing. */
const RECOVERY_FAILED_MESSAGE = 'Recovery failed. Check the username and code.';

/** The exact text a last admin types to confirm (D3). */
export const LAST_ADMIN_CONFIRM = 'DISABLE';

/** Stored recovery-code hashes; anything malformed reads as none. */
function parseCodeHashes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** True when no other active admin exists besides `userId`. */
async function isOnlyActiveAdmin(userId: number): Promise<boolean> {
  const users = await databaseService.auth.getAllUsers();
  return !users.some(u => u.isAdmin && u.isActive && u.id !== userId);
}

/**
 * D6 step-up: options for a fresh passkey prompt, limited to the caller's own
 * passkeys. The challenge is single use, tied to this user, and has its own
 * purpose so a login or register challenge cannot stand in for it.
 */
router.post('/step-up/options', requireAuth(), requireSessionUser, async (req: Request, res: Response) => {
  try {
    if (getEnvironmentConfig().disableLocalAuth) {
      return fail(res, 403, 'LOCAL_AUTH_DISABLED', 'Local authentication is disabled');
    }
    const user = requireLocalUser(req, res);
    if (!user) return;

    const owned = await databaseService.listPasskeysForUserAsync(user.id);
    if (owned.length === 0) {
      return fail(res, 409, 'NO_PASSKEYS', 'Add a passkey first');
    }

    const { rpID, origins } = resolveRelyingParty(req);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: owned.map(p => ({
        id: p.credentialId,
        transports: p.transports as AuthenticatorTransportFuture[],
      })),
      userVerification: 'preferred',
    });
    req.session.webauthnChallenge = {
      challenge: options.challenge,
      purpose: 'step-up',
      userId: user.id,
      rpId: rpID,
      origins,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    };
    return ok(res, options);
  } catch (error) {
    logger.error('Passkey step-up options error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

/** The caller's passkey-only state, for the profile dialog. */
router.get('/password-login', requireAuth(), requireSessionUser, async (req: Request, res: Response) => {
  try {
    const user = requireLocalUser(req, res);
    if (!user) return;
    const state = await databaseService.getPasskeyOnlyStateAsync(user.id);
    return ok(res, {
      disabled: state?.passwordLoginDisabled ?? false,
      recoveryCodesLeft: parseCodeHashes(state?.passkeyRecoveryCodes ?? null).length,
    });
  } catch (error) {
    logger.error('Password login state error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

/**
 * Turn password login off (D1, D6) or back on. Off needs a passkey and a
 * fresh step-up assertion from one of the caller's own passkeys; it returns
 * 10 recovery codes, once (D2). The only active admin must also confirm (D3).
 */
router.post('/password-login', requireAuth(), requireSessionUser, async (req: Request, res: Response) => {
  try {
    const user = requireLocalUser(req, res);
    if (!user) return;

    const disabled = req.body?.disabled;
    if (typeof disabled !== 'boolean') {
      return fail(res, 400, 'INVALID_REQUEST', '`disabled` must be true or false');
    }

    if (!disabled) {
      await databaseService.clearPasskeyOnlyAsync(user.id);
      audit(user.id, 'password_login_enabled', { username: user.username }, req);
      notifyAccessChange({ kind: 'user', userId: user.id });
      return ok(res, { disabled: false });
    }

    if (getEnvironmentConfig().disableLocalAuth) {
      return fail(res, 403, 'LOCAL_AUTH_DISABLED', 'Local authentication is disabled');
    }

    const owned = await databaseService.listPasskeysForUserAsync(user.id);
    if (owned.length === 0) {
      return fail(res, 409, 'NO_PASSKEYS', 'Add a passkey before turning off password sign-in');
    }

    // D3: the last admin may go passkey-only, after a typed confirmation.
    // This reply changes nothing and leaves the step-up challenge in the
    // session, so the confirmed retry can send the same assertion.
    const lastAdmin = user.isAdmin && (await isOnlyActiveAdmin(user.id));
    const confirmed = req.body?.confirm === LAST_ADMIN_CONFIRM;
    if (lastAdmin && !confirmed) {
      return ok(res, { requireConfirm: true });
    }

    // D6: a fresh passkey prompt, made with one of the caller's own passkeys.
    const challenge = takeChallenge(req, 'step-up', user.id);
    if (!challenge) {
      return fail(res, 400, 'PASSKEY_CHALLENGE_EXPIRED', 'The passkey request expired. Please try again.');
    }
    const response = (req.body?.assertion ?? {}) as AuthenticationResponseJSON;
    const credentialId = String(response?.id ?? '');
    const passkey = owned.find(p => p.credentialId === credentialId) ?? null;
    const failure = passkey ? await verifyAssertion(passkey, response, challenge) : 'not_owned';
    if (!passkey || failure) {
      audit(user.id, 'passkey_step_up_failed', { username: user.username, reason: failure }, req);
      return fail(res, 401, 'STEP_UP_FAILED', 'The passkey could not be verified');
    }

    // Codes first, then the switch: the account is never passkey-only
    // without a way back in.
    const codes = mfaService.generateBackupCodes();
    const hashes = await mfaService.hashBackupCodes(codes);
    await databaseService.setPasskeyRecoveryCodesAsync(user.id, JSON.stringify(hashes));
    await databaseService.setPasskeyOnlyAsync(user.id, true);

    audit(user.id, 'password_login_disabled', {
      username: user.username,
      passkeyId: passkey.id,
      lastAdmin,
    }, req);
    notifyAccessChange({ kind: 'user', userId: user.id });
    return ok(res, { disabled: true, recoveryCodes: codes });
  } catch (error) {
    logger.error('Password login switch error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

/**
 * Sign in with a recovery code (D2). Spends the code, turns password login
 * back on, clears the other codes, and asks for a new password on the next
 * page. One generic reply for every failure.
 */
router.post('/recover', authLimiter, async (req: Request, res: Response) => {
  try {
    if (getEnvironmentConfig().disableLocalAuth) {
      return fail(res, 403, 'LOCAL_AUTH_DISABLED', 'Local authentication is disabled');
    }

    const recoveryFailed = (userId: number | null, reason: string) => {
      audit(userId, 'passkey_recovery_failed', { reason }, req);
      return fail(res, 401, 'RECOVERY_FAILED', RECOVERY_FAILED_MESSAGE);
    };

    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.replace(/[\s-]/g, '') : '';
    if (!username || !code || code.length > RECOVERY_CODE_MAX) {
      return recoveryFailed(null, 'bad_request');
    }

    const user = await databaseService.findUserByUsernameAsync(username) as User | null;
    if (!user) return recoveryFailed(null, 'unknown_user');
    if (!user.isActive || user.authProvider !== 'local') return recoveryFailed(user.id, 'not_eligible');

    const state = await databaseService.getPasskeyOnlyStateAsync(user.id);
    const stored = state?.passkeyRecoveryCodes ?? null;
    if (!state?.passwordLoginDisabled || !stored) return recoveryFailed(user.id, 'no_codes');

    const remaining = await mfaService.verifyBackupCode(code, parseCodeHashes(stored));
    if (remaining === null) return recoveryFailed(user.id, 'wrong_code');

    // Spend it: only the first of two racing requests changes the row.
    if (!(await databaseService.consumePasskeyRecoveryAsync(user.id, stored))) {
      return recoveryFailed(user.id, 'already_used');
    }

    if (!(await startLocalSession(req, user))) {
      return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
    // A locked password cannot be changed, so do not ask for it.
    const passwordChangeRequired = !user.passwordLocked;
    req.session.passwordChangeRequired = passwordChangeRequired || undefined;

    audit(user.id, 'passkey_recovery_used', {
      username: user.username,
      codesDiscarded: remaining.length,
    }, req);
    audit(user.id, 'login_success', {
      username: user.username,
      authProvider: 'local',
      method: 'recovery_code',
    }, req);
    notifyAccessChange({ kind: 'user', userId: user.id });

    const fresh = await databaseService.findUserByIdAsync(user.id) as User | null;
    return ok(res, { user: stripUserSecrets(fresh ?? user), passwordChangeRequired });
  } catch (error) {
    logger.error('Passkey recovery error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

// ── Admin view and revoke (D1) ───────────────────────────────────────────────

router.get('/admin/users/:userId', requireAdmin(), requireSessionUser, async (req: Request, res: Response) => {
  try {
    const userId = parseId(String(req.params.userId));
    if (userId === null) return fail(res, 400, 'INVALID_ID', 'Invalid user id');
    const target = await databaseService.findUserByIdAsync(userId) as User | null;
    if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'User not found');

    const state = await databaseService.getPasskeyOnlyStateAsync(userId);
    const passkeys = await databaseService.listPasskeySummariesForUserAsync(userId);
    return ok(res, {
      userId,
      username: target.username,
      passwordLoginDisabled: state?.passwordLoginDisabled ?? false,
      passkeys,
    });
  } catch (error) {
    logger.error('Admin passkey list error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

router.delete('/admin/users/:userId/:id', requireAdmin(), requireSessionUser, async (req: Request, res: Response) => {
  try {
    const admin = req.user as User;
    const userId = parseId(String(req.params.userId));
    const id = parseId(String(req.params.id));
    if (userId === null || id === null) return fail(res, 400, 'INVALID_ID', 'Invalid id');

    const target = await databaseService.findUserByIdAsync(userId) as User | null;
    if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'User not found');

    const owned = await databaseService.listPasskeySummariesForUserAsync(userId);
    if (!owned.some(p => p.id === id)) return fail(res, 404, 'PASSKEY_NOT_FOUND', 'Passkey not found');

    // Revoking a passkey-only user's last passkey would lock them out. Refuse
    // rather than turn the password back on behind the admin's back: setting a
    // new password for them does that, and tells them what it is.
    const state = await databaseService.getPasskeyOnlyStateAsync(userId);
    if (state?.passwordLoginDisabled && owned.length <= 1) {
      return fail(
        res,
        409,
        'LAST_PASSKEY',
        'This is the user\'s only passkey and their password sign-in is off. Set a new password for them first.',
      );
    }

    const deleted = await databaseService.deletePasskeyAsync(userId, id);
    if (!deleted) return fail(res, 404, 'PASSKEY_NOT_FOUND', 'Passkey not found');

    audit(admin.id, 'passkey_revoked_by_admin', {
      adminUsername: admin.username,
      targetUserId: userId,
      targetUsername: target.username,
      passkeyId: id,
    }, req);
    notifyAccessChange({ kind: 'user', userId });
    return ok(res);
  } catch (error) {
    logger.error('Admin passkey revoke error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});

type AuthenticatorTransportFuture = NonNullable<
  Parameters<typeof verifyAuthenticationResponse>[0]['credential']['transports']
>[number];

export default router;
