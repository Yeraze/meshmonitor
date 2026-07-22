/**
 * MeshCore API Routes — admin group
 *
 * Remote-admin login (+ saved-credential variants), remote/local CLI (the
 * danger-guard enforcement points), credentials capability/forget, and
 * remote node status. Extracted verbatim from the former monolithic
 * `meshcoreRoutes.ts` (epic #3962 Task 4.3).
 *
 * Governed by docs/internal/dev-notes/MESHCORE_REMOTE_ADMIN.md — the
 * danger-guard checks in /admin/cli and /cli are the two enforcement
 * points for DANGER_COMMAND_PATTERN and must stay verbatim.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
import { requireAuth, requirePermission } from '../auth/authMiddleware.js';
import { meshcoreDeviceLimiter } from '../middleware/rateLimiters.js';
import { getMeshCoreCredentialStore } from '../services/meshcoreCredentialStore.js';
import {
  managerFor,
  isValidPublicKey,
  auditMeshcoreEvent,
  enhanceNeighborsReply,
  DANGER_COMMAND_PATTERN,
  resolveCliTimeoutMs,
} from './meshcoreRouteShared.js';

const router = Router({ mergeParams: true });

/**
 * POST /api/meshcore/admin/login
 * Log into a remote node for admin access.
 *
 * Body: { publicKey: string, password: string, rememberPassword?: boolean }
 *   - `password` may be empty for guest login.
 *   - `rememberPassword: true` persists the password (AES-256-GCM, see
 *     MeshCoreCredentialStore). Rejected with 400 when SESSION_SECRET was
 *     auto-generated — check GET /admin/credentials-capability first.
 *
 * Gated on `remote_admin:write` per-source. (Pre-4.7 versions used
 * `configuration:write`; remote_admin was split out so operators can grant
 * one without the other.)
 */
router.post('/admin/login', meshcoreDeviceLimiter, requireAuth(), requirePermission('remote_admin', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey, password, rememberPassword } = req.body as {
      publicKey?: string;
      password?: string;
      rememberPassword?: boolean;
    };

    if (typeof publicKey !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'publicKey and password (string) required; password may be empty for guest login' });
    }

    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }

    const sourceId = req.params.id!;
    const store = getMeshCoreCredentialStore();

    if (rememberPassword && !store.capability.canRemember) {
      return res.status(400).json({
        success: false,
        error: 'Saving credentials is disabled',
        reason: store.capability.reason,
        code: 'CREDENTIAL_PERSISTENCE_DISABLED',
      });
    }

    const success = await managerFor(req, res).loginToNode(publicKey, password);
    if (!success) {
      auditMeshcoreEvent(req, 'meshcore_remote_login_failed', 'remote_admin', {
        sourceId,
        publicKey,
      });
      return res.status(401).json({ success: false, error: 'Login failed' });
    }

    if (rememberPassword) {
      try {
        await store.store(sourceId, publicKey, password);
      } catch (err) {
        logger.warn('[API] Login succeeded but credential persistence failed:', err);
        auditMeshcoreEvent(req, 'meshcore_remote_login', 'remote_admin', {
          sourceId,
          publicKey,
          persisted: false,
          persistenceError: err instanceof Error ? err.message : String(err),
        });
        return res.json({
          success: true,
          message: 'Login successful, but saving the password failed',
          persisted: false,
        });
      }
      auditMeshcoreEvent(req, 'meshcore_remote_login', 'remote_admin', {
        sourceId,
        publicKey,
        persisted: true,
      });
      return res.json({ success: true, message: 'Login successful', persisted: true });
    }

    auditMeshcoreEvent(req, 'meshcore_remote_login', 'remote_admin', {
      sourceId,
      publicKey,
      persisted: false,
    });
    res.json({ success: true, message: 'Login successful', persisted: false });
  } catch (error) {
    logger.error('[API] Error logging in:', error);
    res.status(500).json({ success: false, error: 'Login error' });
  }
});

/**
 * POST /api/meshcore/admin/cli
 * Send a CLI command to a remote MeshCore node and await its single-packet
 * reply. Body: { publicKey: string, command: string, timeoutMs?: number }.
 *
 * Returns 504 on timeout (no reply within the window — may indicate stale
 * path, ACL eviction, or the remote being offline). Returns 502 when the
 * underlying bridge rejected the send.
 */
