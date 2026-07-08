/**
 * Regression test for issue #4000 (secondary bug) — VirtualNodeServer.start()
 * left `this.server` non-null after a `listen` error (e.g. EADDRINUSE),
 * so a later start() attempt silently no-op'ed with "Virtual node server
 * already started" instead of retrying the bind. This left the VN
 * permanently unrecoverable once one bind attempt failed.
 *
 * `start()` must now clear `this.server` on a listen error so a subsequent
 * start() call can rebind once the port is free.
 *
 * `net.Server` is mocked so the error/listening transitions are driven
 * deterministically instead of racing a real OS-level port conflict.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('net', () => {
  class FakeServer {
    static instances: FakeServer[] = [];
    private listeners: Record<string, Array<(...args: any[]) => void>> = {};
    listenCb: (() => void) | undefined;

    constructor(private connectionListener: (socket: unknown) => void) {
      FakeServer.instances.push(this);
    }
    on(event: string, cb: (...args: any[]) => void) {
      (this.listeners[event] ??= []).push(cb);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      (this.listeners[event] ?? []).forEach((cb) => cb(...args));
    }
    listen(_port: number, cb: () => void) {
      this.listenCb = cb;
      return this;
    }
    close(cb?: () => void) {
      cb?.();
    }
  }
  return { Server: FakeServer, Socket: class {} };
});

vi.mock('../services/database.js', () => {
  const shared = {
    nodes: {
      getActiveNodes: vi.fn().mockResolvedValue([]),
      setNodeFavorite: vi.fn().mockResolvedValue(undefined),
    },
    getSettingAsync: vi.fn().mockResolvedValue(null),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

import { Server } from 'net';
import { VirtualNodeServer } from './virtualNodeServer.js';

type FakeServerInstance = InstanceType<typeof Server> & {
  emit: (event: string, ...args: unknown[]) => void;
  listenCb?: () => void;
};

function latestFakeServer(): FakeServerInstance {
  const instances = (Server as unknown as { instances: FakeServerInstance[] }).instances;
  return instances[instances.length - 1];
}

function makeFakeManager(sourceId: string = 'src-1') {
  return {
    sourceId,
    getLocalNodeInfo: () => ({ nodeNum: 0x11223344, nodeId: '!11223344' }),
    processIncomingData: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('VirtualNodeServer.start() — issue #4000 listen-error recovery', () => {
  it('clears this.server on a listen error, allowing a later start() to retry', async () => {
    const vn = new VirtualNodeServer({ port: 4503, meshtasticManager: makeFakeManager() });

    const firstStart = vn.start();
    const failedServer = latestFakeServer();
    failedServer.emit('error', new Error('listen EADDRINUSE: address already in use 0.0.0.0:4503'));

    await expect(firstStart).rejects.toThrow(/EADDRINUSE/);
    expect((vn as any).server).toBeNull();

    // Before the fix, this would hit the `if (this.server) { ...; return; }`
    // short-circuit and resolve without ever attempting a new bind.
    const secondStart = vn.start();
    const retriedServer = latestFakeServer();
    expect(retriedServer).not.toBe(failedServer);
    retriedServer.listenCb?.();

    await expect(secondStart).resolves.toBeUndefined();
    expect((vn as any).server).not.toBeNull();

    await vn.stop();
  });

  it('successive listen errors keep this.server clearable (no permanent zombie)', async () => {
    const vn = new VirtualNodeServer({ port: 4503, meshtasticManager: makeFakeManager() });

    for (let i = 0; i < 3; i++) {
      const attempt = vn.start();
      latestFakeServer().emit('error', new Error(`listen EADDRINUSE attempt ${i}`));
      await expect(attempt).rejects.toThrow();
      expect((vn as any).server).toBeNull();
    }

    const finalStart = vn.start();
    latestFakeServer().listenCb?.();
    await expect(finalStart).resolves.toBeUndefined();

    await vn.stop();
  });

  it('does not throw a synchronous uncaught exception when nothing listens for "error" (EventEmitter self-emit guard)', async () => {
    // No production caller currently attaches vn.on('error', ...). Node's
    // EventEmitter throws synchronously when 'error' is emitted with zero
    // listeners, which would otherwise turn a routine bind failure into an
    // uncaught exception from inside net.Server's async error dispatch.
    const vn = new VirtualNodeServer({ port: 4503, meshtasticManager: makeFakeManager() });
    expect(vn.listenerCount('error')).toBe(0);

    const start = vn.start();
    expect(() => {
      latestFakeServer().emit('error', new Error('listen EADDRINUSE'));
    }).not.toThrow();

    await expect(start).rejects.toThrow(/EADDRINUSE/);
  });

  it('still emits "error" to a caller that does listen', async () => {
    const vn = new VirtualNodeServer({ port: 4503, meshtasticManager: makeFakeManager() });
    const errorListener = vi.fn();
    vn.on('error', errorListener);

    const start = vn.start();
    const err = new Error('listen EADDRINUSE');
    latestFakeServer().emit('error', err);
    await expect(start).rejects.toThrow(/EADDRINUSE/);

    expect(errorListener).toHaveBeenCalledWith(err);
  });
});
