import { randomUUID } from 'node:crypto';
import type {
  AdminCommandResult,
  AdminOperation,
  AdminOperationError,
  AdminOperationPhase,
  AdminOperationStatus,
} from '../../types/adminOperations.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_RETENTION_MS = 5 * 60 * 1000;

export class AdminOperationFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdminOperationFailure';
  }
}

export interface AdminOperationContext {
  setPhase(phase: Exclude<AdminOperationPhase, 'queued' | 'complete'>): void;
}

type AdminOperationExecutor = (context: AdminOperationContext) => Promise<AdminCommandResult>;

interface CreateAdminOperationInput {
  sourceId: string;
  destinationNodeNum: number;
  command: string;
}

interface AdminOperationServiceOptions {
  retentionMs?: number;
  now?: () => number;
  schedule?: (callback: () => void) => void;
}

/**
 * Tracks short-lived remote-admin work after its initiating HTTP request has
 * returned. Operations intentionally remain process-local: a server restart
 * interrupts the underlying radio transaction too, so restoring stale rows
 * from a database would imply continuity that does not exist.
 */
export class AdminOperationService {
  private readonly operations = new Map<string, AdminOperation>();
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void) => void;

  constructor(options: AdminOperationServiceOptions = {}) {
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback) => { setImmediate(callback); });
  }

  create(input: CreateAdminOperationInput, executor: AdminOperationExecutor): AdminOperation {
    const timestamp = this.now();
    const operation: AdminOperation = {
      id: randomUUID(),
      sourceId: input.sourceId,
      destinationNodeNum: input.destinationNodeNum,
      command: input.command,
      status: 'pending',
      phase: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.operations.set(operation.id, operation);

    this.schedule(() => {
      void this.run(operation.id, executor);
    });

    return this.snapshot(operation);
  }

  get(operationId: string): AdminOperation | undefined {
    const operation = this.operations.get(operationId);
    return operation ? this.snapshot(operation) : undefined;
  }

  /** Test seam; production cleanup is timer-driven. */
  clear(): void {
    this.operations.clear();
  }

  private async run(operationId: string, executor: AdminOperationExecutor): Promise<void> {
    const operation = this.operations.get(operationId);
    if (!operation) return;

    this.update(operation, 'running', 'acquiring_passkey');
    try {
      const result = await executor({
        setPhase: (phase) => {
          const current = this.operations.get(operationId);
          if (current && !this.isTerminal(current.status)) {
            this.update(current, 'running', phase);
          }
        },
      });

      const status: AdminOperationStatus = result.ack?.timedOut
        ? 'timed_out'
        : (result.ack && !result.ack.acked ? 'rejected' : 'succeeded');
      operation.status = status;
      operation.phase = 'complete';
      operation.result = result;
      if (status === 'rejected') {
        operation.error = {
          code: 'ROUTING_REJECTED',
          message: `The remote node rejected the command: ${result.ack?.status || 'unknown routing error'}`,
        };
      }
      operation.updatedAt = this.now();
    } catch (error) {
      const failure = this.toOperationError(error);
      operation.status = failure.code === 'REMOTE_PASSKEY_TIMEOUT' ? 'timed_out' : 'failed';
      operation.phase = 'complete';
      operation.error = failure;
      operation.updatedAt = this.now();
      logger.error(
        `[AdminOperation] ${operation.command} for node ${operation.destinationNodeNum} failed: ${failure.message}`,
      );
    } finally {
      const timer = setTimeout(() => this.operations.delete(operationId), this.retentionMs);
      timer.unref?.();
    }
  }

  private update(
    operation: AdminOperation,
    status: AdminOperationStatus,
    phase: AdminOperationPhase,
  ): void {
    operation.status = status;
    operation.phase = phase;
    operation.updatedAt = this.now();
  }

  private isTerminal(status: AdminOperationStatus): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'timed_out' || status === 'rejected';
  }

  private toOperationError(error: unknown): AdminOperationError {
    if (error instanceof AdminOperationFailure) {
      return { code: error.code, message: error.message };
    }
    return {
      code: 'TRANSPORT_FAILURE',
      message: error instanceof Error ? error.message : 'Failed to execute admin command',
    };
  }

  private snapshot(operation: AdminOperation): AdminOperation {
    return {
      ...operation,
      ...(operation.result ? { result: { ...operation.result, ...(operation.result.ack ? { ack: { ...operation.result.ack } } : {}) } } : {}),
      ...(operation.error ? { error: { ...operation.error } } : {}),
    };
  }
}

export const adminOperationService = new AdminOperationService();