router.post('/admin/cli', meshcoreDeviceLimiter, requireAuth(), requirePermission('remote_admin', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey, command, timeoutMs, confirm } = req.body as {
      publicKey?: string;
      command?: string;
      timeoutMs?: number;
      confirm?: boolean;
    };

    if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }
    if (typeof command !== 'string' || command.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'command must be a non-empty string' });
    }
    if (command.length > 230) {
      // LoRa packet MTU ceiling — anything larger will be truncated by the
      // firmware. Reject up front so the user gets a clear error.
      return res.status(400).json({ success: false, error: 'command too long (max 230 bytes)' });
    }
    // Defense-in-depth danger guard. The frontend opens a typed-name
    // confirmation modal for these commands, but server-side enforcement
    // means scripts and direct API calls cannot bypass the prompt by
    // simply not rendering it. Keep the pattern in sync with the
    // client-side DANGER_COMMAND_PATTERN in CliConsoleBody.tsx.
    if (DANGER_COMMAND_PATTERN.test(command) && confirm !== true) {
      auditMeshcoreEvent(req, 'meshcore_remote_cli_blocked', 'remote_admin', {
        sourceId: req.params.id,
        publicKey,
        command,
        reason: 'DANGER_CONFIRM_REQUIRED',
      });
      return res.status(400).json({
        success: false,
        error: 'Destructive command requires confirm:true in the request body',
        code: 'DANGER_CONFIRM_REQUIRED',
      });
    }
    const effectiveTimeout = await resolveCliTimeoutMs(timeoutMs);

    try {
      const manager = managerFor(req, res);
      const result = await manager.sendCliCommand(publicKey, command, {
        timeoutMs: effectiveTimeout,
      });
      if (/^neighbors$/i.test(command.trim())) {
        result.reply = enhanceNeighborsReply(result.reply, manager);
      }
      auditMeshcoreEvent(req, 'meshcore_remote_cli', 'remote_admin', {
        sourceId: req.params.id,
        publicKey,
        command,
        confirm: confirm === true,
        replyChars: result.reply?.length ?? 0,
        elapsedMs: result.elapsedMs,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditMeshcoreEvent(req, 'meshcore_remote_cli_failed', 'remote_admin', {
        sourceId: req.params.id,
        publicKey,
        command,
        error: msg,
      });
      if (/timed out/i.test(msg)) {
        return res.status(504).json({ success: false, error: msg, code: 'CLI_TIMEOUT' });
      }
      if (/Companion firmware|not connected|Contact not found/i.test(msg)) {
        return res.status(400).json({ success: false, error: msg });
      }
      logger.error('[API] CLI command failed:', err);
      res.status(502).json({ success: false, error: msg });
    }
  } catch (error) {
    logger.error('[API] Unexpected error in /admin/cli:', error);
    res.status(500).json({ success: false, error: 'CLI error' });
  }
});

/**
 * POST /api/meshcore/cli
 *
 * Send a CLI command to the LOCALLY connected MeshCore node. Returns the
 * device's response text.
 *
 * Body: { command: string, confirm?: boolean, timeoutMs?: number }
 *
 * Dispatch depends on the local firmware (see
 * `MeshCoreManager.sendLocalCliCommand`):
 *   - Repeater / Room Server: forwarded to the device's native text CLI
 *     over serial.
 *   - Companion: handled by a small synthetic-CLI interpreter that
 *     covers ver / stats / clock / advert / help. Unknown commands
 *     return a usage hint.
 *
 * Reuses the same `DANGER_COMMAND_PATTERN` guard as the remote /admin/cli
 * route — destructive verbs (reboot / erase / clkreboot / factory)
 * require `confirm: true`.
 *
 * Gated on `configuration:write` per-source — matches the existing
 * local-device config routes (`/config/name`, `/config/radio`, etc.).
 */
