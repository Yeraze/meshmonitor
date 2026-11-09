/**
 * Remote-admin transport for the Repeater settings service (#6256, P10 S7).
 *
 * Each `run` is one CLI line sent over RF as an encrypted DM (CliData) to a
 * Repeater or Room Server we hold an admin session on, and one DM reply back.
 * The firmware has no batching and does not ACK CliData, so the service sends
 * one key at a time and this transport adds the mesh guards:
 *
 *  - a minimum gap between commands (default 1 s), so a settings read never
 *    turns into a back-to-back burst on a shared channel;
 *  - `recordMeshTx()` after each command, so schedulers sharing the 60 s
 *    mesh-TX floor back off while a user is working on a node;
 *  - the danger guard and the 230-byte LoRa cap, checked before anything is
 *    sent (the routes build commands from the schema, this is defence in depth);
 *  - an abort signal: Cancel or a closed HTTP request stops before the next send;
 *  - an optional per-command hook the route uses to count its budget.
 *
 * No retries: a timeout throws and the service stops the run (`NOT_SENT` for
 * the rest). It reuses `sendCliCommand`, which serialises per target prefix.
 */
import { DANGER_COMMAND_PATTERN } from '../routes/meshcoreRouteShared.js';
import type { RepeaterCliTransport } from './meshcoreRepeaterSettingsService.js';

/** The slice of MeshCoreManager this transport needs (kept narrow for tests). */
export interface RemoteCliManager {
  sendCliCommand(publicKey: string, command: string, opts?: { timeoutMs?: number }): Promise<{ reply: string; elapsedMs: number }>;
  recordMeshTx(when?: number): void;
}

export interface RemoteRepeaterTransportOptions {
  /** Per-command reply timeout (from `resolveCliTimeoutMs`); undefined = manager default. */
  timeoutMs?: number;
  /** Stops the run before the next send. */
  signal?: AbortSignal;
  /** Minimum time between the previous reply and the next send. Default 1000 ms. */
  minGapMs?: number;
  /** Called just before each command is sent; throw to refuse it (budget). */
  beforeSend?: (cmd: string) => void;
  /** Called after each command, with its outcome. */
  afterSend?: (cmd: string, outcome: { reply?: string; elapsedMs?: number; error?: string }) => void;
}

/** LoRa CLI payload ceiling, the same cap the /admin/cli route enforces. */
export const REMOTE_CLI_MAX_BYTES = 230;
export const REMOTE_SETTINGS_MIN_GAP_MS = 1000;

export class RemoteTransportAbortedError extends Error {
  constructor() {
    super('Remote settings run cancelled');
    this.name = 'RemoteTransportAbortedError';
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RemoteTransportAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createRemoteRepeaterTransport(
  manager: RemoteCliManager,
  publicKey: string,
  opts: RemoteRepeaterTransportOptions = {},
): RepeaterCliTransport {
  const minGapMs = opts.minGapMs ?? REMOTE_SETTINGS_MIN_GAP_MS;
  let lastReplyAt: number | null = null;

  return {
    mode: 'remote',
    async run(cmd: string): Promise<string> {
      if (opts.signal?.aborted) throw new RemoteTransportAbortedError();
      if (DANGER_COMMAND_PATTERN.test(cmd)) {
        throw new Error('Refusing to send a destructive command from the settings form');
      }
      if (Buffer.byteLength(cmd, 'utf8') > REMOTE_CLI_MAX_BYTES) {
        throw new Error(`Command too long (max ${REMOTE_CLI_MAX_BYTES} bytes)`);
      }
      if (lastReplyAt !== null) {
        await wait(lastReplyAt + minGapMs - Date.now(), opts.signal);
      }
      if (opts.signal?.aborted) throw new RemoteTransportAbortedError();
      opts.beforeSend?.(cmd);
      try {
        const result = await manager.sendCliCommand(publicKey, cmd, { timeoutMs: opts.timeoutMs });
        opts.afterSend?.(cmd, { reply: result.reply, elapsedMs: result.elapsedMs });
        return result.reply ?? '';
      } catch (err) {
        opts.afterSend?.(cmd, { error: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        lastReplyAt = Date.now();
        manager.recordMeshTx();
      }
    },
  };
}
