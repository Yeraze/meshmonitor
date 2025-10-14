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
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';

const router = Router();

// Get authentication status
router.get('/status', (req: Request, res: Response) => {
  try {
    const localAuthDisabled = getEnvironmentConfig().disableLocalAuth;

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

      // Return anonymous user permissions for unauthenticated users
      const anonymousUser = databaseService.userModel.findByUsername('anonymous');
      const anonymousPermissions = anonymousUser && anonymousUser.isActive
        ? databaseService.permissionModel.getUserPermissionSet(anonymousUser.id)
        : {};

      return res.json({
        authenticated: false,
        user: null,
        permissions: anonymousPermissions,
        oidcEnabled: isOIDCEnabled(),
        localAuthDisabled
      });
    }

    const user = databaseService.userModel.findById(req.session.userId);

    if (!user || !user.isActive) {
      // Clear invalid session
      req.session.userId = undefined;
      req.session.username = undefined;
      req.session.authProvider = undefined;
      req.session.isAdmin = undefined;

      // Return anonymous user permissions
      const anonymousUser = databaseService.userModel.findByUsername('anonymous');
      const anonymousPermissions = anonymousUser && anonymousUser.isActive
        ? databaseService.permissionModel.getUserPermissionSet(anonymousUser.id)
        : {};

      return res.json({
        authenticated: false,
        user: null,
        permissions: anonymousPermissions,
        oidcEnabled: isOIDCEnabled(),
        localAuthDisabled
      });
    }

    // Get user permissions
    const permissions = databaseService.permissionModel.getUserPermissionSet(user.id);

    // Don't send password hash to client
    const { passwordHash, ...userWithoutPassword } = user;

    return res.json({
      authenticated: true,
      user: userWithoutPassword,
      permissions,
      oidcEnabled: isOIDCEnabled(),
      localAuthDisabled
    });
  } catch (error) {
    logger.error('Error getting auth status:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Check if admin is using default password
router.get('/check-default-password', (_req: Request, res: Response) => {
  try {
    const admin = databaseService.userModel.findByUsername('admin');

    if (!admin || !admin.passwordHash) {
      // No admin user or no password hash - not using default
      return res.json({ isDefaultPassword: false });
    }

    // Check if password is 'changeme'
    const isDefault = bcrypt.compareSync('changeme', admin.passwordHash);

    return res.json({ isDefaultPassword: isDefault });
  } catch (error) {
    logger.error('Error checking default password:', error);
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

    // Create session
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

    // Don't send password hash to client
    const { passwordHash, ...userWithoutPassword } = user;

    return res.json({
      success: true,
      user: userWithoutPassword
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

    const env = getEnvironmentConfig();
    const configuredRedirectUri = env.oidcRedirectUri;
    const fallbackRedirectUri = `${req.protocol}://${req.get('host')}/api/auth/oidc/callback`;
    const redirectUri = configuredRedirectUri || fallbackRedirectUri;

    // Debug logging to trace redirect URI
    logger.info('🔍 OIDC Login - Redirect URI Debug:');
    logger.info(`  - OIDC_REDIRECT_URI env var: ${configuredRedirectUri || '(not set)'}`);
    logger.info(`  - Fallback constructed URI: ${fallbackRedirectUri}`);
    logger.info(`  - Final redirectUri used: ${redirectUri}`);
    logger.info(`  - Request protocol: ${req.protocol}`);
    logger.info(`  - Request host: ${req.get('host')}`);
    logger.info(`  - Request path: ${req.path}`);
    logger.info(`  - Request originalUrl: ${req.originalUrl}`);

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

    logger.info(`  - Generated authUrl: ${authUrl}`);

    return res.json({ authUrl });
  } catch (error) {
    logger.error('OIDC login error:', error);
    return res.status(500).json({ error: 'Failed to initiate OIDC login' });
  }
});

// OIDC Callback
router.get('/oidc/callback', async (req: Request, res: Response) => {
  try {
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
    const path = req.path;
    const queryString = req.url.split('?')[1] || '';
    const fullCallbackUrl = new URL(`${protocol}://${host}${path}?${queryString}`);

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

    // Redirect to app
    const baseUrl = getEnvironmentConfig().baseUrl;
    return res.redirect(`${baseUrl}/`);
  } catch (error) {
    logger.error('OIDC callback error:', error);
    return res.status(500).send('OIDC authentication failed');
  }
});

export default router;
