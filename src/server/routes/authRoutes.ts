/**
 * Authentication Routes
 *
 * Handles login, logout, OIDC flows, and authentication status
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { authenticateLocal, changePassword } from '../auth/localAuth.js';
import {
  isOIDCEnabled,
  generateAuthorizationUrl,
  handleOIDCCallback,
  generateRandomString
} from '../auth/oidcAuth.js';
import { requireAuth } from '../auth/authMiddleware.js';
import { authLimiter } from '../middleware/rateLimiters.js';
import { mfaService } from '../services/mfa.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';

const router = Router();

// Get authentication status
router.get('/status', async (req: Request, res: Response) => {
  try {
    const localAuthDisabled = getEnvironmentConfig().disableLocalAuth;
    const anonymousDisabled = getEnvironmentConfig().disableAnonymous;

    if (!req.session.userId) {
      // Check if the session cookie exists at all
      const hasCookie = req.headers.cookie?.includes('meshmonitor.sid');
      if (!hasCookie) {
        // Only log once every 5 minutes to avoid spam
        const lastWarning = (global as any).__lastCookieWarning || 0;
        const now = Date.now();
        if (now - lastWarning > 5 * 60 * 1000) {
          logger.warn('⚠️  /auth/status called without session cookie. Possible causes:');
          logger.warn('   1. Secure cookies enabled but accessing via HTTP');
          logger.warn('   2. Browser blocking cookies (check SameSite, third-party cookie settings)');
          logger.warn('   3. Reverse proxy configuration stripping cookies');
          logger.warn('   4. COOKIE_SECURE or NODE_ENV misconfiguration');
          (global as any).__lastCookieWarning = now;
        }
      }

      // Return anonymous user permissions for unauthenticated users (if anonymous is enabled)
      const anonymousUser = await databaseService.findUserByUsernameAsync('anonymous');
      const anonymousPermissions = anonymousUser && anonymousUser.isActive && !anonymousDisabled
        ? await databaseService.getUserPermissionSetAsync(anonymousUser.id)
        : {};

      return res.json({
        authenticated: false,
        user: null,
        permissions: anonymousPermissions,
        oidcEnabled: isOIDCEnabled(),
        localAuthDisabled,
        anonymousDisabled,
        meshcoreEnabled: process.env.MESHCORE_ENABLED === 'true'
      });
    }

    const user = await databaseService.findUserByIdAsync(req.session.userId);

    if (!user || !user.isActive) {
      // Clear invalid session
      req.session.userId = undefined;
      req.session.username = undefined;
      req.session.authProvider = undefined;
      req.session.isAdmin = undefined;

      // Return anonymous user permissions (if anonymous is enabled)
      const anonymousUser = await databaseService.findUserByUsernameAsync('anonymous');
      const anonymousPermissions = anonymousUser && anonymousUser.isActive && !anonymousDisabled
        ? await databaseService.getUserPermissionSetAsync(anonymousUser.id)
        : {};

      return res.json({
        authenticated: false,
        user: null,
        permissions: anonymousPermissions,
        oidcEnabled: isOIDCEnabled(),
        localAuthDisabled,
        anonymousDisabled,
        meshcoreEnabled: process.env.MESHCORE_ENABLED === 'true'
      });
    }

    // Get user permissions
    const permissions = await databaseService.getUserPermissionSetAsync(user.id);

    // Don't send sensitive fields to client
    const { passwordHash, mfaSecret, mfaBackupCodes, ...safeUser } = user;

    return res.json({
      authenticated: true,
      user: safeUser,
      permissions,
      oidcEnabled: isOIDCEnabled(),
      localAuthDisabled,
      anonymousDisabled,
      meshcoreEnabled: process.env.MESHCORE_ENABLED === 'true'
    });
  } catch (error) {
    logger.error('Error getting auth status:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Check if admin is using default password
router.get('/check-default-password', async (_req: Request, res: Response) => {
  try {
    const admin = await databaseService.findUserByUsernameAsync('admin');

    if (!admin || !admin.passwordHash) {
      // No admin user or no password hash - not using default
      return res.json({ isDefaultPassword: false });
    }

    // Check if password is 'changeme'
    const isDefault = await bcrypt.compare('changeme', admin.passwordHash);

    return res.json({ isDefaultPassword: isDefault });
  } catch (error) {
    logger.error('Error checking default password:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Check for common configuration issues that prevent login
router.get('/check-config-issues', (req: Request, res: Response) => {
  try {
    const config = getEnvironmentConfig();
    const issues: Array<{
      type: 'cookie_secure' | 'allowed_origins';
      severity: 'error' | 'warning';
      message: string;
      docsUrl: string;
    }> = [];

    // Detect the protocol from the request
    const protocol = req.protocol; // 'http' or 'https'
    const isHttps = protocol === 'https' || req.get('x-forwarded-proto') === 'https';

    // Check for COOKIE_SECURE misconfiguration
    // Issue 1: COOKIE_SECURE=true but accessing via HTTP
    if (config.cookieSecure && !isHttps) {
      issues.push({
        type: 'cookie_secure',
        severity: 'error',
        message: 'Secure cookies are enabled but you are accessing via HTTP. Session cookies will not work. Set COOKIE_SECURE=false or access via HTTPS.',
        docsUrl: 'https://meshmonitor.org/faq.html#i-see-a-blank-white-screen-when-accessing-meshmonitor'
      });
    }

    // Issue 2: COOKIE_SECURE=false but accessing via HTTPS
    if (!config.cookieSecure && isHttps) {
      issues.push({
        type: 'cookie_secure',
        severity: 'warning',
        message: 'You are accessing via HTTPS but secure cookies are disabled (COOKIE_SECURE=false). For better security, set COOKIE_SECURE=true.',
        docsUrl: 'https://meshmonitor.org/faq.html#i-see-a-blank-white-screen-when-accessing-meshmonitor'
      });
    }

    // Get the current origin from the request
    const currentOrigin = req.get('origin') || req.get('referer');

    // Check for ALLOWED_ORIGINS misconfiguration
    // Issue: Current origin is not in ALLOWED_ORIGINS list
    // Use the same logic as CORS middleware - include development localhost origins
    if (currentOrigin) {
      try {
        const origin = new URL(currentOrigin).origin;
        // Build the same allowed origins list as CORS middleware
        const allowedOrigins = [...config.allowedOrigins];
        // Always allow localhost in development (same as CORS middleware)
        if (config.isDevelopment) {
          allowedOrigins.push('http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080');
        }
        
        // Only show error if origin is not in the processed list AND we're in production
        // In development, localhost origins are automatically allowed
        if (!allowedOrigins.includes(origin) && !allowedOrigins.includes('*')) {
          // Only show error in production, or if explicitly provided origins don't match
          if (config.allowedOriginsProvided && !config.isDevelopment) {
            issues.push({
              type: 'allowed_origins',
              severity: 'error',
              message: `Your current origin (${origin}) is not in ALLOWED_ORIGINS. CORS will block authentication. Add ${origin} to ALLOWED_ORIGINS.`,
              docsUrl: 'https://meshmonitor.org/faq.html#i-see-a-blank-white-screen-when-accessing-meshmonitor'
            });
          }
        }
      } catch (error) {
        // Invalid URL, skip check
      }
    }

    return res.json({ issues });
  } catch (error) {
    logger.error('Error checking config issues:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Local authentication login
// Apply strict rate limiting to prevent brute force attacks
router.post('/login', authLimiter, async (req: Request, res: Response) => {
  try {
    // Check if local auth is disabled
    const localAuthDisabled = getEnvironmentConfig().disableLocalAuth;
    if (localAuthDisabled) {
      return res.status(403).json({
        error: 'Local authentication is disabled. Please use OIDC to login.'
      });
    }

    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: 'Username and password are required'
      });
    }

    const user = await authenticateLocal(username, password);

    if (!user) {
      // Audit log failed attempt
      databaseService.auditLog(
        null,
        'login_failed',
        'auth',
        JSON.stringify({ username }),
        req.ip || null
      );

      return res.status(401).json({
        error: 'Invalid username or password'
      });
    }

    // Check if MFA is enabled for this user
    if (user.mfaEnabled) {
      // Don't create full session yet - store pending MFA verification
      req.session.pendingMfaUserId = user.id;

      databaseService.auditLog(
        user.id,
        'login_mfa_required',
        'auth',
        JSON.stringify({ username }),
        req.ip || null
      );

      return res.json({
        requireMfa: true,
        userId: user.id
      });
    }

    // Create session (no MFA required)
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.authProvider = 'local';
    req.session.isAdmin = user.isAdmin;

    // Audit log successful login
    databaseService.auditLog(
      user.id,
      'login_success',
      'auth',
      JSON.stringify({ username, authProvider: 'local' }),
      req.ip || null
    );

    // Don't send sensitive fields to client
    const { passwordHash, mfaSecret, mfaBackupCodes, ...safeUser } = user;

    return res.json({
      success: true,
      user: safeUser
    });
  } catch (error) {
    logger.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout
router.post('/logout', (req: Request, res: Response) => {
  const userId = req.session.userId;
  const username = req.session.username;

  req.session.destroy((err) => {
    if (err) {
      logger.error('Error destroying session:', err);
      return res.status(500).json({ error: 'Failed to logout' });
    }

    // Audit log
    if (userId) {
      databaseService.auditLog(
        userId,
        'logout',
        'auth',
        JSON.stringify({ username }),
        req.ip || null
      );
    }

    return res.json({ success: true });
  });
});

// Verify MFA code during two-step login
router.post('/verify-mfa', authLimiter, async (req: Request, res: Response) => {
  try {
    const pendingUserId = req.session.pendingMfaUserId;
    if (!pendingUserId) {
      return res.status(400).json({ error: 'No pending MFA verification' });
    }

    const { token, backupCode } = req.body;
    if (!token && !backupCode) {
      return res.status(400).json({ error: 'A TOTP code or backup code is required' });
    }

    const user = await databaseService.findUserByIdAsync(pendingUserId);
    if (!user || !user.isActive || !user.mfaEnabled || !user.mfaSecret) {
      req.session.pendingMfaUserId = undefined;
      return res.status(401).json({ error: 'Invalid MFA state' });
    }

    let verified = false;

    if (token) {
      verified = mfaService.verifyToken(user.mfaSecret, token);
    } else if (backupCode) {
      const hashedCodes: string[] = JSON.parse(user.mfaBackupCodes || '[]');
      const remaining = await mfaService.verifyBackupCode(backupCode, hashedCodes);
      if (remaining !== null) {
        verified = true;
        await databaseService.consumeBackupCodeAsync(user.id, JSON.stringify(remaining));
        databaseService.auditLog(
          user.id,
          'mfa_backup_code_used',
          'auth',
          JSON.stringify({ username: user.username, action: 'login' }),
          req.ip || null
        );
      }
    }

    if (!verified) {
      databaseService.auditLog(
        user.id,
        'mfa_verify_failed',
        'auth',
        JSON.stringify({ username: user.username }),
        req.ip || null
      );
      return res.status(401).json({ error: 'Invalid code' });
    }

    // MFA verified - create full session
    req.session.pendingMfaUserId = undefined;
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.authProvider = 'local';
    req.session.isAdmin = user.isAdmin;

    databaseService.auditLog(
      user.id,
      'login_success',
      'auth',
      JSON.stringify({ username: user.username, authProvider: 'local', mfa: true }),
      req.ip || null
    );

    // Don't send sensitive fields to client
    const { passwordHash, mfaSecret, mfaBackupCodes, ...safeUser } = user;

    return res.json({
      success: true,
      user: safeUser
    });
  } catch (error) {
    logger.error('MFA verification error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Change password
router.post('/change-password', requireAuth(), async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Current password and new password are required'
      });
    }

    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (req.user.authProvider !== 'local') {
      return res.status(400).json({
        error: 'Cannot change password for non-local user'
      });
    }

    if (req.user.passwordLocked) {
      return res.status(403).json({
        error: 'Password changes are locked for this account'
      });
    }

    await changePassword(req.user.id, currentPassword, newPassword);

    return res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    logger.error('Password change error:', error);
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to change password'
    });
  }
});

// OIDC Login - Initiate flow
router.get('/oidc/login', async (req: Request, res: Response) => {
  try {
    if (!isOIDCEnabled()) {
      return res.status(400).json({
        error: 'OIDC authentication is not configured'
      });
    }

    const redirectUri = getEnvironmentConfig().oidcRedirectUri || `${req.protocol}://${req.get('host')}/api/auth/oidc/callback`;

    // Generate PKCE parameters
    const state = generateRandomString(32);
    const codeVerifier = generateRandomString(128);
    const nonce = generateRandomString(32);

    // Store in session
    req.session.oidcState = state;
    req.session.oidcCodeVerifier = codeVerifier;
    req.session.oidcNonce = nonce;

    // Generate authorization URL
    const authUrl = await generateAuthorizationUrl(
      redirectUri,
      state,
      codeVerifier,
      nonce
    );

    return res.json({ authUrl });
  } catch (error) {
    logger.error('OIDC login error:', error);
    return res.status(500).json({ error: 'Failed to initiate OIDC login' });
  }
});

// OIDC Callback
router.get('/oidc/callback', async (req: Request, res: Response) => {
  try {
    logger.debug('🔐 OIDC callback received', {
      hasCode: !!req.query.code,
      hasState: !!req.query.state,
      protocol: req.protocol,
      host: req.get('host')
    });

    if (!isOIDCEnabled()) {
      return res.status(400).send('OIDC authentication is not configured');
    }

    const { code, state } = req.query;

    if (!code || !state) {
      return res.status(400).send('Missing code or state parameter');
    }

    const expectedState = req.session.oidcState;
    const codeVerifier = req.session.oidcCodeVerifier;
    const expectedNonce = req.session.oidcNonce;

    if (!expectedState || !codeVerifier || !expectedNonce) {
      return res.status(400).send('Invalid session state');
    }

    // Construct the full callback URL with all query parameters
    // This preserves additional parameters like 'iss' (issuer) that some OIDC providers send
    const protocol = req.protocol;
    const host = req.get('host');
    // Use baseUrl + path to get the full mounted path (e.g., /api/auth/oidc/callback)
    // req.path alone would only give /oidc/callback since the router is mounted at /api/auth
    const fullPath = req.baseUrl + req.path;
    const queryString = req.url.split('?')[1] || '';
    const fullCallbackUrl = new URL(`${protocol}://${host}${fullPath}?${queryString}`);

    // Handle callback and create/update user
    const user = await handleOIDCCallback(
      fullCallbackUrl,
      expectedState,
      codeVerifier,
      expectedNonce
    );

    // Clear OIDC session data
    req.session.oidcState = undefined;
    req.session.oidcCodeVerifier = undefined;
    req.session.oidcNonce = undefined;

    // Create session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.authProvider = 'oidc';
    req.session.isAdmin = user.isAdmin;

    // Audit log
    databaseService.auditLog(
      user.id,
      'login_success',
      'auth',
      JSON.stringify({ username: user.username, authProvider: 'oidc' }),
      req.ip || null
    );

    // Save session before redirecting to ensure session cookie is set
    // This prevents issues where the redirect happens before session is saved
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => {
        if (err) {
          logger.error('Failed to save session:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Redirect to app
    const baseUrl = getEnvironmentConfig().baseUrl;
    logger.debug('🔐 OIDC login successful, redirecting to:', `${baseUrl}/`);
    return res.redirect(`${baseUrl}/`);
  } catch (error) {
    logger.error('OIDC callback error:', error);
    return res.status(500).send('OIDC authentication failed');
  }
});

export default router;
