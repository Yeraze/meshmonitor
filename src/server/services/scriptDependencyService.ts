/**
 * User-script dependency management (Option A).
 *
 * Lets operators declare third-party dependencies for Auto Responder / trigger
 * scripts via manifests on the persisted scripts volume, and install them into
 * directories next to the scripts:
 *   - Python: `$DATA_DIR/scripts/requirements.txt` → pip `--target python_packages`
 *             (exposed to scripts via PYTHONPATH; see scriptRunner)
 *   - Node:   `$DATA_DIR/scripts/package.json`     → `npm install` (node_modules,
 *             exposed via NODE_PATH)
 *
 * Installs reuse the same interpreters that run the scripts (ABI-matched). By
 * default Python installs are wheel-only (`--only-binary=:all:`) so the slim
 * Alpine/musl image doesn't need a compiler; set
 * `SCRIPT_DEPS_ALLOW_SOURCE_BUILD=true` to permit source builds.
 *
 * Security: installing packages downloads and runs third-party code. Routes are
 * admin-gated; a single in-flight install is allowed at a time.
 */
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getScriptsDir, PYTHON_DEPS_SUBDIR, NODE_DEPS_SUBDIR, pickInterpreter } from '../utils/scriptRunner.js';
import { logger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

export const PYTHON_MANIFEST = 'requirements.txt';
export const NODE_MANIFEST = 'package.json';
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_INSTALL_BUFFER = 8 * 1024 * 1024;

let installInFlight = false;

export interface DependencyKindStatus {
  manifestPresent: boolean;
  installed: boolean;
  packages: string[];
}

export interface DependencyStatus {
  python: DependencyKindStatus;
  node: DependencyKindStatus;
  /** Whether source builds are permitted (SCRIPT_DEPS_ALLOW_SOURCE_BUILD=true). */
  allowSourceBuilds: boolean;
  /** Where the manifests + installed deps live (for the UI to show). */
  scriptsDir: string;
}

export interface InstallResult {
  success: boolean;
  log: string;
  error?: string;
}

function listPythonPackages(target: string): string[] {
  if (!fs.existsSync(target)) return [];
  try {
    return fs
      .readdirSync(target)
      .filter((n) => n.endsWith('.dist-info'))
      .map((n) => n.replace(/\.dist-info$/, '').replace(/-([0-9][^-]*.*)$/, ' $1'))
      .sort();
  } catch {
    return [];
  }
}

function listNodePackages(target: string): string[] {
  if (!fs.existsSync(target)) return [];
  try {
    return fs
      .readdirSync(target, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .flatMap((d) =>
        d.name.startsWith('@')
          ? fs.readdirSync(path.join(target, d.name)).map((s) => `${d.name}/${s}`)
          : [d.name],
      )
      .sort();
  } catch {
    return [];
  }
}

export async function getDependencyStatus(): Promise<DependencyStatus> {
  const dir = getScriptsDir();
  const pyTarget = path.join(dir, PYTHON_DEPS_SUBDIR);
  const nodeTarget = path.join(dir, NODE_DEPS_SUBDIR);
  return {
    python: {
      manifestPresent: fs.existsSync(path.join(dir, PYTHON_MANIFEST)),
      installed: fs.existsSync(pyTarget),
      packages: listPythonPackages(pyTarget),
    },
    node: {
      manifestPresent: fs.existsSync(path.join(dir, NODE_MANIFEST)),
      installed: fs.existsSync(nodeTarget),
      packages: listNodePackages(nodeTarget),
    },
    allowSourceBuilds: process.env.SCRIPT_DEPS_ALLOW_SOURCE_BUILD === 'true',
    scriptsDir: dir,
  };
}

/** Run one install command, capturing combined output without throwing. */
async function runInstall(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: MAX_INSTALL_BUFFER,
      env: process.env,
    });
    return { ok: true, output: stdout + (stderr ? `\n${stderr}` : '') };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
    const output = (e.stdout || '') + (e.stderr ? `\n${e.stderr}` : '');
    const reason = e.killed ? `timed out after ${INSTALL_TIMEOUT_MS / 1000}s` : e.message;
    return { ok: false, output: `${output}\n[${cmd} failed: ${reason}]` };
  }
}

/**
 * Install the dependencies declared in the scripts directory's manifests.
 * Installs Python (if requirements.txt present) and Node (if package.json
 * present). Returns the combined log and overall success. Single-flight.
 */
export async function installDependencies(): Promise<InstallResult> {
  if (installInFlight) {
    return { success: false, log: '', error: 'A dependency install is already in progress' };
  }
  installInFlight = true;
  const dir = getScriptsDir();
  let log = '';
  let ranSomething = false;
  let ok = true;
  try {
    const pyManifest = path.join(dir, PYTHON_MANIFEST);
    if (fs.existsSync(pyManifest)) {
      ranSomething = true;
      const py = pickInterpreter('py');
      const target = path.join(dir, PYTHON_DEPS_SUBDIR);
      const args = ['-m', 'pip', 'install', '--target', target, '--upgrade', '-r', pyManifest];
      if (process.env.SCRIPT_DEPS_ALLOW_SOURCE_BUILD !== 'true') {
        // Wheel-only so the slim Alpine/musl image needs no compiler. Packages
        // without a musl wheel fail clearly rather than attempting a build.
        args.push('--only-binary=:all:');
      }
      log += `$ ${py} ${args.join(' ')}\n`;
      const r = await runInstall(py, args, dir);
      log += r.output + '\n';
      ok = ok && r.ok;
    }

    const nodeManifest = path.join(dir, NODE_MANIFEST);
    if (fs.existsSync(nodeManifest)) {
      ranSomething = true;
      const args = ['install', '--no-audit', '--no-fund', '--omit=dev'];
      log += `\n$ npm ${args.join(' ')} (in ${dir})\n`;
      const r = await runInstall('npm', args, dir);
      log += r.output + '\n';
      ok = ok && r.ok;
    }

    if (!ranSomething) {
      return {
        success: false,
        log,
        error: `No ${PYTHON_MANIFEST} or ${NODE_MANIFEST} found in the scripts directory`,
      };
    }
    logger.info(`[ScriptDeps] Dependency install ${ok ? 'succeeded' : 'reported errors'}`);
    return { success: ok, log, error: ok ? undefined : 'One or more installs reported errors — see the log' };
  } finally {
    installInFlight = false;
  }
}
