/**
 * Anonymous-send opt-in gate (#6499).
 *
 * A signed-out visitor is the seeded `anonymous` user (or no user at all).
 * That account may hold write grants, but a grant alone must not let a
 * visitor transmit: the admin has to turn `allowAnonymousSend` on as well.
 * Run this before any permission lookup or node resolution on a route that
 * can transmit.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import databaseService from '../../services/database.js';
import { fail } from './apiResponse.js';

export function isAnonymousRequest(req: Request): boolean {
  return !req.user || req.user.username === 'anonymous';
}

export async function isAnonymousSendAllowed(): Promise<boolean> {
  const raw = await databaseService.settings.getSetting('allowAnonymousSend');
  return raw === '1' || raw === 'true';
}

/** Send a 401 and return true when an anonymous request may not transmit. */
export async function refuseAnonymousSend(req: Request, res: Response): Promise<boolean> {
  if (!isAnonymousRequest(req)) return false;
  if (await isAnonymousSendAllowed()) return false;
  fail(res, 401, 'AUTH_REQUIRED', 'Sign in to send messages. Anonymous sending is turned off.');
  return true;
}

export function requireAnonymousSendAllowed(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    refuseAnonymousSend(req, res).then(
      (refused) => {
        if (!refused) next();
      },
      next,
    );
  };
}
