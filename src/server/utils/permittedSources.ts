/**
 * Shared permitted-source-id resolution (#4964 post-epic follow-ups).
 *
 * Extracted verbatim (behavior-preserving) from the near-identical private
 * copies that used to live in `analysisRoutes.ts` and `meshIssuesRoutes.ts`.
 * `meshIssuesRoutes.ts`'s copy carried this note:
 *
 *   "This mirrors `resolvePermittedSourceIds()` in `analysisRoutes.ts`,
 *   copied below rather than exported/refactored — see
 *   MESH_ISSUES_P1_SPEC.md §2.16 / §5.13."
 *
 * That copy was intentional for Phase 1 (avoiding a refactor of a
 * 1000+ line file mid-epic); this module is the deferred follow-up that
 * finally unifies them.
 */
import { Request } from 'express';
import databaseService from '../../services/database.js';
import type { Source } from '../../db/repositories/sources.js';

/**
 * Resolves the requesting user's permitted source ids for a given
 * permission `resource` (default `'nodes'`): admin -> every enabled source;
 * otherwise every enabled source the user (or the anonymous user, id 0, when
 * unauthenticated) can `read`.
 *
 * `allSourcesIn` lets a caller that already fetched `getAllSources()` share
 * that single query rather than paying for a second round trip here.
 */
export async function resolvePermittedSourceIds(
  req: Request,
  resource: string = 'nodes',
  allSourcesIn?: Source[],
): Promise<string[]> {
  const user = req.user;
  const isAdmin = user?.isAdmin ?? false;
  const allSources = allSourcesIn ?? (await databaseService.sources.getAllSources());
  const enabled = allSources.filter((s) => s.enabled !== false);

  if (isAdmin) return enabled.map((s) => s.id);

  const checks = await Promise.all(
    enabled.map(async (s) => {
      const ok = user
        ? await databaseService.checkPermissionAsync(user.id, resource, 'read', s.id)
        : await databaseService.checkPermissionAsync(0, resource, 'read', s.id);
      return ok ? s.id : null;
    }),
  );
  return checks.filter((id): id is string => id !== null);
}

/**
 * Parses a comma-separated `sources` query param into a trimmed, non-empty
 * string array, or `null` when the param is absent/blank (caller then falls
 * back to the full permitted set).
 */
export function parseSourcesParam(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
