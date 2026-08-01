/**
 * Async remote-admin operation registry (#4482).
 *
 * The invariants that matter: a settled operation is immutable (a late
 * background update must never resurrect or overwrite it), and the map cannot
 * grow without bound while never evicting an operation that is still in flight.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  AdminOperationService,
  isTerminal,
  TERMINAL_RETENTION_MS,
  MAX_OPERATIONS,
} from './adminOperationService.js';

function make(svc: AdminOperationService, command = 'reboot') {
  return svc.create({ command, sourceId: 'src-1', destinationNodeNum: 0xabcdef, userId: 7 });
}

describe('AdminOperationService', () => {
  let svc: AdminOperationService;

  beforeEach(() => {
    svc = new AdminOperationService();
  });

  describe('creation', () => {
    it('starts pending with a unique id and no result or error', () => {
      const a = make(svc);
      const b = make(svc);

      expect(a.status).toBe('pending');
      expect(a.result).toBeNull();
      expect(a.error).toBeNull();
      expect(a.completedAt).toBeNull();
      expect(a.id).not.toBe(b.id);
    });

    it('records the requesting context for later ownership checks', () => {
      const op = make(svc, 'setFavoriteNode');
      expect(op).toMatchObject({
        command: 'setFavoriteNode',
        sourceId: 'src-1',
        destinationNodeNum: 0xabcdef,
        userId: 7,
      });
    });

    it('defaults userId to null when the caller has no session user', () => {
      const op = svc.create({ command: 'reboot', sourceId: 's', destinationNodeNum: 1 });
      expect(op.userId).toBeNull();
    });
  });

  describe('lifecycle', () => {
    it('advances through transient statuses', () => {
      const op = make(svc);
      svc.setStatus(op.id, 'awaiting_passkey');
      expect(svc.get(op.id)!.status).toBe('awaiting_passkey');
      svc.setStatus(op.id, 'awaiting_ack');
      expect(svc.get(op.id)!.status).toBe('awaiting_ack');
    });

    it('settles successfully with the command result', () => {
      const op = make(svc);
      svc.succeed(op.id, { message: 'sent', ack: { acked: true, timedOut: false, errorReason: 0, status: 'confirmed' } });

      const settled = svc.get(op.id)!;
      expect(settled.status).toBe('succeeded');
      expect(settled.result?.ack?.acked).toBe(true);
      expect(settled.completedAt).toBeGreaterThan(0);
    });

    it('settles as failed with a machine code', () => {
      const op = make(svc);
      svc.fail(op.id, { code: 'PASSKEY_TIMEOUT', message: 'no passkey' });

      const settled = svc.get(op.id)!;
      expect(settled.status).toBe('failed');
      expect(settled.error).toEqual({ code: 'PASSKEY_TIMEOUT', message: 'no passkey' });
    });

    it('ignores a status update after the operation has settled', () => {
      const op = make(svc);
      svc.succeed(op.id, { message: 'sent' });
      svc.setStatus(op.id, 'awaiting_ack');

      expect(svc.get(op.id)!.status).toBe('succeeded');
    });

    it('ignores a second settle — first outcome wins', () => {
      const op = make(svc);
      svc.succeed(op.id, { message: 'first' });
      svc.fail(op.id, { code: 'LATE', message: 'should not overwrite' });

      const settled = svc.get(op.id)!;
      expect(settled.status).toBe('succeeded');
      expect(settled.result?.message).toBe('first');
      expect(settled.error).toBeNull();
    });

    it('is a no-op for an unknown id rather than throwing', () => {
      expect(() => svc.setStatus('nope', 'sending')).not.toThrow();
      expect(() => svc.succeed('nope', { message: 'x' })).not.toThrow();
      expect(() => svc.fail('nope', { code: 'X', message: 'y' })).not.toThrow();
      expect(svc.get('nope')).toBeNull();
    });
  });

  describe('retention', () => {
    afterEach(() => vi.useRealTimers());

    it('keeps a settled operation readable within the retention window', () => {
      vi.useFakeTimers();
      const op = make(svc);
      svc.succeed(op.id, { message: 'sent' });

      vi.advanceTimersByTime(TERMINAL_RETENTION_MS - 1000);
      expect(svc.get(op.id)).not.toBeNull();
    });

    it('drops a settled operation once the retention window passes', () => {
      vi.useFakeTimers();
      const op = make(svc);
      svc.succeed(op.id, { message: 'sent' });

      vi.advanceTimersByTime(TERMINAL_RETENTION_MS + 1000);
      expect(svc.get(op.id)).toBeNull();
    });

    it('never expires an operation that is still in flight', () => {
      vi.useFakeTimers();
      const op = make(svc);

      vi.advanceTimersByTime(TERMINAL_RETENTION_MS * 5);
      expect(svc.get(op.id)).not.toBeNull();
      expect(svc.get(op.id)!.status).toBe('pending');
    });

    it('evicts oldest terminal entries past MAX_OPERATIONS but keeps in-flight ones', () => {
      vi.useFakeTimers();

      // One in-flight operation created first — the prime eviction candidate by age.
      const inFlight = make(svc);

      for (let i = 0; i < MAX_OPERATIONS + 50; i++) {
        const op = make(svc);
        vi.advanceTimersByTime(1);
        svc.succeed(op.id, { message: `sent-${i}` });
      }

      expect(svc.size()).toBeLessThanOrEqual(MAX_OPERATIONS + 1);
      // The in-flight one survived the cull even though it is the oldest.
      expect(svc.get(inFlight.id)).not.toBeNull();
      expect(svc.get(inFlight.id)!.status).toBe('pending');
    });
  });

  describe('isTerminal', () => {
    it('classifies statuses', () => {
      expect(isTerminal('succeeded')).toBe(true);
      expect(isTerminal('failed')).toBe(true);
      for (const s of ['pending', 'awaiting_passkey', 'sending', 'awaiting_ack'] as const) {
        expect(isTerminal(s)).toBe(false);
      }
    });
  });
});
