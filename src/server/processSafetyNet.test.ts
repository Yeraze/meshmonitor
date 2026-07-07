import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installProcessSafetyNet,
  __resetProcessSafetyNetForTests,
} from './processSafetyNet.js';

describe('processSafetyNet', () => {
  let mockShutdown: ReturnType<typeof vi.fn>;
  let mockLog: { error: ReturnType<typeof vi.fn> };
  // Capture pre-existing listeners so we can restore them after each test.
  // Typed as unknown[] because the NodeJS namespace is not ESLint-visible; the
  // cast when re-adding is safe — we captured these from the process itself.
  let priorRejectionListeners: ((...args: unknown[]) => void)[];
  let priorExceptionListeners: ((...args: unknown[]) => void)[];

  beforeEach(() => {
    priorRejectionListeners = process.listeners('unhandledRejection').slice() as ((...args: unknown[]) => void)[];
    priorExceptionListeners = process.listeners('uncaughtException').slice() as ((...args: unknown[]) => void)[];

    mockShutdown = vi.fn();
    mockLog = { error: vi.fn() };

    __resetProcessSafetyNetForTests();
  });

  afterEach(() => {
    // Remove any listeners the test registered and restore originals.
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    for (const l of priorRejectionListeners) process.on('unhandledRejection', l as any);
    for (const l of priorExceptionListeners) process.on('uncaughtException', l as any);
  });

  it('calls shutdown with unhandledRejection and exit code 1 on an unhandled rejection', () => {
    installProcessSafetyNet({ shutdown: mockShutdown, log: mockLog });

    process.emit('unhandledRejection', new Error('boom'), Promise.resolve());

    expect(mockShutdown).toHaveBeenCalledOnce();
    expect(mockShutdown).toHaveBeenCalledWith('unhandledRejection', 1);
    expect(mockLog.error).toHaveBeenCalledOnce();
    const [, meta] = mockLog.error.mock.calls[0] as [string, { reason: string; promise: string }];
    expect(meta.reason).toMatch(/boom/);
  });

  it('calls shutdown with uncaughtException and exit code 1 on an uncaught exception', () => {
    installProcessSafetyNet({ shutdown: mockShutdown, log: mockLog });

    process.emit('uncaughtException', new Error('crash'), 'uncaughtException');

    expect(mockShutdown).toHaveBeenCalledOnce();
    expect(mockShutdown).toHaveBeenCalledWith('uncaughtException', 1);
    expect(mockLog.error).toHaveBeenCalledOnce();
    const [, meta] = mockLog.error.mock.calls[0] as [string, { error: string; origin: string }];
    expect(meta.error).toMatch(/crash/);
  });

  it('is idempotent — calling installProcessSafetyNet twice only registers one listener', () => {
    installProcessSafetyNet({ shutdown: mockShutdown, log: mockLog });
    installProcessSafetyNet({ shutdown: mockShutdown, log: mockLog });

    process.emit('unhandledRejection', new Error('duplicate'), Promise.resolve());

    // Only one listener should have fired, so shutdown is called exactly once.
    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it('serializes a non-Error reason (plain object) without throwing and still calls shutdown', () => {
    installProcessSafetyNet({ shutdown: mockShutdown, log: mockLog });

    process.emit('unhandledRejection', { code: 42, msg: 'plain object reason' }, Promise.resolve());

    expect(mockShutdown).toHaveBeenCalledOnce();
    expect(mockShutdown).toHaveBeenCalledWith('unhandledRejection', 1);
    const [, meta] = mockLog.error.mock.calls[0] as [string, { reason: string }];
    expect(meta.reason).toContain('plain object reason');
  });
});
