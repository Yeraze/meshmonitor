/**
 * Shared plan + paced send for automated text on every protocol (#6316
 * MeshCore, #6330 Meshtastic). One implementation: each manager supplies its
 * byte cap, its targets and how one part goes out; the order, the gap, the
 * per-source mutex, the receive-only re-check and the drop-on-failure rule
 * live here.
 */
import { splitUtf8Message, truncateUtf8Bytes, utf8ByteLength } from './splitUtf8Message.js';
import { SPLIT_MAX_PARTS } from '../../utils/messageSplitLimits.js';
import { logger } from '../../utils/logger.js';

export interface AutomatedTextPlan {
  parts: string[];
  truncated: boolean;
  maxBytes: number;
}

const ELLIPSIS = '...';

/**
 * Fit one automated text to `maxBytes`: split into up to SPLIT_MAX_PARTS
 * marked parts when `split` is on, otherwise truncate to one part. A cut text
 * ends in "..." on both protocols (#6330), so the reader can see the tail is
 * missing. Pure; no IO.
 */
export function planAutomatedTextParts(
  text: string,
  opts: { maxBytes: number; split: boolean },
): AutomatedTextPlan {
  const { maxBytes } = opts;
  const { parts, truncated } = splitUtf8Message(text, {
    maxBytes,
    maxParts: opts.split ? SPLIT_MAX_PARTS : 1,
  });
  if (truncated && parts.length > 0) {
    const last = parts.length - 1;
    parts[last] = truncateUtf8Bytes(parts[last], maxBytes - utf8ByteLength(ELLIPSIS)).trimEnd() + ELLIPSIS;
  }
  return { parts, truncated, maxBytes };
}

/**
 * A queued split sequence that has waited longer than this for the lock is
 * dropped instead of sent late (4.17.3 review M4).
 */
export const SPLIT_SEQUENCE_MAX_WAIT_MS = 2 * 60_000;

export type SplitLockOutcome<T> =
  | { ran: true; value: T }
  | { ran: false; reason: 'duplicate' | 'stale' };

/**
 * Per-source mutex for multi-part sequences: a sequence waits until the
 * running one finishes, so two sequences never interleave their (i/N) markers.
 *
 * The queue is bounded (4.17.3 review M4): a new sequence is dropped when one
 * with the same `key` (trigger + target) is already WAITING (one running plus
 * one waiting per key is allowed), and a sequence that waited longer than
 * `maxWaitMs` for its turn is dropped when it reaches the front. A dropped
 * sequence never runs `fn`.
 */
export class SplitSequenceLock {
  private tail: Promise<unknown> = Promise.resolve();
  /** Sequences queued or running and not yet finished. */
  private active = 0;
  /** Waiting (queued, not started) sequences per key. */
  private readonly waiting = new Map<string, number>();

  constructor(private readonly maxWaitMs: number = SPLIT_SEQUENCE_MAX_WAIT_MS) {}

  run<T>(fn: () => Promise<T>, opts: { key?: string } = {}): Promise<SplitLockOutcome<T>> {
    const { key } = opts;
    if (key !== undefined && (this.waiting.get(key) ?? 0) > 0) {
      return Promise.resolve({ ran: false, reason: 'duplicate' });
    }
    // Only a sequence queued behind another counts as waiting.
    const waits = key !== undefined && this.active > 0;
    if (waits) this.waiting.set(key, (this.waiting.get(key) ?? 0) + 1);
    this.active++;
    const queuedAt = Date.now();
    const task = this.tail.then(async (): Promise<SplitLockOutcome<T>> => {
      if (waits) {
        const n = (this.waiting.get(key!) ?? 1) - 1;
        if (n > 0) this.waiting.set(key!, n); else this.waiting.delete(key!);
      }
      if (Date.now() - queuedAt > this.maxWaitMs) return { ran: false, reason: 'stale' };
      return { ran: true, value: await fn() };
    }).finally(() => { this.active--; });
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }
}

export interface AutomatedTextResult {
  ok: boolean;
  sentParts: number;
  totalParts: number;
  truncated: boolean;
  perTarget: Array<{ target: string; sentParts: number }>;
  /** Set when the sequence never ran: an identical one was already waiting, or it waited too long (M4). */
  dropped?: 'duplicate' | 'stale';
}

export interface SplitSendTarget {
  /** Log/result name, e.g. "DM" or "channel 2". */
  name: string;
}

/**
 * Send a planned text to every target.
 *
 * Send order is by part: part i goes to every target back to back, then the
 * gap, then part i+1. The gap is awaited outside any send lock. A multi-part
 * sequence holds `lock`. Before every part `canTransmit` is re-checked; a
 * target whose part fails is dropped from later parts, and the run stops when
 * no target is left.
 */
