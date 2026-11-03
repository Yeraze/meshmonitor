/**
 * Meshtastic remote-admin routes — nested under `/api/sources/:id/meshtastic`.
 *
 * Currently hosts the free-form CLI console (#6154): the operator types only
 * the `meshtastic` CLI arguments, and MeshMonitor relays them to a selected
 * remote node through that source's Virtual Node, mirroring the MeshCore
 * `POST /admin/cli` console.
 *
 * SECURITY — deliberate maintainer decisions (see the PR for #6154):
 *   - FULL pass-through of CLI flags, no allowlist. Flags like
 *     `--export-config` / `--configure` / `--host` are reachable; the operator
 *     accepts that. The mitigations are the ones below, not an input filter.
 *   - REMOTE ONLY. Every invocation targets `--dest !xxxxxxxx`; there is no
 *     local-node mode.
 *   - NO SHELL, EVER. The argument string is split into an argv array by a
 *     quote-aware splitter (meshtasticCli.parseCliArgs) and handed to
 *     `execFile` with that array (meshtasticCliRunner). User input never
 *     reaches a shell and is never interpolated into a command string.
 *   - Destructive commands (`--reboot`, `--factory-reset`, …) require
 *     `confirm: true`, enforced here so a script or direct API call cannot
 *     bypass the frontend's typed-name modal.
 *   - VN-ONLY transport. When the Virtual Node is disabled for the source the
 *     request is refused (409 VIRTUAL_NODE_DISABLED) rather than falling back
 *     to the physical radio (which would kill MeshMonitor's own connection).
 *   - Gated on `remote_admin:write` per-source + the meshtastic device rate
 *     limiter.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { requireAuth, requirePermission } from '../auth/authMiddleware.js';
import { meshtasticDeviceLimiter } from '../middleware/rateLimiters.js';
import { extendRequestTimeout } from '../middleware/requestTimeout.js';
import { ok, fail } from '../utils/apiResponse.js';
import { resolveOwnMeshtasticManager } from '../utils/resolveSourceManager.js';
import {
  parseCliArgs,
  buildCliArgv,
  isDangerCommand,
  isValidMeshtasticNodeId,
  redactCliArgsForAudit,
  CliArgParseError,
} from '../services/meshtasticCli.js';
import { runMeshtasticCli } from '../services/meshtasticCliRunner.js';

// A CLI round trip relays over RF and can legitimately run past the 30s default
// socket timeout; extend it so the caller gets the real result, not a 504 from
// a dropped socket.
const CLI_TIMEOUT_MS = 75_000;
/** Default per-command run timeout (kills the child), configurable per request. */
const DEFAULT_RUN_TIMEOUT_MS = 60_000;
/** Ceiling for a caller-supplied timeout. */
const MAX_RUN_TIMEOUT_MS = 70_000;

const router = Router({ mergeParams: true });

/** Write one audit row for a CLI invocation. Never throws. */
function auditCli(
  req: Request,
  action: string,
  details: Record<string, unknown>,
): void {
  const userId = req.user?.id ?? req.session?.userId ?? null;
  const ip = req.ip || req.socket?.remoteAddress || null;
  databaseService
    .auditLogAsync(userId, action, 'remote_admin', JSON.stringify(details), ip)
    .catch((err) => logger.error('[API] audit write failed:', err));
}

/**
 * POST /api/sources/:id/meshtastic/admin/cli
 *
 * Body: { destNodeId: "!xxxxxxxx", args: string, confirm?: boolean, timeoutMs?: number }
 *
 * Runs `meshtastic --host <vnHost> --port <vnPort> --dest <destNodeId> <args...>`
 * and returns the captured output.
 *
 * Errors: 400 INVALID_NODE_ID / CLI_ARGS_* / DANGER_CONFIRM_REQUIRED,
 *         400 SOURCE_NOT_MESHTASTIC, 409 VIRTUAL_NODE_DISABLED,
 *         422 CLI_NONZERO_EXIT, 504 CLI_TIMEOUT, 502 CLI_RUN_FAILED.
 */
