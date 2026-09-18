import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { EventBus } from './EventBus.js';

describe('EventBus', () => {
  let emitter: EventEmitter;
  let bus: EventBus;

  beforeEach(() => {
    emitter = new EventEmitter();
    bus = new EventBus(emitter);
  });

  it('verteilt einen typisierten Handler für den passenden Event-Typ', () => {
    const handler = vi.fn();
    bus.on('node:updated', handler);

    emitter.emit('data', {
      type: 'node:updated',
      data: { nodeNum: 123, node: { longName: 'Test Node' } },
      timestamp: 1_700_000_000_000,
      sourceId: 'src-a',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ nodeNum: 123 }),
      'src-a',
    );
  });

  it('isoliert Handler: Handler für message:new wird NICHT für node:updated aufgerufen', () => {
    const nodeHandler = vi.fn();
    const msgHandler = vi.fn();
    bus.on('node:updated', nodeHandler);
    bus.on('message:new', msgHandler);

    emitter.emit('data', {
      type: 'message:new',
      data: { id: 42 },
      timestamp: 1_700_000_001_000,
      sourceId: 'src-b',
    });

    expect(nodeHandler).not.toHaveBeenCalled();
    expect(msgHandler).toHaveBeenCalledTimes(1);
  });

  it('kann einen Handler wieder abmelden', () => {
    const handler = vi.fn();
    const off = bus.on('node:updated', handler);

    off();
    emitter.emit('data', {
      type: 'node:updated',
      data: { nodeNum: 1, node: {} },
      timestamp: 1_700_000_002_000,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('schluckt Handler-Errors (loggt, wirft nicht weiter)', () => {
    const handler = vi.fn(() => {
      throw new Error('boom');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.on('node:updated', handler);

    expect(() =>
      emitter.emit('data', {
        type: 'node:updated',
        data: { nodeNum: 1, node: {} },
        timestamp: 1_700_000_003_000,
      }),
    ).not.toThrow();

    expect(handler).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