router.post('/cli', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { command, confirm, timeoutMs } = req.body as {
      command?: string;
      confirm?: boolean;
      timeoutMs?: number;
    };

    if (typeof command !== 'string' || command.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'command must be a non-empty string' });
    }
    if (command.length > 230) {
      return res.status(400).json({ success: false, error: 'command too long (max 230 bytes)' });
    }
    if (DANGER_COMMAND_PATTERN.test(command) && confirm !== true) {
      auditMeshcoreEvent(req, 'meshcore_local_cli_blocked', 'configuration', {
        sourceId: req.params.id,
        command,
        reason: 'DANGER_CONFIRM_REQUIRED',
      });
      return res.status(400).json({
        success: false,
        error: 'Destructive command requires confirm:true in the request body',
        code: 'DANGER_CONFIRM_REQUIRED',
      });
    }
    const effectiveTimeout = await resolveCliTimeoutMs(timeoutMs);

    try {
      const manager = managerFor(req, res);
      const result = await manager.sendLocalCliCommand(command, {
        timeoutMs: effectiveTimeout,
      });
      if (/^neighbors$/i.test(command.trim())) {
        result.reply = enhanceNeighborsReply(result.reply, manager);
      }
      auditMeshcoreEvent(req, 'meshcore_local_cli', 'configuration', {
        sourceId: req.params.id,
        command,
        confirm: confirm === true,
        replyChars: result.reply?.length ?? 0,
        elapsedMs: result.elapsedMs,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditMeshcoreEvent(req, 'meshcore_local_cli_failed', 'configuration', {
        sourceId: req.params.id,
        command,
        error: msg,
      });
      if (/timed out/i.test(msg)) {
        return res.status(504).json({ success: false, error: msg, code: 'CLI_TIMEOUT' });
      }
      if (/not connected|not available for this device type|Serial port not open/i.test(msg)) {
        return res.status(400).json({ success: false, error: msg });
      }
      logger.error('[API] Local CLI command failed:', err);
      res.status(502).json({ success: false, error: msg });
    }
  } catch (error) {
    logger.error('[API] Unexpected error in /cli:', error);
    res.status(500).json({ success: false, error: 'CLI error' });
  }
});

/**
 * GET /api/meshcore/admin/credentials-capability
 *
 * Reports whether the server can persist MeshCore admin passwords. The
 * answer is determined by whether SESSION_SECRET was explicitly configured
 * (vs auto-generated on boot). When `canRemember=false`, the UI hides the
 * "Remember password" checkbox.
 *
 * Also returns the subset of stored credentials for THIS source whose
 * envelope `kid` no longer matches the current SESSION_SECRET — used to
 * surface a "N saved passwords need to be re-entered" banner.
 */
router.get('/admin/credentials-capability', requireAuth(), requirePermission('remote_admin', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const sourceId = req.params.id!;
    const store = getMeshCoreCredentialStore();
    const [rotatedAll, storedAll] = await Promise.all([store.listRotated(), store.listStored()]);
    const rotated = rotatedAll.filter((r) => r.sourceId === sourceId);
    const stored = storedAll.filter((s) => s.sourceId === sourceId);
    res.json({
      success: true,
      data: {
        canRemember: store.capability.canRemember,
        reason: store.capability.reason,
        rotatedCount: rotated.length,
        rotated: rotated.map((r) => ({ publicKey: r.publicKey, name: r.name })),
        stored: stored.map((s) => ({ publicKey: s.publicKey, name: s.name })),
      },
    });
  } catch (error) {
    logger.error('[API] Error reading credentials capability:', error);
    res.status(500).json({ success: false, error: 'Capability lookup failed' });
  }
});