router.post(
  '/admin/cli',
  extendRequestTimeout(CLI_TIMEOUT_MS),
  meshtasticDeviceLimiter,
  requireAuth(),
  requirePermission('remote_admin', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = req.params.id!;
    try {
      const { destNodeId, args, confirm, timeoutMs } = req.body as {
        destNodeId?: unknown;
        args?: unknown;
        confirm?: unknown;
        timeoutMs?: unknown;
      };

      if (!isValidMeshtasticNodeId(destNodeId)) {
        return fail(res, 400, 'INVALID_NODE_ID', 'destNodeId must be a node id of the form !xxxxxxxx (8 hex digits)');
      }
      if (typeof args !== 'string' || args.trim().length === 0) {
        return fail(res, 400, 'CLI_ARGS_EMPTY', 'args must be a non-empty string');
      }

      // Danger guard — enforced server-side so a script or direct API call
      // cannot skip the frontend's typed-name confirmation modal. Keep the
      // pattern in sync with CliConsoleBody.tsx's DANGER_COMMAND_PATTERN.
      if (isDangerCommand(args) && confirm !== true) {
        auditCli(req, 'meshtastic_remote_cli_blocked', {
          sourceId,
          destNodeId,
          args: redactCliArgsForAudit(args.split(/\s+/)),
          reason: 'DANGER_CONFIRM_REQUIRED',
        });
        return fail(res, 400, 'DANGER_CONFIRM_REQUIRED', 'Destructive command requires confirm:true in the request body');
      }

      let userArgs: string[];
      try {
        userArgs = parseCliArgs(args);
      } catch (err) {
        if (err instanceof CliArgParseError) {
          return fail(res, 400, err.code, err.message);
        }
        throw err;
      }

      // VN-only transport. A non-Meshtastic source has no manager; a Meshtastic
      // source without the VN enabled has no loopback endpoint. Either way we
      // refuse rather than touch the physical radio.
      const manager = resolveOwnMeshtasticManager(sourceId);
      if (!manager) {
        return fail(res, 400, 'SOURCE_NOT_MESHTASTIC', 'This source is not a Meshtastic node source.');
      }
      const target = manager.getVirtualNodeTarget();
      if (!target) {
        return fail(
          res,
          409,
          'VIRTUAL_NODE_DISABLED',
          'The Virtual Node is disabled for this source. Enable it in the source settings to use the remote-admin CLI console.',
        );
      }

      const runTimeout = Math.min(
        typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_RUN_TIMEOUT_MS,
        MAX_RUN_TIMEOUT_MS,
      );

      const argv = buildCliArgv(target, destNodeId, userArgs);
      const redactedArgs = redactCliArgsForAudit(userArgs);

      let result;
      try {
        result = await runMeshtasticCli(argv, { timeoutMs: runTimeout });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditCli(req, 'meshtastic_remote_cli_failed', { sourceId, destNodeId, args: redactedArgs, error: msg });
        logger.error('[API] meshtastic CLI run failed:', err);
        return fail(res, 502, 'CLI_RUN_FAILED', msg);
      }

      const output = [result.stdout, result.stderr].filter((s) => s && s.length > 0).join('\n').trim();

      if (result.timedOut) {
        auditCli(req, 'meshtastic_remote_cli_failed', {
          sourceId, destNodeId, args: redactedArgs, error: 'CLI_TIMEOUT', elapsedMs: result.elapsedMs,
        });
        return fail(res, 504, 'CLI_TIMEOUT', `Command timed out after ${runTimeout} ms with no reply`, {
          output,
          elapsedMs: result.elapsedMs,
        });
      }

      if (result.exitCode !== 0) {
        auditCli(req, 'meshtastic_remote_cli_failed', {
          sourceId, destNodeId, args: redactedArgs, exitCode: result.exitCode, elapsedMs: result.elapsedMs,
        });
        return fail(res, 422, 'CLI_NONZERO_EXIT', output || `meshtastic exited with code ${result.exitCode}`, {
          exitCode: result.exitCode,
          output,
          elapsedMs: result.elapsedMs,
        });
      }

      auditCli(req, 'meshtastic_remote_cli', {
        sourceId,
        destNodeId,
        args: redactedArgs,
        confirm: confirm === true,
        outputChars: output.length,
        elapsedMs: result.elapsedMs,
      });

      return ok(res, {
        output,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        elapsedMs: result.elapsedMs,
      });
    } catch (error) {
      logger.error('[API] Unexpected error in meshtastic /admin/cli:', error);
      return fail(res, 500, 'CLI_ERROR', 'CLI error');
    }
  },
);

export default router;