export async function sendAutomatedTextParts<T extends SplitSendTarget>(
  text: string,
  plan: AutomatedTextPlan,
  targetList: T[],
  deps: {
    lock: SplitSequenceLock;
    gapMs: number;
    /**
     * Wait between targets within one part (M5: MeshCore multi-channel
     * timers). Absent or 0: targets go back to back.
     */
    targetGapMs?: number;
    /**
     * Identity of this sequence for the lock's duplicate check: trigger plus
     * the real destination (M4). Absent: no duplicate check.
     */
    sequenceKey?: string;
    canTransmit: () => boolean;
    /** Resolves false on a failed part. A throw propagates to the caller. */
    sendPart: (target: T, part: string, index: number) => Promise<boolean>;
    /** Log prefix, e.g. `[MeshCore:src1]`. */
    logPrefix: string;
    label: string;
  },
): Promise<AutomatedTextResult> {
  const { parts, truncated, maxBytes } = plan;
  const { logPrefix, label } = deps;
  const targets = targetList.map((t) => ({ t, sent: 0, alive: true }));
  const result = (): AutomatedTextResult => ({
    ok: targets.length > 0 && parts.length > 0 && targets.every((x) => x.sent === parts.length),
    sentParts: targets.length ? Math.min(...targets.map((x) => x.sent)) : 0,
    totalParts: parts.length,
    truncated,
    perTarget: targets.map((x) => ({ target: x.t.name, sentParts: x.sent })),
  });
  if (truncated) {
    logger.warn(
      `${logPrefix} ${label}: message is ${utf8ByteLength(text)} bytes, over the ${maxBytes}-byte cap` +
      `${parts.length > 1 ? ` x ${parts.length} parts` : ''}; the tail was cut`,
    );
  }
  if (parts.length === 0 || targets.length === 0) return result();

  const run = async () => {
    for (let i = 0; i < parts.length; i++) {
      if (!targets.some((x) => x.alive)) break;
      if (i > 0) {
        // Fixed gap so parts do not collide with each other's repeats.
        await new Promise((resolve) => setTimeout(resolve, deps.gapMs));
      }
      let firstInPart = true;
      for (const x of targets) {
        if (!x.alive) continue;
        if (!firstInPart && deps.targetGapMs) {
          // M5: space targets so a channel's flood is not stepped on by the next.
          await new Promise((resolve) => setTimeout(resolve, deps.targetGapMs));
        }
        firstInPart = false;
        // Re-check before EVERY part: the gap is long enough for receive-only
        // to be switched on (#4547).
        if (!deps.canTransmit()) {
          logger.debug(`⏭️ ${logPrefix} ${label}: cannot transmit, dropping part ${i + 1}/${parts.length}`);
          return;
        }
        logger.debug(`${logPrefix} ${label} ${x.t.name} part ${i + 1}/${parts.length} (${utf8ByteLength(parts[i])} bytes)`);
        const sent = await deps.sendPart(x.t, parts[i], i);
        if (!sent) {
          // Later parts without the earlier ones are noise.
          if (parts.length > 1) {
            logger.warn(`${logPrefix} ${label}: part ${i + 1}/${parts.length} to ${x.t.name} failed; skipping the rest for it`);
          }
          x.alive = false;
        } else {
          x.sent++;
        }
      }
    }
  };

  if (parts.length > 1) {
    const outcome = await deps.lock.run(run, { key: deps.sequenceKey });
    if (!outcome.ran) {
      logDrop(logPrefix, label, outcome.reason, deps.sequenceKey);
      return { ...result(), ok: false, dropped: outcome.reason };
    }
  } else {
    await run();
  }
  return result();
}

/** Keys whose duplicate drop was already logged at info; later ones log at debug. */
const loggedDuplicateKeys = new Set<string>();

function logDrop(logPrefix: string, label: string, reason: 'duplicate' | 'stale', key: string | undefined): void {
  if (reason === 'stale') {
    logger.info(`${logPrefix} ${label}: split message dropped, it waited over ${SPLIT_SEQUENCE_MAX_WAIT_MS / 60_000} min for an earlier one to finish`);
    return;
  }
  const msg = `${logPrefix} ${label}: split message dropped, the same reply to the same target is already waiting`;
  const k = `${logPrefix}|${key ?? label}`;
  if (loggedDuplicateKeys.has(k)) {
    logger.debug(msg);
    return;
  }
  if (loggedDuplicateKeys.size > 500) loggedDuplicateKeys.clear();
  loggedDuplicateKeys.add(k);
  logger.info(`${msg} (further drops for it log at debug)`);
}
