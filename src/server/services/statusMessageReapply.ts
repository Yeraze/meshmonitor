/**
 * Opt-in "re-apply the Status Message after a reboot" (#5745).
 *
 * Some firmware drops a Status Message on reboot even though the running
 * config held it. When the source's setting is on, MeshMonitor writes the last
 * status it VERIFIED once more if the node comes back with an empty one.
 *
 * Local admin packets only: one read, then (at most) one verified write with
 * its read-back. Nothing goes on air. One attempt per connection.
 */
import { logger } from '../../utils/logger.js';

/** Per-source, user-set. Only 'true' / '1' turn it on. Off by default. */
export const STATUS_MESSAGE_REAPPLY_SETTING = 'statusMessageReapplyAfterReboot';
/** Per-source, server-written: the last status a read-back confirmed on the node ('' = verified clear). */
export const STATUS_MESSAGE_LAST_VERIFIED_KEY = 'statusMessageLastVerified';

export function isReapplyEnabled(raw: string | null | undefined): boolean {
  return raw === 'true' || raw === '1';
}

export interface StatusReapplyInput {
  enabled: boolean;
  /** Firmware has the Status Message module. */
  supported: boolean;
  /** Last verified status for this source; null/'' = nothing to re-apply. */
  remembered: string | null;
  /** The node's `node_status` now; null = the node did not answer. */
  nodeStatus: string | null;
  /** A verified status save is queued or running. */
  saveInFlight: boolean;
  /** This connection already evaluated a re-apply. */
  alreadyAttempted: boolean;
}

export type StatusReapplyDecision =
  | { action: 'reapply'; value: string }
  | { action: 'adopt'; value: string }
  | { action: 'none'; reason: string };

export function decideStatusReapply(input: StatusReapplyInput): StatusReapplyDecision {
  if (!input.enabled) return { action: 'none', reason: 'disabled' };
  if (!input.supported) return { action: 'none', reason: 'unsupported' };
  if (input.alreadyAttempted) return { action: 'none', reason: 'already-attempted' };
  if (input.saveInFlight) return { action: 'none', reason: 'save-in-flight' };
  if (input.nodeStatus === null) return { action: 'none', reason: 'node-did-not-answer' };

  const remembered = input.remembered ?? '';
  if (input.nodeStatus !== '') {
    // Someone set it another way: the node is the truth now.
    return input.nodeStatus === remembered
      ? { action: 'none', reason: 'in-sync' }
      : { action: 'adopt', value: input.nodeStatus };
  }
  if (remembered === '') return { action: 'none', reason: 'nothing-remembered' };
  return { action: 'reapply', value: remembered };
}

export interface StatusReapplyDeps {
  sourceId: string;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  supported(): boolean;
  saveInFlight(): boolean;
  /** The node's statusmessage section now, or null when it did not answer. */
  readNodeSection(): Promise<Record<string, unknown> | null>;
  /** The verified save from #5769 (single-flight, read-back). Throws unless the node confirms. */
  saveVerified(nodeStatus: string): Promise<void>;
}

/**
 * Evaluate once for this connection. The caller owns the per-connection
 * "attempted" flag and must set it before calling. Never throws.
 */
export async function runStatusMessageReapply(deps: StatusReapplyDeps, alreadyAttempted: boolean): Promise<StatusReapplyDecision> {
  const tag = `[StatusReapply:${deps.sourceId}]`;
  try {
    // Cheap gates first so a source with the option off costs nothing.
    const enabled = isReapplyEnabled(await deps.getSetting(STATUS_MESSAGE_REAPPLY_SETTING));
    if (!enabled || !deps.supported() || alreadyAttempted || deps.saveInFlight()) {
      return decideStatusReapply({ enabled, supported: deps.supported(), remembered: null, nodeStatus: null, saveInFlight: deps.saveInFlight(), alreadyAttempted });
    }
    const remembered = await deps.getSetting(STATUS_MESSAGE_LAST_VERIFIED_KEY);
    const section = await deps.readNodeSection();
    const nodeStatus = section === null ? null : (typeof section.nodeStatus === 'string' ? section.nodeStatus : '');
    const decision = decideStatusReapply({
      enabled, supported: true, remembered, nodeStatus, saveInFlight: deps.saveInFlight(), alreadyAttempted,
    });

    if (decision.action === 'adopt') {
      await deps.setSetting(STATUS_MESSAGE_LAST_VERIFIED_KEY, decision.value);
      logger.info(`${tag} Node holds a different status; remembering it instead`);
    } else if (decision.action === 'reapply') {
      try {
        await deps.saveVerified(decision.value);
        logger.info(`${tag} Node came back with an empty status; re-applied the last saved one and the node confirmed it`);
      } catch (error) {
        // No retry on this connection. A later reconnect may try again.
        logger.warn(`${tag} Re-apply did not succeed; not retrying on this connection:`, error);
      }
    } else {
      logger.debug(`${tag} No re-apply (${decision.reason})`);
    }
    return decision;
  } catch (error) {
    logger.warn(`${tag} Re-apply check failed:`, error);
    return { action: 'none', reason: 'error' };
  }
}
