/**
 * In-memory registry for asynchronous remote-admin operations (issue #4482).
 *
 * Remote admin commands can legitimately take up to 75s of mesh time: up to
 * 45s polling for the destination's session passkey, plus up to 30s waiting
 * for its routing ACK. Holding an HTTP request open that long is fragile
 * against any intermediate proxy or CDN — a real deployment saw Nginx Proxy
 * Manager log "upstream prematurely closed connection" and the browser receive
 * a Cloudflare 502 with an HTML body, which the frontend could only render as
 * a bare "Request failed".
 *
 * So the HTTP request now returns 202 with an operation id as soon as the
 * command is accepted, and the mesh-side wait happens here in the background.
 * The client polls `GET /api/admin/operations/:id` until the operation reaches
 * a terminal state, so no single request is ever held open for the RF wait.
 *
 * Deliberately in-memory and not persisted: an operation is only meaningful
 * while the process that owns the mesh connection is alive. A restart drops
 * in-flight operations, and a client polling one gets a clean 404 (rendered as
 * "the server restarted") rather than a promise that can never settle.
 */
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';

/**
 * Lifecycle of a remote-admin operation. The first four are transient; the
 * last four are terminal and never change again.
 *
 * `timed_out` and `rejected` were split out of `succeeded` in #4492. Both
 * previously settled as `succeeded` with the real outcome buried in
 * `result.ack`, so a caller reading only `status` could not tell "the node
 * confirmed it", "the node refused it", and "we never heard back" apart —
 * even though those demand different treatment. The auto-retry in #4487 makes
 * that distinction load-bearing rather than cosmetic: a timeout is worth
 * retrying, an explicit rejection is not.
 */
export type AdminOperationStatus =
  | 'pending'          // accepted, not yet started
  | 'awaiting_passkey' // requesting the remote node's session passkey (up to 45s)
  | 'sending'          // passkey in hand, building and handing the packet to the radio
  | 'awaiting_ack'     // packet sent, waiting for the destination's routing ACK (up to 30s)
  | 'succeeded'        // destination ACKed
  | 'rejected'         // destination answered with a routing error — do NOT retry
  | 'timed_out'        // no answer within the ACK window — retryable
  | 'failed';          // we could not complete the send at all

export const TERMINAL_STATUSES: readonly AdminOperationStatus[] = [
  'succeeded',
  'rejected',
  'timed_out',
  'failed',
];

/**
 * Whether a terminal status is worth another attempt (#4487).
 *
 * Only `timed_out` qualifies. A `rejected` operation reached the node and was
 * refused — resending it just repeats a question already answered. `failed`
 * means we never got the packet out, which is usually a local/config problem
 * that a retry won't change either.
 */
export function isRetryable(status: AdminOperationStatus): boolean {
  return status === 'timed_out';
}

