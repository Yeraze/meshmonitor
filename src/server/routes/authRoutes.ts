/**
 * Authentication Routes
 *
 * Handles login, logout, OIDC flows, and authentication status
 */

import { Router, Request, Response } from 'express';
import { authenticateLocal, changePassword } from '../auth/localAuth.js';
import {
  isOIDCEnabled,
  generateAuthorizationUrl,
  handleOIDCCallback,
  generateRandomString
} from '../auth/oidcAuth.js';
import { requireAuth } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// Get authentication status
router.get('/status', (req: Request, res: Response) => {
  try {
    if (!req.session.userId) {
      return res.json({
        authenticated: false,
        user: null,
        permissions: {},
        oidcEnabled: isOIDCEnabled()
      });
    }

    const user = databaseService.userModel.findById(req.session.userId);

    if (!user || !user.isActive) {
      // Clear invalid session
      req.session.userId = undefined;
      req.session.username = undefined;
      req.session.authProvider = undefined;
      req.session.isAdmin = undefined;

      return res.json({
        authenticated: false,
        user: null,
        permissions: {},
        oidcEnabled: isOIDCEnabled()
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
      oidcEnabled: isOIDCEnabled()
    });
  } catch (error) {
    logger.error('Error getting auth status:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Local authentication login
router.post('/login', async (req: Request, res: Response) => {
  try {
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

    const redirectUri = process.env.OIDC_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/oidc/callback`;

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

    const redirectUri = process.env.OIDC_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/oidc/callback`;

    // Handle callback and create/update user
    const user = await handleOIDCCallback(
      code as string,
      state as string,
      expectedState,
      codeVerifier,
      expectedNonce,
      redirectUri
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
    const baseUrl = process.env.BASE_URL || '';
    return res.redirect(`${baseUrl}/`);
  } catch (error) {
    logger.error('OIDC callback error:', error);
    return res.status(500).send('OIDC authentication failed');
  }
});

export default router;
