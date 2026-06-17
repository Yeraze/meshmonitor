import { Router, Request, Response } from 'express';
import { getEnvironmentConfig } from '../config/environment.js';

const router: Router = Router();

const env = getEnvironmentConfig();

// Server info endpoint (returns timezone and other server configuration)
router.get('/server-info', (_req: Request, res: Response) => {
  res.json({
    timezone: env.timezone,
    timezoneProvided: env.timezoneProvided,
  });
});

export default router;