export function isTerminal(status: AdminOperationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Routing-ACK outcome, mirroring the shape the frontend already consumes. */
export interface AdminOperationAck {
  acked: boolean;
  timedOut: boolean;
  errorReason: number | null;
  status: string;
}

export interface AdminOperationResult {
  message: string;
  ack?: AdminOperationAck;
  /**
   * Endpoint-specific payload merged into the result — e.g. import counts from
   * `/import-config`, or passkey expiry info from `/ensure-session-passkey`.
   * The client spreads the whole result, so these reach the caller unchanged.
   */
  [key: string]: unknown;
}

export interface AdminOperationError {
  /** SCREAMING_SNAKE machine code, e.g. PASSKEY_TIMEOUT. */
  code: string;
  message: string;
}

export interface AdminOperation {
  id: string;
  command: string;
  sourceId: string;
  destinationNodeNum: number;
  /** Session user that created it; null when authenticated by other means. */
  userId: number | null;
  status: AdminOperationStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  result: AdminOperationResult | null;
  error: AdminOperationError | null;
}

/**
 * How long a terminal operation stays readable after completing. Long enough
 * that a client whose poll was interrupted (tab backgrounded, network blip)
 * can still recover the outcome; short enough that the map cannot grow without
 * bound on a busy instance.
 */
export const TERMINAL_RETENTION_MS = 10 * 60 * 1000;

/**
 * Hard ceiling on retained operations. A runaway client cannot exhaust memory:
 * past this, the oldest terminal entries are evicted first. Non-terminal
 * operations are never evicted by count — dropping one would strand a caller
 * polling for a command that is genuinely still in flight.
 */
export const MAX_OPERATIONS = 500;

export class AdminOperationService {
  private readonly operations = new Map<string, AdminOperation>();

  /** Register a newly accepted operation and return it. */
  create(params: {
    command: string;
    sourceId: string;
    destinationNodeNum: number;
    userId?: number | null;
  }): AdminOperation {
    this.sweep();

    const now = Date.now();
    const operation: AdminOperation = {
      id: randomUUID(),
      command: params.command,
      sourceId: params.sourceId,
      destinationNodeNum: params.destinationNodeNum,
      userId: params.userId ?? null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      result: null,
      error: null,
    };
    this.operations.set(operation.id, operation);
    logger.debug(`📋 Admin operation ${operation.id} created: '${operation.command}' → node ${operation.destinationNodeNum}`);
    return operation;
  }

  get(id: string): AdminOperation | null {
    this.sweep();
    return this.operations.get(id) ?? null;
  }

  /**
   * Advance a transient status. Ignored once the operation is terminal, so a
   * late progress update from a background task can never resurrect or
   * overwrite a settled result.
   */
  setStatus(id: string, status: AdminOperationStatus): void {
    const operation = this.operations.get(id);
    if (!operation || isTerminal(operation.status)) return;
    operation.status = status;
    operation.updatedAt = Date.now();
    logger.debug(`📋 Admin operation ${id} → ${status}`);
  }

  /** Settle successfully — the destination ACKed. No-op if already terminal. */
  succeed(id: string, result: AdminOperationResult): void {
    this.settle(id, 'succeeded', result, null);
  }

  /**
   * Settle as rejected — the destination answered with a routing error (#4492).
   * Carries the result payload rather than an error, because the send itself
   * worked; it is the remote node that said no.
   */
  reject(id: string, result: AdminOperationResult): void {
    this.settle(id, 'rejected', result, null);
  }

  /**
   * Settle as timed out — no ACK within the window (#4492). Also carries a
   * result: we did send, we simply never heard back, and the caller may want
   * the ack payload to decide whether to retry.
   */
  timeOut(id: string, result: AdminOperationResult): void {
    this.settle(id, 'timed_out', result, null);
  }

  /** Settle as failed — the send could not be completed. No-op if already terminal. */
  fail(id: string, error: AdminOperationError): void {
    this.settle(id, 'failed', null, error);
  }

  private settle(
    id: string,
    status: AdminOperationStatus,
    result: AdminOperationResult | null,
    error: AdminOperationError | null,
  ): void {
    const operation = this.operations.get(id);
    if (!operation || isTerminal(operation.status)) return;
    operation.status = status;
    operation.result = result;
    operation.error = error;
    operation.completedAt = Date.now();
    operation.updatedAt = operation.completedAt;
    logger.debug(
      `📋 Admin operation ${id} settled: ${status}${error ? ` (${error.code}: ${error.message})` : ''}`,
    );
  }

  /**
   * Drop expired terminal operations, then enforce MAX_OPERATIONS by evicting
   * the oldest terminal ones. Called on create/get rather than on a timer so
   * the service holds no interval that a test or a shutdown has to clean up.
   */
  private sweep(): void {
    const now = Date.now();
    for (const [id, op] of this.operations) {
      if (op.completedAt !== null && now - op.completedAt > TERMINAL_RETENTION_MS) {
        this.operations.delete(id);
      }
    }

    if (this.operations.size <= MAX_OPERATIONS) return;

    const terminal = [...this.operations.values()]
      .filter((op) => isTerminal(op.status))
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));

    let excess = this.operations.size - MAX_OPERATIONS;
    for (const op of terminal) {
      if (excess <= 0) break;
      this.operations.delete(op.id);
      excess--;
    }
  }

  /** Test seam: current registry size. */
  size(): number {
    return this.operations.size;
  }

  /** Test seam: drop everything. */
  clear(): void {
    this.operations.clear();
  }
}

export const adminOperationService = new AdminOperationService();
export default adminOperationService;
