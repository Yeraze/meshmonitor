import { createRequire } from 'module';
import { Router, Request, Response } from 'express';
import { optionalAuth } from '../auth/authMiddleware.js';
import { getEnvironmentConfig } from '../config/environment.js';
import databaseService from '../../services/database.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json');

// Captured at module load time (modules load during server startup)
const moduleStartTime = Date.now();

const router = Router();

// Health check used by container/orchestrator probes, the upgrade watchdog, and
// the authenticated frontend (SettingsTab, useHealth, ConfigurationTab).
//
// Anonymous callers get only { status: 'ok' } — enough for a load-balancer or
// k8s probe, which only needs HTTP 200. The exact version, database backend,
// uptime, and firmware-OTA flag are reconnaissance aids (#6084), so they are
// returned only to an authenticated caller. The frontend fetches same-origin,
// so its session cookie reaches this route and it still receives full detail.
router.get('/', optionalAuth(), (req: Request, res: Response) => {
  // optionalAuth attaches the shared "anonymous" account when no real user is
  // signed in, so presence of req.user is not enough — check the username.
  const isAuthenticated = !!req.user && req.user.username !== 'anonymous';
  if (!isAuthenticated) {
    return res.json({ status: 'ok' });
  }

  const env = getEnvironmentConfig();
  res.json({
    status: 'ok',
    version: packageJson.version,
    uptime: Date.now() - moduleStartTime,
    databaseType: databaseService.drizzleDbType,
    firmwareOtaEnabled: process.env.IS_DESKTOP !== 'true',
    timestamp: new Date().toISOString(),
    nodeEnv: env.nodeEnv,
  });
});

export default router;
