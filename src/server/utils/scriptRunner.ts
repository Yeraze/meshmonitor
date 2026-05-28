/**
 * Generic script runner used by both Meshtastic and MeshCore automation
 * features. Spawns a script under one of three interpreters (node /
 * python3 / sh) with a caller-supplied environment, captures stdout
 * + stderr, and parses the stdout into a structured result.
 *
 * Stays protocol-neutral on purpose: callers build their own env map
 * (FROM_NODE, NODE_ID, CHANNEL, MESHCORE_SOURCE_ID, …) and consume
 * `wouldSendMessages` by sending through their own primitives. That
 * keeps Meshtastic and MeshCore on a shared spawn/parse contract
 * without coupling either to the other's data model.
 *
 * Path validation mirrors the existing inline runners in
 * `meshtasticManager.ts` / `server.ts` (whitelist to scripts dir,
 * extension allowlist, no traversal). Keep these aligned — both
 * surfaces must agree on what's executable.
 */
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface RunScriptOptions {
  /** Filename inside the scripts directory, or an absolute path resolved underneath it. */
  scriptPath: string;
  /** Already-parsed argv. Token expansion is the caller's job. */
  scriptArgs?: string[];
  /** Process env to expose to the script. Merged on top of process.env. */
  env: Record<string, string>;
  /** Hard kill timeout. Default 30s. */
  timeoutMs?: number;
}

export interface RunScriptResult {
  success: boolean;
  /** Raw stdout captured from the script. */
  stdout: string;
  /** Raw stderr captured from the script. */
  stderr: string;
  /**
   * Messages the script wants the caller to transmit on the mesh.
   * Populated from `response`/`responses` in the script's JSON output,
   * or a single entry equal to raw stdout if the output isn't JSON.
   * Empty when the script produced no usable output.
   */
  wouldSendMessages: string[];
  /** Parsed JSON output, if the script printed valid JSON. */
  returnValue?: unknown;
  /** Wall-clock execution time in ms. */
  executionTimeMs: number;
  /** When `success=false`, a short human-readable reason. */
  error?: string;
}

const ALLOWED_EXTENSIONS = new Set(['js', 'mjs', 'py', 'sh']);

/**
 * Resolve a user-supplied script identifier to an absolute path inside
 * the scripts directory. Rejects traversal (`..`) and anything outside
 * the directory. Returns null if the file doesn't exist or isn't
 * allowed.
 */
export function resolveScriptPath(scriptPath: string): { ok: true; path: string; ext: string } | { ok: false; error: string } {
  // Mirror getScriptsDirectory() in server.ts: prefer DATA_DIR env var,
  // fall back to /data. Tests can override DATA_DIR.
  const scriptsDir = path.join(process.env.DATA_DIR || '/data', 'scripts');

  // Allow caller to pass either a bare filename or a full path; either
  // way the resolved path must live inside the scripts dir.
  const candidate = path.isAbsolute(scriptPath) ? scriptPath : path.join(scriptsDir, scriptPath);
  const resolved = path.resolve(candidate);
  const normalizedDir = path.resolve(scriptsDir);
  if (!resolved.startsWith(normalizedDir + path.sep) && resolved !== normalizedDir) {
    return { ok: false, error: 'Script path escapes scripts directory' };
  }
  if (resolved.includes('..')) {
    return { ok: false, error: 'Script path contains traversal' };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `Script not found: ${path.basename(resolved)}` };
  }
  const ext = path.extname(resolved).slice(1).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, error: `Unsupported script extension: .${ext || '(none)'}` };
  }
  return { ok: true, path: resolved, ext };
}

/**
 * Pick the interpreter binary for `ext`. In production builds inside
 * the Docker image, system binaries aren't on PATH, so we point at
 * the bundled-Node and the apprise venv's Python explicitly. In dev /
 * desktop builds the system binaries are fine.
 *
 * Matches the existing inline logic in meshtasticManager / server so
 * scripts behave identically across the two runners.
 */
export function pickInterpreter(ext: string): string {
  const useSystemBin = process.env.NODE_ENV !== 'production' || process.env.IS_DESKTOP === 'true';
  switch (ext) {
    case 'js':
    case 'mjs':
      return useSystemBin ? 'node' : '/usr/local/bin/node';
    case 'py':
      return useSystemBin ? 'python3' : '/opt/apprise-venv/bin/python3';
    case 'sh':
      return useSystemBin ? 'sh' : '/bin/sh';
    default:
      throw new Error(`pickInterpreter: unsupported extension "${ext}"`);
  }
}

/**
 * Parse the script's stdout into the structured fields. Format
 * contract:
 *   - If stdout parses as JSON with a string `response` or string-array
 *     `response`/`responses`, that becomes `wouldSendMessages`.
 *   - If stdout parses as JSON otherwise, returnValue is set and
 *     wouldSendMessages is empty.
 *   - If stdout isn't JSON, the trimmed raw stdout is a single
 *     `wouldSendMessages` entry (empty stdout → empty array).
 *
 * This mirrors the existing Meshtastic auto-responder / test-handler
 * parsing so a script written for one stack works for the other.
 */
export function parseScriptOutput(stdout: string): { wouldSendMessages: string[]; returnValue?: unknown } {
  const trimmed = stdout.trim();
  if (!trimmed) return { wouldSendMessages: [] };

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') {
      return { wouldSendMessages: [parsed], returnValue: parsed };
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      let messages: string[] = [];
      const candidate = obj.response ?? obj.responses;
      if (typeof candidate === 'string') {
        messages = [candidate];
      } else if (Array.isArray(candidate)) {
        messages = candidate.filter((v): v is string => typeof v === 'string');
      }
      return { wouldSendMessages: messages, returnValue: parsed };
    }
    return { wouldSendMessages: [String(parsed)], returnValue: parsed };
  } catch {
    return { wouldSendMessages: [trimmed] };
  }
}

/**
 * Spawn the script and return a structured result. Never throws —
 * caller branches on `result.success`. Timeouts surface as
 * `success=false, error='Script timed out (Ns)'`.
 */
export async function runScript(opts: RunScriptOptions): Promise<RunScriptResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const resolved = resolveScriptPath(opts.scriptPath);
  if (!resolved.ok) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      wouldSendMessages: [],
      executionTimeMs: 0,
      error: resolved.error,
    };
  }
  const { path: resolvedPath, ext } = resolved;
  const interpreter = pickInterpreter(ext);
  const args = [resolvedPath, ...(opts.scriptArgs || [])];

  try {
    const { stdout, stderr } = await execFileAsync(interpreter, args, {
      timeout: timeoutMs,
      env: { ...process.env, ...opts.env },
      maxBuffer: 1024 * 1024,
    });
    const parsed = parseScriptOutput(stdout);
    return {
      success: true,
      stdout,
      stderr,
      wouldSendMessages: parsed.wouldSendMessages,
      returnValue: parsed.returnValue,
      executionTimeMs: Date.now() - start,
    };
  } catch (err) {
    const e = err as Error & {
      code?: string;
      stdout?: string;
      stderr?: string;
      signal?: string;
      killed?: boolean;
    };
    const timedOut = e.killed === true || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
    return {
      success: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      wouldSendMessages: [],
      executionTimeMs: Date.now() - start,
      error: timedOut
        ? `Script timed out after ${Math.round(timeoutMs / 1000)}s`
        : (e.message || 'Script execution failed'),
    };
  }
}
