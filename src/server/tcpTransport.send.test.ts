import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TcpTransport } from './tcpTransport.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type WriteCallback = (error?: Error | null) => void;

class FakeSocket extends EventEmitter {
  write = vi.fn<(data: Uint8Array, callback: WriteCallback) => boolean>();
}

describe('TcpTransport.send write completion', () => {
  let transport: TcpTransport;
  let socket: FakeSocket;

  beforeEach(() => {
    transport = new TcpTransport();
    socket = new FakeSocket();
    (transport as any).isConnected = true;
    (transport as any).socket = socket;
  });

  it('rejects an asynchronous EPIPE even when socket.write() returned true', async () => {
    let writeCallback: WriteCallback | undefined;
    socket.write.mockImplementation((_data, callback) => {
      writeCallback = callback;
      return true;
    });

    const sendPromise = transport.send(new Uint8Array([0x01]));
    let fulfilled = false;
    void sendPromise.then(() => { fulfilled = true; }, () => undefined);

    await Promise.resolve();
    expect(fulfilled).toBe(false);

    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const rejection = expect(sendPromise).rejects.toMatchObject({ code: 'EPIPE' });
    writeCallback?.(error);
    await rejection;
  });

  it('does not resolve a buffered write before its completion callback', async () => {
    let writeCallback: WriteCallback | undefined;
    socket.write.mockImplementation((_data, callback) => {
      writeCallback = callback;
      return true;
    });

    const sendPromise = transport.send(new Uint8Array([0x02]));
    let fulfilled = false;
    void sendPromise.then(() => { fulfilled = true; });

    await Promise.resolve();
    expect(fulfilled).toBe(false);

    writeCallback?.();
    await expect(sendPromise).resolves.toBeUndefined();
  });

  it('waits for both write completion and drain when backpressure is reported', async () => {
    let writeCallback: WriteCallback | undefined;
    socket.write.mockImplementation((_data, callback) => {
      writeCallback = callback;
      return false;
    });

    const sendPromise = transport.send(new Uint8Array([0x03]));
    let fulfilled = false;
    void sendPromise.then(() => { fulfilled = true; });

    writeCallback?.();
    await Promise.resolve();
    expect(fulfilled).toBe(false);

    socket.emit('drain');
    await expect(sendPromise).resolves.toBeUndefined();
  });

  it('removes the pending drain listener when a backpressured write fails', async () => {
    let writeCallback: WriteCallback | undefined;
    socket.write.mockImplementation((_data, callback) => {
      writeCallback = callback;
      return false;
    });

    const sendPromise = transport.send(new Uint8Array([0x04]));
    expect(socket.listenerCount('drain')).toBe(1);

    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const rejection = expect(sendPromise).rejects.toMatchObject({ code: 'EPIPE' });
    writeCallback?.(error);
    await rejection;

    expect(socket.listenerCount('drain')).toBe(0);
  });
});
