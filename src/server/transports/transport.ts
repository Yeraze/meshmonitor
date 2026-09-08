import { EventEmitter } from 'events';

/**
 * Transport interface for Meshtastic communication.
 * Implementations handle the connection and framing protocol.
 *
 * Events emitted:
 * - 'connect' — connection established
 * - 'disconnect' — connection lost
 * - 'message' (data: Uint8Array) — complete message received
 * - 'error' (error: Error) — transport error
 * - 'stale-connection' (info: object) — connection appears stale
 */
export interface ITransport extends EventEmitter {
  connect(host: string, port?: number): Promise<void>;
  disconnect(): void;
  send(data: Uint8Array): Promise<void>;
  getConnectionState(): boolean;
  getReconnectAttempts(): number;
  /**
   * Tell the transport whether the initial config sync is in progress (#5122).
   *
   * During that window a peer can go silent indefinitely while the link stays
   * open, and the ordinary idle watchdog is far too slow to notice. Optional so
   * non-TCP transports (and test doubles) need not implement it.
   */
  setConfigSyncActive?(active: boolean): void;
}
