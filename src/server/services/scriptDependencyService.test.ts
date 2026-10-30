import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Capture the install subprocess invocations without spawning anything real.
// execFile is wrapped with util.promisify in the service, so the mock supplies
// the well-known promisify.custom implementation.
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('child_process', () => {
  const execFile: unknown = () => {};
  (execFile as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] = (
    cmd: string,
    args: string[]
  ) => {
    spawnCalls.push({ cmd, args });
    return Promise.resolve({ stdout: 'ok', stderr: '' });
  };
  return { execFile };
});

import { getDependencyStatus, installDependencies } from './scriptDependencyService.js';

let root: string;
let scriptsDir: string;
let originalDataDir: string | undefined;
let originalAllowBuild: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptdeps-'));
  scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  originalDataDir = process.env.DATA_DIR;
  originalAllowBuild = process.env.SCRIPT_DEPS_ALLOW_SOURCE_BUILD;
  process.env.DATA_DIR = root;
  delete process.env.SCRIPT_DEPS_ALLOW_SOURCE_BUILD;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
  if (originalAllowBuild === undefined) delete process.env.SCRIPT_DEPS_ALLOW_SOURCE_BUILD; else process.env.SCRIPT_DEPS_ALLOW_SOURCE_BUILD = originalAllowBuild;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('getDependencyStatus', () => {
  it('reports no manifests / nothing installed on an empty scripts dir', async () => {
    const s = await getDependencyStatus();
    expect(s.python).toEqual({ manifestPresent: false, installed: false, packages: [] });
    expect(s.node).toEqual({ manifestPresent: false, installed: false, packages: [] });
    expect(s.allowSourceBuilds).toBe(false);
    expect(s.scriptsDir).toBe(scriptsDir);
  });

  it('detects manifests and lists installed python + node packages', async () => {
    fs.writeFileSync(path.join(scriptsDir, 'requirements.txt'), 'requests==2.31.0\n');
    fs.writeFileSync(path.join(scriptsDir, 'package.json'), '{"dependencies":{"left-pad":"1.3.0"}}');
    // Simulate an installed python target (pip lays down <name>-<version>.dist-info).
    const pyTarget = path.join(scriptsDir, 'python_packages');
    fs.mkdirSync(path.join(pyTarget, 'requests-2.31.0.dist-info'), { recursive: true });
    // Simulate node_modules with a scoped + unscoped package.
    const nodeTarget = path.join(scriptsDir, 'node_modules');
    fs.mkdirSync(path.join(nodeTarget, 'left-pad'), { recursive: true });
    fs.mkdirSync(path.join(nodeTarget, '@scope', 'thing'), { recursive: true });
    fs.mkdirSync(path.join(nodeTarget, '.bin'), { recursive: true }); // ignored

    const s = await getDependencyStatus();
    expect(s.python.manifestPresent).toBe(true);
    expect(s.python.installed).toBe(true);
    expect(s.python.packages).toEqual(['requests 2.31.0']);
    expect(s.node.manifestPresent).toBe(true);
    expect(s.node.installed).toBe(true);
    expect(s.node.packages).toEqual(['@scope/thing', 'left-pad']);
  });

  it('reflects SCRIPT_DEPS_ALLOW_SOURCE_BUILD', async () => {
    process.env.SCRIPT_DEPS_ALLOW_SOURCE_BUILD = 'true';
    expect((await getDependencyStatus()).allowSourceBuilds).toBe(true);
  });
});

describe('installDependencies', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it('returns an error without spawning anything when no manifest exists', async () => {
    const r = await installDependencies();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No requirements\.txt or package\.json/);
  });

  it('passes --ignore-scripts to npm so package lifecycle hooks never run (INJ-04)', async () => {
    fs.writeFileSync(path.join(scriptsDir, 'package.json'), '{"name":"x","version":"1.0.0"}');
    const r = await installDependencies();
    expect(r.success).toBe(true);

    const npm = spawnCalls.find((c) => c.cmd === 'npm');
    expect(npm, 'npm install should have been invoked').toBeTruthy();
    expect(npm!.args).toContain('install');
    expect(npm!.args).toContain('--ignore-scripts');
  });
});
