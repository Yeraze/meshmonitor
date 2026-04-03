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
}
