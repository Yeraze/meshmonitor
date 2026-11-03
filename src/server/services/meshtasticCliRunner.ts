/**
 * Meshtastic remote-admin CLI runner (#6154).
 *
 * The single place the `meshtastic` binary is spawned for the free-form
 * console. Isolated in its own module so route tests can mock the spawn
 * (`vi.mock('../services/meshtasticCliRunner.js')`) without going near the
 * argument-parsing / danger-guard logic in meshtasticCli.ts.
 *
 * SECURITY: uses `child_process.execFile` with an argv ARRAY — never a shell,
 * never a command string. The binary is resolved from PATH (the Docker image
 * symlinks it at /usr/local/bin/meshtastic). A timeout kills the child so a
 * hung radio round trip cannot pin a worker forever.
 */

import { execFile } from 'node:child_process';
import { logger } from '../../utils/logger.js';

export interface MeshtasticCliResult {
  stdout: string;
  stderr: string;
  /** Process exit code; null when the child was killed (e.g. timeout). */
  exitCode: number | null;
  /** True when the child was killed because it exceeded the timeout. */
  timedOut: boolean;
  elapsedMs: number;
}

export interface RunMeshtasticCliOptions {
  /** Hard timeout; the child is killed when it elapses. */
  timeoutMs: number;
  /** Max bytes captured from stdout/stderr before the child is killed. */
  maxBuffer?: number;
}

/** Binary name; PATH-resolved. Overridable for non-standard installs. */
const CLI_BIN = process.env.MESHTASTIC_CLI_BIN || 'meshtastic';

/** 1 MiB default output cap — a CLI reply is text, never large. */
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * Run `meshtastic` with the given argv and capture stdout/stderr.
 *
 * Never rejects on a non-zero exit — the caller decides how to present a
 * failed command (the stderr is usually the useful part). It only rejects if
 * the binary itself cannot be spawned (e.g. not installed).
 */
export async function runMeshtasticCli(
  argv: string[],
  opts: RunMeshtasticCliOptions,
): Promise<MeshtasticCliResult> {
  const startedAt = Date.now();
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise<MeshtasticCliResult>((resolve, reject) => {
    execFile(
      CLI_BIN,
      argv,
      {
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer,
        // Explicitly no `shell` — execFile does not use a shell by default,
        // but spell it out so a future edit cannot silently flip it on.
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const elapsedMs = Date.now() - startedAt;
        const out = String(stdout ?? '');
        const err = String(stderr ?? '');

        if (error) {
          const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number; signal?: string };
          // ENOENT means the binary is missing — that is a server
          // configuration failure, not a command result.
          if (e.code === 'ENOENT') {
            logger.error('[MeshtasticCLI] meshtastic binary not found on PATH');
            reject(new Error('meshtastic CLI binary not found'));
            return;
          }
          const timedOut = e.killed === true || e.signal === 'SIGKILL' || e.signal === 'SIGTERM';
          resolve({
            stdout: out,
            stderr: err,
            exitCode: typeof e.code === 'number' ? e.code : null,
            timedOut,
            elapsedMs,
          });
          return;
        }

        resolve({ stdout: out, stderr: err, exitCode: 0, timedOut: false, elapsedMs });
      },
    );
  });
}
