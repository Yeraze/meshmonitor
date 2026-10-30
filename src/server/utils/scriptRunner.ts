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
import { dataPath } from '../config/dataDir.js';
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
 * Per-install directories where user-script dependencies are installed
 * (on the persisted `$DATA_DIR/scripts` volume, next to the scripts):
 *   - Python: `python_packages/` (pip `--target` install) → exposed via PYTHONPATH
 *   - Node:   `node_modules/`    (npm install)            → exposed via NODE_PATH
 * See scriptDependencyService for the install side.
 */
export const PYTHON_DEPS_SUBDIR = 'python_packages';
export const NODE_DEPS_SUBDIR = 'node_modules';

/** Stored, logical prefix for a user script, whatever DATA_DIR is. */
const LOGICAL_SCRIPTS_PREFIX = '/data/scripts/';

/** Absolute path to the user-scripts directory ($DATA_DIR/scripts, default /data/scripts). */
export function getScriptsDir(): string {
  return dataPath('scripts');
}

/**
 * Extra environment a script needs to import its installed dependencies.
 * Python gets PYTHONPATH pointed at the pip `--target` dir; Node gets
 * NODE_PATH pointed at node_modules. Existing PYTHONPATH/NODE_PATH (from the
 * process or caller env) is preserved by prepending the dep dir. Returns {} for
 * extensions with no dep mechanism (sh) or when the dep dir doesn't exist.
 */
export function scriptDependencyEnv(ext: string, baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  const scriptsDir = getScriptsDir();
  if (ext === 'py') {
    const dir = path.join(scriptsDir, PYTHON_DEPS_SUBDIR);
    if (!fs.existsSync(dir)) return {};
    const existing = baseEnv.PYTHONPATH;
    return { PYTHONPATH: existing ? `${dir}${path.delimiter}${existing}` : dir };
  }
  if (ext === 'js' || ext === 'mjs') {
    const dir = path.join(scriptsDir, NODE_DEPS_SUBDIR);
    if (!fs.existsSync(dir)) return {};
    const existing = baseEnv.NODE_PATH;
    return { NODE_PATH: existing ? `${dir}${path.delimiter}${existing}` : dir };
  }
  return {};
}

/**
 * Environment variables that must never reach a user script's child process.
 *
 * User scripts run arbitrary, uploaded code. Handing them the server's own
 * secrets (session key, admin password, DB connection string, OIDC/VAPID keys,
 * API tokens) turns any script execution into a one-shot credential dump
 * (INJ-01). Scripts receive only the explicit MESH/NODE/GEOFENCE/TIMER vars
 * their callers set, plus harmless process basics (PATH, HOME, LANG, …).
 *
 * The match is a denylist rather than an allowlist so scripts keep the mundane
 * process environment they rely on (PATH for the interpreter, plus PYTHONPATH
 * and NODE_PATH for installed deps) while every known secret shape is dropped.
 */
const SECRET_ENV_EXACT = new Set<string>(['SESSION_SECRET', 'ADMIN_PASSWORD']);
const SECRET_ENV_PREFIXES = ['DATABASE_', 'OIDC_', 'VAPID_', 'SMTP_'];
// Any var whose name advertises a secret: *SECRET*, *PASSWORD*/*PASSWD*,
// *TOKEN*, *PRIVATE_KEY*, *CREDENTIAL*, *API_KEY*/*APIKEY*.
const SECRET_ENV_PATTERN = /SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|CREDENTIAL|API_?KEY/i;

/** True when `key` names an environment variable that must be withheld from scripts. */
export function isSecretEnvKey(key: string): boolean {
  if (SECRET_ENV_EXACT.has(key)) return true;
  if (SECRET_ENV_PREFIXES.some((p) => key.startsWith(p))) return true;
  return SECRET_ENV_PATTERN.test(key);
}

/**
 * Copy `env` without the keys `isSecretEnvKey` flags. Returns a fresh object;
 * never mutates the input. Undefined values are dropped so the result is a
 * clean string map suitable for `child_process` `env`.
 */
export function sanitizeScriptEnv(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isSecretEnvKey(k)) continue;
    out[k] = String(v);
  }
  return out;
}

/**
 * Build the final child environment for a script spawn: strip the server's
 * secrets (INJ-01), layer on the dependency path (PYTHONPATH / NODE_PATH), and
 * — for Python — stop CPython from prepending the script's own directory
 * (`/data/scripts`) to `sys.path`. Without that last step an uploaded
 * `requests.py` / `os.py` silently shadows the real module for every later
 * Python run (MISC-01). `PYTHONSAFEPATH` is the documented env equivalent of
 * `python -P`, honoured by CPython 3.11+, and leaves `PYTHONPATH` (our deps
 * mechanism) intact. It is harmless for non-Python interpreters.
 */
export function buildScriptChildEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string>,
  ext: string,
): Record<string, string> {
  const sanitized = sanitizeScriptEnv(baseEnv);
  const depEnv = scriptDependencyEnv(ext, sanitized);
  const childEnv: Record<string, string> = { ...sanitized, ...depEnv };
  if (ext === 'py') {
    childEnv.PYTHONSAFEPATH = '1';
  }
  return childEnv;
}

/**
 * Resolve a user-supplied script identifier to an absolute path inside
 * the scripts directory. Rejects traversal (`..`) and anything outside
 * the directory. Returns null if the file doesn't exist or isn't
 * allowed.
 */
export function resolveScriptPath(scriptPath: string): { ok: true; path: string; ext: string } | { ok: false; error: string } {
  // Mirror getScriptsDirectory() in server.ts: prefer DATA_DIR env var,
  // fall back to /data. Tests can override DATA_DIR.
  const scriptsDir = getScriptsDir();

  // Allow caller to pass either a bare filename or a full path; either
  // way the resolved path must live inside the scripts dir.
  // `/data/scripts/<name>` is the stored, logical form other script surfaces
  // save (auto-responder, timers, script list). Map it onto the real scripts
  // dir so it still works when DATA_DIR is not /data (#5889). The containment
  // and traversal checks below still apply to the mapped path.
  const relative = scriptPath.startsWith(LOGICAL_SCRIPTS_PREFIX)
    ? scriptPath.slice(LOGICAL_SCRIPTS_PREFIX.length)
    : scriptPath;
  const candidate = path.isAbsolute(relative) ? relative : path.join(scriptsDir, relative);
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

  // Build the child env: strip server secrets (INJ-01), expose installed user
  // dependencies (PYTHONPATH / NODE_PATH), and block Python module shadowing
  // (MISC-01). See buildScriptChildEnv.
  const childEnv = buildScriptChildEnv({ ...process.env, ...opts.env }, ext);

  try {
    const { stdout, stderr } = await execFileAsync(interpreter, args, {
      timeout: timeoutMs,
      env: childEnv,
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
