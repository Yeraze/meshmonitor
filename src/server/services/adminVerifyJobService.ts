/**
 * Verified remote config saves (issue #4487).
 *
 * The ACK-based retry in `/api/admin/commands` (#4502) only proves the packet
 * arrived. It never re-reads the setting, and a node that reboots on save can
 * ACK and still come back with the old value. A verify job closes that gap:
 *
 *   1. send the set_config / set_module_config once;
 *   2. wait for the node to settle (most sections reboot on save);
 *   3. read the same section back with get_config_request;
 *   4. resend ONLY when the read-back proves a changed field still holds its
 *      old value. A read that gets no answer schedules another read and never
 *      a resend: on an asymmetric link (the node hears us, we cannot hear it)
 *      resending on silence would reboot-loop the node.
 *
 * A field that comes back as neither the old nor the new value was rewritten
 * by the firmware (a clamp, a redaction). Resending cannot change that, so the
 * job settles as `differs` and reports the fields instead of retrying.
 *
 * The firmware also coerces some values back to a floor that can equal the old
 * value (node_info_broadcast_secs < 3600, neighbor_info < 4 h, a remote LoRa
 * config it judges invalid reverts the whole section, still ACKed). That reads
 * exactly like a lost packet. So when a resend is answered with the SAME stuck
 * fields, the job stops as `refused` instead of rebooting the node up to
 * MAX_SENDS times.
 *
 * Opt-in and separate from the normal admin flow: a far node can take hours.
 * In-memory, like adminOperationService — a restart drops running jobs.
 *
 * Mesh cost (limits chosen by the maintainer on #4487): one check is a
 * get_config request + reply; one resend is the set packet. First check
 * FIRST_CHECK_DELAY_MS after each send, then every CHECK_INTERVAL_MS, capped
 * at MAX_SENDS sends and MAX_DURATION_MS per job, one job per node+section and
 * MAX_RUNNING_PER_SOURCE per source.
 */
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';
import { CONFIG_TYPES, type ConfigTypeEntry } from '../constants/configTypes.js';

export const FIRST_CHECK_DELAY_MS = 90_000;
export const CHECK_INTERVAL_MS = 5 * 60_000;
export const MAX_DURATION_MS = 2 * 60 * 60_000;
export const MAX_SENDS = 5;
export const MAX_RUNNING_PER_SOURCE = 3;
export const TERMINAL_RETENTION_MS = 30 * 60_000;

/**
 * Sections a verify job refuses. Security carries keys the node will not echo
 * back and runs its own read-before-write flow (#4736).
 */
const UNVERIFIABLE_FIELDS = new Set(['security']);

/**
 * Fields the firmware blanks in a get_config reply, so a read-back never
 * equals what was written. Skipped by the comparison. Keyed `section.field`.
 */
export const REDACTED_FIELDS = new Set<string>([
  // 2.8+ answers a remote get with "sekrit" (AdminModule.cpp handleGetConfig);
  // 2.7 echoes them in clear. Either way they cannot prove a save.
  'network.wifiPsk',
  'mqtt.password',
]);

export type VerifyJobStatus =
  | 'waiting'    // sent; waiting for the node to settle before the next check
  | 'checking'   // get_config request in flight
  | 'resending'  // read-back proved the change did not land; sending again
  | 'verified'   // every changed field reads back as sent
  | 'differs'    // node answered, but holds a value that is neither old nor new
  | 'refused'    // a resend was answered with the same fields still old
  | 'gave_up'    // hit MAX_SENDS or MAX_DURATION_MS without verifying
  | 'cancelled'
  | 'failed';    // could not send at all (TX disabled, no transport)

const TERMINAL: ReadonlySet<VerifyJobStatus> = new Set(['verified', 'differs', 'refused', 'gave_up', 'cancelled', 'failed']);

export type CheckOutcome = 'no_reply' | 'not_applied' | 'applied' | 'differs';

export interface VerifyJob {
  id: string;
  sourceId: string;
  destinationNodeNum: number;
  command: string;
  section: string;
  userId: number | null;
  status: VerifyJobStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  deadline: number;
  sends: number;
  maxSends: number;
  checks: number;
  nextCheckAt: number | null;
  lastCheckAt: number | null;
  lastCheckOutcome: CheckOutcome | null;
  /** Changed fields the last read-back still showed with their old value. */
  pendingFields: string[];
  /** Changed fields the node holds with a third value. */
  differingFields: string[];
  error: { code: string; message: string } | null;
}

export interface VerifyTarget {
  kind: 'device' | 'module';
  section: string;
  adminType: number;
  expected: Record<string, unknown>;
}

/**
 * Find the config section a decoded set_config / set_module_config admin
 * message writes. Returns null for any other command or an unverifiable one.
 */
