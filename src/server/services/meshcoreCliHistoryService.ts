/**
 * Write side of the MeshCore CLI history (#5892).
 *
 * Called from the four places a PERSON issues a CLI command: the remote and
 * local console routes, the time-sync button, and the Virtual Node CLI relay.
 * Background callers (stats polls, config reads, scheduled time sync,
 * automations) never come through here, so they are never recorded.
 *
 * Recording is fire-and-forget: a failed write is logged and never changes the
 * command's own result. Command, reply and error are redacted here, before
 * anything reaches the database.
 */
import type { Request } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { redactCliCommand, redactCliReply } from '../utils/meshcoreCliRedact.js';
import type {
  MeshCoreCliOrigin,
  MeshCoreCliOutcome,
  MeshCoreCliTargetKind,
} from '../../db/repositories/meshcoreCliHistory.js';

export const DEFAULT_MESHCORE_CLI_HISTORY_RETENTION_DAYS = 90;
export const MESHCORE_CLI_HISTORY_RETENTION_SETTING = 'meshcoreCliHistoryRetentionDays';

export interface CliHistoryEntry {
  sourceId: string;
  targetKind: MeshCoreCliTargetKind;
  targetPublicKey?: string | null;
  targetName?: string | null;
  origin: MeshCoreCliOrigin;
  userId?: number | null;
  username?: string | null;
  /** The raw command; redacted before it is stored. */
  command: string;
  outcome: MeshCoreCliOutcome;
  reply?: string | null;
  error?: string | null;
  elapsedMs?: number | null;
  ipAddress?: string | null;
  /** Defaults to now. */
  timestamp?: number;
}

/** Store one command. Returns the write promise (tests await it); callers need not. */
export function recordMeshcoreCliHistory(entry: CliHistoryEntry): Promise<void> {
  try {
    const row = {
      sourceId: entry.sourceId,
      timestamp: entry.timestamp ?? Date.now(),
      targetKind: entry.targetKind,
      targetPublicKey: entry.targetPublicKey ?? null,
      targetName: entry.targetName ?? null,
      origin: entry.origin,
      userId: entry.userId ?? null,
      username: entry.username ?? null,
      command: redactCliCommand(entry.command),
      outcome: entry.outcome,
      reply: redactCliReply(entry.command, entry.reply ?? null),
      error: redactCliReply(entry.command, entry.error ?? null),
      elapsedMs: entry.elapsedMs ?? null,
      ipAddress: entry.ipAddress ?? null,
    };
    return databaseService.meshcoreCliHistory.record(row).catch((err: unknown) => {
      logger.error('[MeshCore CLI history] write failed:', err);
    });
  } catch (err) {
    logger.error('[MeshCore CLI history] write failed:', err);
    return Promise.resolve();
  }
}

/** Who sent an HTTP request: user id, username and IP. */
export function cliRequester(req: Request): { userId: number | null; username: string | null; ipAddress: string | null } {
  const user = req.user;
  return {
    userId: req.session?.userId ?? user?.id ?? null,
    username: user?.username ?? null,
    ipAddress: req.ip || req.socket?.remoteAddress || null,
  };
}

/** Classify a thrown CLI error. */
export function cliErrorOutcome(message: string): MeshCoreCliOutcome {
  return /timed out/i.test(message) ? 'timeout' : 'failed';
}
