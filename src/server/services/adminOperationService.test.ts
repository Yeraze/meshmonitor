import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminOperationFailure, AdminOperationService } from './adminOperationService.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AdminOperationService', () => {
  let scheduled: Array<() => void>;
  let now: number;
  let service: AdminOperationService;

  beforeEach(() => {
    scheduled = [];
    now = 1000;
    service = new AdminOperationService({
      now: () => now,
      schedule: (callback) => scheduled.push(callback),
    });
  });

  it('returns a pending snapshot before starting background work', () => {
    const executor = vi.fn();
    const operation = service.create(
      { sourceId: 'source-a', destinationNodeNum: 123, command: 'reboot' },
      executor,
    );

    expect(operation).toMatchObject({
      sourceId: 'source-a',
      destinationNodeNum: 123,
      command: 'reboot',
      status: 'pending',
      phase: 'queued',
    });
    expect(executor).not.toHaveBeenCalled();
    expect(service.get(operation.id)).toEqual(operation);
  });

  it('tracks phase changes and successful completion', async () => {
    const completion = deferred<{ message: string }>();
    const operation = service.create(
      { sourceId: 'source-a', destinationNodeNum: 123, command: 'setOwner' },
      async ({ setPhase }) => {
        setPhase('sending');
        return completion.promise;
      },
    );

    scheduled.shift()!();
    await vi.waitFor(() => expect(service.get(operation.id)?.phase).toBe('sending'));
    now = 2000;
    completion.resolve({ message: 'sent' });

    await vi.waitFor(() => expect(service.get(operation.id)?.status).toBe('succeeded'));
    expect(service.get(operation.id)).toMatchObject({
      phase: 'complete',
      updatedAt: 2000,
      result: { message: 'sent' },
    });
  });

  it.each([
    [{ acked: false, timedOut: true, errorReason: null, status: 'timeout' }, 'timed_out'],
    [{ acked: false, timedOut: false, errorReason: 5, status: 'MAX_RETRANSMIT' }, 'rejected'],
  ] as const)('maps ACK result %o to %s', async (ack, expectedStatus) => {
    const operation = service.create(
      { sourceId: 'source-a', destinationNodeNum: 123, command: 'setFavoriteNode' },
      async () => ({ message: 'sent', ack: { ...ack } }),
    );
    scheduled.shift()!();

    await vi.waitFor(() => expect(service.get(operation.id)?.status).toBe(expectedStatus));
  });

  it('maps passkey timeout to a stable timeout error', async () => {
    const operation = service.create(
      { sourceId: 'source-a', destinationNodeNum: 123, command: 'reboot' },
      async () => { throw new AdminOperationFailure('REMOTE_PASSKEY_TIMEOUT', 'Remote node did not respond'); },
    );
    scheduled.shift()!();

    await vi.waitFor(() => expect(service.get(operation.id)?.status).toBe('timed_out'));
    expect(service.get(operation.id)?.error).toEqual({
      code: 'REMOTE_PASSKEY_TIMEOUT',
      message: 'Remote node did not respond',
    });
  });

  it('captures unexpected background rejection without leaking an unhandled promise', async () => {
    const failure = deferred<{ message: string }>();
    const operation = service.create(
      { sourceId: 'source-a', destinationNodeNum: 123, command: 'reboot' },
      async () => failure.promise,
    );
    scheduled.shift()!();
    failure.reject(new Error('transport closed'));

    await vi.waitFor(() => expect(service.get(operation.id)?.status).toBe('failed'));
    expect(service.get(operation.id)?.error).toEqual({
      code: 'TRANSPORT_FAILURE',
      message: 'transport closed',
    });
  });

  it('expires terminal operation results after the retention window', async () => {
    const expiringService = new AdminOperationService({ retentionMs: 200 });
    const operation = expiringService.create(
      { sourceId: 'source-a', destinationNodeNum: 123, command: 'reboot' },
      async () => ({ message: 'sent' }),
    );

    await vi.waitFor(() => expect(expiringService.get(operation.id)?.status).toBe('succeeded'));
    await vi.waitFor(() => expect(expiringService.get(operation.id)).toBeUndefined());
  });
});
