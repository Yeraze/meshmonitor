/**
 * Upgrade Routes — RETIRED (Auto-Upgrade Retirement, v4.13).
 *
 * In-app upgrade execution (watchdog sidecar, trigger/status files, circuit
 * breaker, unattended scheduler) was removed in v4.13. These endpoints remain
 * mounted for one release so older frontends receive a clean `410 Gone` with a
 * docs link instead of 404 HTML. The router is deleted entirely in a later
 * release.
 *
 * Update detection/notification now lives in versionCheckService and the
 * `/api/system/version/check` endpoint.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/authMiddleware.js';
import { fail } from '../utils/apiResponse.js';

const router = Router();

// All routes require authentication (matches the previous router).
router.use(requireAuth());

const RETIRED_MESSAGE =
  'In-app upgrades were removed in v4.13. See ' +
  'https://yeraze.github.io/meshmonitor/configuration/updating for update instructions.';

function retired(_req: Request, res: Response): Response {
  return fail(res, 410, 'FEATURE_RETIRED', RETIRED_MESSAGE);
}

// Execution endpoints — permanently gone.
router.post('/trigger', retired);
router.post('/cancel/:upgradeId', retired);
router.post('/clear-block', retired);

// Status / history endpoints an older frontend may still poll.
router.get('/status', retired);
router.get('/status/:upgradeId', retired);
router.get('/history', retired);
router.get('/latest-status', retired);
router.get('/test-configuration', retired);

export default router;
