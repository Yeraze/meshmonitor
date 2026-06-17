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

// Primary health check used by upgrade watchdog and external monitoring
router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    version: packageJson.version,
    uptime: Date.now() - moduleStartTime,
    databaseType: databaseService.drizzleDbType,
    firmwareOtaEnabled: process.env.IS_DESKTOP !== 'true',
  });
});

// Secondary health check endpoint (returns environment info)
router.get('/', optionalAuth(), (_req: Request, res: Response) => {
  const env = getEnvironmentConfig();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    nodeEnv: env.nodeEnv,
  });
});

export default router;
