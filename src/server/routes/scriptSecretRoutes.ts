/**
 * Script Secrets API — admin only, write only.
 *
 *   GET    /api/script-secrets         -> { canStore, reason?, secrets: [{ name, updatedAt, status }] }
 *   PUT    /api/script-secrets/:name   { value } -> { name, updatedAt, created }
 *   DELETE /api/script-secrets/:name
 *
 * No response ever carries a value, and nothing here logs the request body.
 * Mounted at /script-secrets, not under /scripts: Express matches paths
 * case-insensitively, so /scripts/:name/... would collide with
 * /scripts/:filename/source.
 */
import { Router, Request, Response } from 'express';
import { requireAdmin } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { ok, fail } from '../utils/apiResponse.js';
import { getScriptSecretStore, ScriptSecretError } from '../services/scriptSecretStore.js';

const router = Router();

router.use(requireAdmin());

function actor(req: Request): number | null {
  return req.user?.id ?? req.session?.userId ?? null;
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const store = getScriptSecretStore();
    const { canStore, reason } = store.capability;
    const secrets = await store.listMetadata();
    return ok(res, { canStore, ...(reason ? { reason } : {}), secrets });
  } catch (error) {
    logger.error('[API] Error listing script secrets:', (error as Error).message);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to list script secrets');
  }
});

router.put('/:name', async (req: Request, res: Response) => {
  const name = String(req.params.name);
  const value: unknown = (req.body as { value?: unknown } | undefined)?.value;
  try {
    const result = await getScriptSecretStore().set(name, value);
    await databaseService.auditLogAsync(
      actor(req),
      result.created ? 'script_secret_created' : 'script_secret_updated',
      'script_secrets',
      JSON.stringify({ name }),
      req.ip || null,
    );
    return ok(res, result);
  } catch (error) {
    if (error instanceof ScriptSecretError) {
      return fail(res, error.status, error.code, error.message);
    }
    // Never pass the error object on: a driver error could quote the row.
    logger.error(`[API] Error saving script secret ${name}`);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to save script secret');
  }
});

router.delete('/:name', async (req: Request, res: Response) => {
  const name = String(req.params.name);
  try {
    const removed = await getScriptSecretStore().delete(name);
    if (!removed) return fail(res, 404, 'NOT_FOUND', 'No script secret by that name');
    await databaseService.auditLogAsync(
      actor(req),
      'script_secret_deleted',
      'script_secrets',
      JSON.stringify({ name }),
      req.ip || null,
    );
    return ok(res);
  } catch (error) {
    logger.error(`[API] Error deleting script secret ${name}:`, (error as Error).message);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to delete script secret');
  }
});

export default router;
