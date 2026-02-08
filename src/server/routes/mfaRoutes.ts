/**
 * MFA Routes
 *
 * Handles TOTP-based two-factor authentication setup, verification, and management.
 * All routes require authentication and rate limiting.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/authMiddleware.js';
import { authLimiter } from '../middleware/rateLimiters.js';
import { mfaService } from '../services/mfa.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

const router = Router();

/**
 * GET /api/mfa/status
 * Returns whether MFA is enabled for the current user.
 */
router.get('/status', requireAuth(), async (req: Request, res: Response) => {
  try {
    return res.json({ enabled: req.user!.mfaEnabled });
  } catch (error) {
    logger.error('MFA status error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/mfa/setup
 * Generate TOTP secret, QR code, and backup codes.
 * Stores secret in DB but does NOT enable MFA until verify-setup is called.
 * Only available for local auth users.
 */
router.post('/setup', requireAuth(), authLimiter, async (req: Request, res: Response) => {
  try {
    const user = req.user!;

    if (user.authProvider !== 'local') {
      return res.status(400).json({ error: 'MFA is only available for local authentication accounts' });
    }

    if (user.mfaEnabled) {
      return res.status(400).json({ error: 'MFA is already enabled. Disable it first to reconfigure.' });
    }

    // Generate TOTP secret and QR code
    const { secret, otpauthUrl } = mfaService.generateSecret(user.username);
    const qrCodeDataUrl = await mfaService.generateQrCode(otpauthUrl);

    // Generate backup codes (plain text to show user)
    const backupCodes = mfaService.generateBackupCodes();
    const hashedBackupCodes = await mfaService.hashBackupCodes(backupCodes);

    // Store secret and hashed backup codes in DB (mfaEnabled stays false)
    await databaseService.updateUserMfaSecretAsync(
      user.id,
      secret,
      JSON.stringify(hashedBackupCodes)
    );

    // Audit log
    databaseService.auditLog(
      user.id,
      'mfa_setup_initiated',
      'auth',
      JSON.stringify({ username: user.username }),
      req.ip || null
    );

    return res.json({
      qrCodeDataUrl,
      secret,
      backupCodes
    });
  } catch (error) {
    logger.error('MFA setup error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/mfa/verify-setup
 * Verify a TOTP code to complete MFA setup and enable it.
 */
router.post('/verify-setup', requireAuth(), authLimiter, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Verification code is required' });
    }

    if (user.mfaEnabled) {
      return res.status(400).json({ error: 'MFA is already enabled' });
    }

    // Fetch fresh user data to get the stored secret
    const freshUser = await databaseService.findUserByIdAsync(user.id);
    if (!freshUser || !freshUser.mfaSecret) {
      return res.status(400).json({ error: 'MFA setup has not been initiated. Please start setup first.' });
    }

    // Verify the token
    const isValid = mfaService.verifyToken(freshUser.mfaSecret, token);
    if (!isValid) {
      databaseService.auditLog(
        user.id,
        'mfa_setup_verify_failed',
        'auth',
        JSON.stringify({ username: user.username }),
        req.ip || null
      );
      return res.status(400).json({ error: 'Invalid verification code. Please try again.' });
    }

    // Enable MFA
    await databaseService.enableUserMfaAsync(user.id);

    // Audit log
    databaseService.auditLog(
      user.id,
      'mfa_enabled',
      'auth',
      JSON.stringify({ username: user.username }),
      req.ip || null
    );

    return res.json({ success: true });
  } catch (error) {
    logger.error('MFA verify-setup error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/mfa/disable
 * Disable MFA. Requires current TOTP code or backup code.
 */
router.post('/disable', requireAuth(), authLimiter, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { token, backupCode } = req.body;

    if (!user.mfaEnabled) {
      return res.status(400).json({ error: 'MFA is not enabled' });
    }

    // Fetch fresh user data
    const freshUser = await databaseService.findUserByIdAsync(user.id);
    if (!freshUser || !freshUser.mfaSecret) {
      return res.status(400).json({ error: 'MFA configuration not found' });
    }

    let verified = false;

    if (token) {
      // Verify TOTP token
      verified = mfaService.verifyToken(freshUser.mfaSecret, token);
    } else if (backupCode) {
      // Verify backup code
      const hashedCodes: string[] = JSON.parse(freshUser.mfaBackupCodes || '[]');
      const remaining = await mfaService.verifyBackupCode(backupCode, hashedCodes);
      if (remaining !== null) {
        verified = true;
        // Update remaining backup codes
        await databaseService.consumeBackupCodeAsync(user.id, JSON.stringify(remaining));
        databaseService.auditLog(
          user.id,
          'mfa_backup_code_used',
          'auth',
          JSON.stringify({ username: user.username, action: 'disable' }),
          req.ip || null
        );
      }
    } else {
      return res.status(400).json({ error: 'A TOTP code or backup code is required to disable MFA' });
    }

    if (!verified) {
      databaseService.auditLog(
        user.id,
        'mfa_disable_failed',
        'auth',
        JSON.stringify({ username: user.username }),
        req.ip || null
      );
      return res.status(401).json({ error: 'Invalid code' });
    }

    // Disable MFA
    await databaseService.clearUserMfaAsync(user.id);

    // Audit log
    databaseService.auditLog(
      user.id,
      'mfa_disabled',
      'auth',
      JSON.stringify({ username: user.username }),
      req.ip || null
    );

    return res.json({ success: true });
  } catch (error) {
    logger.error('MFA disable error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