type DecodedConfig = { payloadVariant?: string } & Record<string, unknown>;

export function resolveVerifyTarget(
  decodedAdminMessage: { setConfig?: DecodedConfig; setModuleConfig?: DecodedConfig } | null | undefined,
): VerifyTarget | null {
  const pick = (kind: 'device' | 'module', msg: DecodedConfig): VerifyTarget | null => {
    const variant = msg.payloadVariant;
    const entry: ConfigTypeEntry | undefined = CONFIG_TYPES.find((e) => e.kind === kind && e.field === variant);
    const expected = variant ? msg[variant] : undefined;
    if (!entry || UNVERIFIABLE_FIELDS.has(entry.field) || !expected || typeof expected !== 'object') return null;
    return { kind, section: entry.field, adminType: entry.adminType, expected: expected as Record<string, unknown> };
  };
  if (decodedAdminMessage?.setConfig) return pick('device', decodedAdminMessage.setConfig);
  if (decodedAdminMessage?.setModuleConfig) return pick('module', decodedAdminMessage.setModuleConfig);
  return null;
}

const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !isBytes(v);

/** Proto3 leaves defaults off the wire, so missing and default are the same value. */
function isDefault(v: unknown): boolean {
  if (v == null || v === 0 || v === false || v === '' || v === '0') return true;
  if (Array.isArray(v) || isBytes(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.values(v).every(isDefault);
  return false;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (isDefault(a) && isDefault(b)) return true;
  if (isBytes(a) && isBytes(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]));
  if (typeof a === 'number' && typeof b === 'number') {
    // float32 fields (frequency offset, override frequency) round on the node.
    return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  // int64 fields decode as strings (longs: String).
  if ((typeof a === 'number' || typeof a === 'string') && (typeof b === 'number' || typeof b === 'string')) {
    return String(a) === String(b);
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => valuesEqual(a[k], b[k]));
  }
  return a === b;
}

export interface ConfigDiff {
  applied: string[];
  notApplied: string[];
  differs: string[];
}

/** Classify every field the save changed (expected ≠ baseline) against a read-back. */
export function diffConfig(
  section: string,
  expected: Record<string, unknown>,
  baseline: Record<string, unknown>,
  readBack: Record<string, unknown>,
): ConfigDiff {
  const diff: ConfigDiff = { applied: [], notApplied: [], differs: [] };
  const keys = new Set([...Object.keys(expected), ...Object.keys(baseline)]);
  for (const key of keys) {
    if (key === 'payloadVariant' || REDACTED_FIELDS.has(`${section}.${key}`)) continue;
    if (valuesEqual(expected[key], baseline[key])) continue;
    if (valuesEqual(readBack[key], expected[key])) diff.applied.push(key);
    else if (valuesEqual(readBack[key], baseline[key])) diff.notApplied.push(key);
    else diff.differs.push(key);
  }
  return diff;
}

export interface VerifyJobDeps {
  /** Send the set command once. Throws on a send that never left. */
  send: () => Promise<void>;
  /** Read the section back from the node; null when it did not answer. */
  readBack: () => Promise<Record<string, unknown> | null>;
  /** Errors that end the job instead of counting as a missed check. */
  isFatal?: (error: unknown) => { code: string; message: string } | null;
}

export class VerifyJobLimitError extends Error {
  readonly code = 'VERIFY_JOB_LIMIT';
}

export class AdminVerifyJobService {
  private readonly jobs = new Map<string, VerifyJob>();
  private readonly wakers = new WeakMap<VerifyJob, () => void>();

  list(): VerifyJob[] {
    this.sweep();
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): VerifyJob | undefined {
    return this.jobs.get(id);
  }

  start(
    params: {
      sourceId: string;
      destinationNodeNum: number;
      command: string;
      userId?: number | null;
      target: VerifyTarget;
      baseline: Record<string, unknown>;
    },
    deps: VerifyJobDeps,
  ): VerifyJob {
    this.sweep();
    const running = [...this.jobs.values()].filter((j) => j.sourceId === params.sourceId && !TERMINAL.has(j.status));
    const replaced = running.find(
      (j) => j.destinationNodeNum === params.destinationNodeNum && j.section === params.target.section,
    );
    if (!replaced && running.length >= MAX_RUNNING_PER_SOURCE) {
      throw new VerifyJobLimitError(
        `At most ${MAX_RUNNING_PER_SOURCE} verified saves can run per source; cancel one first`,
      );
    }
    if (replaced) this.cancel(replaced.id);

    const now = Date.now();
    const job: VerifyJob = {
      id: randomUUID(),
      sourceId: params.sourceId,
      destinationNodeNum: params.destinationNodeNum,
      command: params.command,
      section: params.target.section,
      userId: params.userId ?? null,
      status: 'waiting',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      deadline: now + MAX_DURATION_MS,
      sends: 0,
      maxSends: MAX_SENDS,
      checks: 0,
      nextCheckAt: null,
      lastCheckAt: null,
      lastCheckOutcome: null,
      pendingFields: [],
      differingFields: [],
      error: null,
    };
    this.jobs.set(job.id, job);
    void this.run(job, params.target, params.baseline, deps);
    return job;
  }

  cancel(id: string): VerifyJob | undefined {
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.status)) return job;
    this.finish(job, 'cancelled');
    this.wakers.get(job)?.();
    return job;
  }

  private update(job: VerifyJob, patch: Partial<VerifyJob>): void {
    Object.assign(job, patch, { updatedAt: Date.now() });
  }

  private finish(job: VerifyJob, status: VerifyJobStatus, patch: Partial<VerifyJob> = {}): void {
    this.update(job, { ...patch, status, completedAt: Date.now(), nextCheckAt: null });
    logger.info(`🔁 Verify job ${job.id} (${job.section} on ${job.destinationNodeNum}) ended: ${status}`);
  }

  /** Sleep that a cancel wakes early. */
  private wait(job: VerifyJob, ms: number): Promise<void> {
    this.update(job, { nextCheckAt: Date.now() + ms });
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(job);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakers.set(job, done);
    });
  }

  private async run(
    job: VerifyJob,
    target: VerifyTarget,
    baseline: Record<string, unknown>,
    deps: VerifyJobDeps,
  ): Promise<void> {
    const fatal = (error: unknown) => deps.isFatal?.(error) ?? null;
    const stopped = () => TERMINAL.has(job.status);

    const send = async (): Promise<boolean> => {
      this.update(job, { sends: job.sends + 1 });
      try {
        await deps.send();
      } catch (error) {
        const f = fatal(error);
        if (f) {
          this.finish(job, 'failed', { error: f });
          return false;
        }
        // A send that never got out (passkey timeout) is retried by the next
        // check finding the old value, same as one the node missed.
        logger.debug(`🔁 Verify job ${job.id} send ${job.sends} failed: ${(error as Error)?.message}`);
      }
      return true;
    };

    try {
      if (!(await send())) return;
      let delay = FIRST_CHECK_DELAY_MS;
      let stuckAfterLastSend: string | null = null;
      for (;;) {
        this.update(job, { status: 'waiting' });
        await this.wait(job, Math.min(delay, Math.max(0, job.deadline - Date.now())));
        if (stopped()) return;
        if (Date.now() >= job.deadline) return this.finish(job, 'gave_up');

        this.update(job, { status: 'checking', checks: job.checks + 1, lastCheckAt: Date.now() });
        let readBack: Record<string, unknown> | null = null;
        try {
          readBack = await deps.readBack();
        } catch (error) {
          const f = fatal(error);
          if (f) return this.finish(job, 'failed', { error: f });
        }
        if (stopped()) return;

        if (!readBack) {
          this.update(job, { lastCheckOutcome: 'no_reply' });
          delay = CHECK_INTERVAL_MS;
          continue;
        }

        const diff = diffConfig(target.section, target.expected, baseline, readBack);
        this.update(job, { pendingFields: diff.notApplied, differingFields: diff.differs });
        if (diff.notApplied.length === 0) {
          return diff.differs.length
            ? this.finish(job, 'differs', { lastCheckOutcome: 'differs' })
            : this.finish(job, 'verified', { lastCheckOutcome: 'applied' });
        }
        this.update(job, { lastCheckOutcome: 'not_applied' });
        const stuck = [...diff.notApplied].sort().join(',');
        if (stuck === stuckAfterLastSend) return this.finish(job, 'refused');
        if (job.sends >= job.maxSends) return this.finish(job, 'gave_up');
        stuckAfterLastSend = stuck;

        this.update(job, { status: 'resending' });
        if (!(await send())) return;
        delay = FIRST_CHECK_DELAY_MS;
      }
    } catch (error) {
      logger.error(`🔁 Verify job ${job.id} crashed:`, error);
      if (!stopped()) {
        this.finish(job, 'failed', { error: { code: 'VERIFY_JOB_FAILED', message: (error as Error)?.message ?? 'Verify job failed' } });
      }
    }
  }

  /** Test helper: cancel and drop every job. */
  clear(): void {
    for (const id of this.jobs.keys()) this.cancel(id);
    this.jobs.clear();
  }

  private sweep(): void {
    const cutoff = Date.now() - TERMINAL_RETENTION_MS;
    for (const [id, job] of this.jobs) {
      if (job.completedAt !== null && job.completedAt < cutoff) this.jobs.delete(id);
    }
  }
}

export const adminVerifyJobService = new AdminVerifyJobService();
