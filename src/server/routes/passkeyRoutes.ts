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
 * Not here yet (PR 3): step-up options, the passkey-only switch, recovery
 * codes and the admin view.
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
import { requireAuth } from '../auth/authMiddleware.js';
import { authLimiter } from '../middleware/rateLimiters.js';
import { regenerateSession } from '../auth/regenerateSession.js';
import databaseService from '../../services/database.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { notifyAccessChange } from '../../db/accessChanges.js';
import { stripUserSecrets } from '../utils/userSecrets.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import { PASSKEY_NICKNAME_MAX } from '../../db/repositories/passkeys.js';
import type { User } from '../../types/auth.js';

const router = Router();

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

/** Take the session's challenge, deleting it whatever happens next. */
function takeChallenge(
  req: Request,
  purpose: 'register' | 'login',
  userId?: number,
): { challenge: string; rpId: string; origins: string[] } | null {
  const stored = req.session.webauthnChallenge;
  req.session.webauthnChallenge = undefined;
  if (!stored) return null;
  if (stored.purpose !== purpose) return null;
  if (stored.expiresAt < Date.now()) return null;
  if (purpose === 'register' && stored.userId !== userId) return null;
  return { challenge: stored.challenge, rpId: stored.rpId, origins: stored.origins };
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

router.post('/register/options', requireAuth(), async (req: Request, res: Response) => {
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

router.post('/register/verify', requireAuth(), async (req: Request, res: Response) => {
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

    const response = req.body?.response as RegistrationResponseJSON | undefined;
    if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
      return fail(res, 400, 'INVALID_REQUEST', 'A passkey response is required');
    }

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

    const response = req.body?.response as AuthenticationResponseJSON | undefined;
    if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
      return fail(res, 400, 'INVALID_REQUEST', 'A passkey response is required');
    }

    const loginFailed = (userId: number | null, reason: string) => {
      audit(userId, 'login_failed', { method: 'passkey', reason }, req);
      return fail(res, 401, 'PASSKEY_LOGIN_FAILED', LOGIN_FAILED_MESSAGE);
    };

    const passkey = await databaseService.getPasskeyByCredentialIdAsync(response.id);
    if (!passkey) return loginFailed(null, 'unknown_credential');

    const user = await databaseService.findUserByIdAsync(passkey.userId) as User | null;
    if (!user) return loginFailed(null, 'unknown_user');
    if (!user.isActive) return loginFailed(user.id, 'inactive');
    if (user.authProvider !== 'local') return loginFailed(user.id, 'not_local');

    // A discoverable passkey reports the user handle it was made with; it
    // must name the user the credential row belongs to.
    const userHandle = response.response?.userHandle;
    if (userHandle && userHandle !== isoBase64URL.fromUTF8String(userHandleText(user.id))) {
      return loginFailed(user.id, 'user_handle_mismatch');
    }

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
    if (!verification || !verification.verified) return loginFailed(user.id, 'verify_failed');

    // §7: a non-zero counter must go up. Synced passkeys report 0 forever.
    const newCounter = verification.authenticationInfo.newCounter;
    if (newCounter !== 0 && newCounter <= passkey.counter) {
      return loginFailed(user.id, 'counter_regression');
    }
    await databaseService.updatePasskeyCounterAsync(passkey.id, Math.max(newCounter, passkey.counter));

    // Same session as POST /api/auth/login. No TOTP step (D5).
    const previousSessionId = req.sessionID;
    try {
      await regenerateSession(req);
    } catch (err) {
      logger.error('Session regeneration failed:', err);
      return fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.authProvider = 'local';
    req.session.isAdmin = user.isAdmin;
    if (previousSessionId && previousSessionId !== req.sessionID) {
      notifyAccessChange({ kind: 'session', sessionId: previousSessionId });
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

router.get('/', requireAuth(), async (req: Request, res: Response) => {
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

router.patch('/:id', requireAuth(), async (req: Request, res: Response) => {
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

router.delete('/:id', requireAuth(), async (req: Request, res: Response) => {
  try {
    const user = requireLocalUser(req, res);
    if (!user) return;
    const id = parseId(String(req.params.id));
    if (id === null) return fail(res, 400, 'INVALID_ID', 'Invalid passkey id');

    const owned = await databaseService.listPasskeySummariesForUserAsync(user.id);
    if (!owned.some(p => p.id === id)) return fail(res, 404, 'PASSKEY_NOT_FOUND', 'Passkey not found');

    // A passkey-only account with one passkey left would be locked out.
    const state = await databaseService.getPasskeyLoginStateAsync(user.id);
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

type AuthenticatorTransportFuture = NonNullable<
  Parameters<typeof verifyAuthenticationResponse>[0]['credential']['transports']
>[number];

export default router;