/**
 * POST /api/meshcore/admin/login-with-saved
 *
 * Auto-login using a previously-saved admin credential. The console
 * triggers this on mount when the capability endpoint reports a non-
 * rotated stored credential for the target contact, so the user doesn't
 * have to re-enter the password every session.
 *
 * SECURITY INVARIANT — the saved plaintext password NEVER leaves this
 * process. The flow is:
 *     1. Client sends only { publicKey }. No password.
 *     2. Server reads the encrypted envelope from the DB and decrypts
 *        it server-side via MeshCoreCredentialStore.
 *     3. Server passes the plaintext to MeshCoreManager.loginToNode
 *        IN-PROCESS — it is used to derive the per-contact shared
 *        secret and discarded.
 *     4. Server returns only { success, usedStored, code } — never
 *        the plaintext, never the envelope, never the key fingerprint
 *        (the fingerprint is opaque metadata, but still kept off the
 *        client because exposing it would let a hostile script enumerate
 *        SESSION_SECRET rotations).
 *
 * Response codes:
 *   404 NO_STORED_CREDENTIAL — nothing saved for this (source, pubkey).
 *   410 CREDENTIAL_KEY_ROTATED — SESSION_SECRET changed since the
 *       password was saved; client should clear and prompt fresh.
 *   401 STORED_CREDENTIAL_REJECTED — credential decrypted but the remote
 *       rejected the login (remote's admin password probably changed).
 */
router.post('/admin/login-with-saved', meshcoreDeviceLimiter, requireAuth(), requirePermission('remote_admin', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.body as { publicKey?: string };
    if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }
    const sourceId = req.params.id!;
    const store = getMeshCoreCredentialStore();
    const result = await store.load(sourceId, publicKey);
    if (result.kind === 'none') {
      auditMeshcoreEvent(req, 'meshcore_remote_login_saved_failed', 'remote_admin', {
        sourceId, publicKey, code: 'NO_STORED_CREDENTIAL',
      });
      return res.status(404).json({ success: false, error: 'No saved credential for this node', code: 'NO_STORED_CREDENTIAL' });
    }
    if (result.kind === 'key_rotated') {
      auditMeshcoreEvent(req, 'meshcore_remote_login_saved_failed', 'remote_admin', {
        sourceId, publicKey, code: 'CREDENTIAL_KEY_ROTATED',
      });
      return res.status(410).json({
        success: false,
        error: 'Saved credential was encrypted with a previous SESSION_SECRET',
        code: 'CREDENTIAL_KEY_ROTATED',
        // Deliberately NOT echoing result.storedKid back to the client —
        // an attacker shouldn't be able to enumerate prior fingerprints.
      });
    }
    // result.password is intentionally consumed in-process only; do not
    // log it, do not echo it, do not include it in any response field.
    const ok = await managerFor(req, res).loginToNode(publicKey, result.password);
    if (!ok) {
      auditMeshcoreEvent(req, 'meshcore_remote_login_saved_failed', 'remote_admin', {
        sourceId, publicKey, code: 'STORED_CREDENTIAL_REJECTED',
      });
      return res.status(401).json({ success: false, error: 'Saved credential rejected by the remote', code: 'STORED_CREDENTIAL_REJECTED' });
    }
    auditMeshcoreEvent(req, 'meshcore_remote_login_saved', 'remote_admin', {
      sourceId, publicKey,
    });
    res.json({ success: true, usedStored: true });
  } catch (error) {
    logger.error('[API] Error in login-with-saved:', error);
    res.status(500).json({ success: false, error: 'Login error' });
  }
});

/**
 * DELETE /api/meshcore/admin/credentials/:publicKey
 * Forget a previously-saved admin password. No-op if none is saved.
 */
router.delete('/admin/credentials/:publicKey', requireAuth(), requirePermission('remote_admin', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const sourceId = req.params.id!;
    const publicKey = req.params.publicKey;
    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }
    await getMeshCoreCredentialStore().clear(sourceId, publicKey);
    auditMeshcoreEvent(req, 'meshcore_credential_forget', 'remote_admin', {
      sourceId, publicKey,
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('[API] Error clearing credential:', error);
    res.status(500).json({ success: false, error: 'Clear failed' });
  }
});

/**
 * GET /api/meshcore/admin/status/:publicKey
 * Get status from a remote node (requires prior login)
 * Requires authentication - queries remote node
 */
router.get('/admin/status/:publicKey', requireAuth(), requirePermission('remote_admin', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;

    // Validate public key format
    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }

    const status = await managerFor(req, res).requestNodeStatus(publicKey);

    if (status) {
      res.json({ success: true, data: status });
    } else {
      res.status(404).json({ success: false, error: 'No status received' });
    }
  } catch (error) {
    logger.error('[API] Error getting node status:', error);
    res.status(500).json({ success: false, error: 'Status error' });
  }
});

export default router;
