import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runScript, parseScriptOutput, resolveScriptPath, scriptDependencyEnv, PYTHON_DEPS_SUBDIR, NODE_DEPS_SUBDIR } from './scriptRunner.js';

/**
 * Hosts a temporary scripts directory and points DATA_DIR at it so
 * `resolveScriptPath` finds our fixtures. Each test writes the script
 * it needs into this dir.
 */
let scriptsRoot: string;
let scriptsDir: string;
let originalDataDir: string | undefined;

beforeAll(() => {
  scriptsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meshcore-scriptrunner-'));
  scriptsDir = path.join(scriptsRoot, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = scriptsRoot;
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(scriptsRoot, { recursive: true, force: true });
});

function writeScript(name: string, body: string): string {
  const p = path.join(scriptsDir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return name;
}

describe('scriptDependencyEnv', () => {
  const pyDir = () => path.join(scriptsDir, PYTHON_DEPS_SUBDIR);
  const nodeDir = () => path.join(scriptsDir, NODE_DEPS_SUBDIR);

  afterAll(() => {
    fs.rmSync(pyDir(), { recursive: true, force: true });
    fs.rmSync(nodeDir(), { recursive: true, force: true });
  });

  it('returns {} when no dependency dirs exist', () => {
    fs.rmSync(pyDir(), { recursive: true, force: true });
    fs.rmSync(nodeDir(), { recursive: true, force: true });
    expect(scriptDependencyEnv('py', {})).toEqual({});
    expect(scriptDependencyEnv('mjs', {})).toEqual({});
    expect(scriptDependencyEnv('sh', {})).toEqual({});
  });

  it('exposes PYTHONPATH for python when python_packages exists', () => {
    fs.mkdirSync(pyDir(), { recursive: true });
    expect(scriptDependencyEnv('py', {})).toEqual({ PYTHONPATH: pyDir() });
  });

  it('exposes NODE_PATH for js/mjs when node_modules exists', () => {
    fs.mkdirSync(nodeDir(), { recursive: true });
    expect(scriptDependencyEnv('js', {})).toEqual({ NODE_PATH: nodeDir() });
    expect(scriptDependencyEnv('mjs', {})).toEqual({ NODE_PATH: nodeDir() });
  });

  it('prepends to an existing PYTHONPATH/NODE_PATH', () => {
    fs.mkdirSync(pyDir(), { recursive: true });
    fs.mkdirSync(nodeDir(), { recursive: true });
    expect(scriptDependencyEnv('py', { PYTHONPATH: '/existing' }).PYTHONPATH).toBe(`${pyDir()}${path.delimiter}/existing`);
    expect(scriptDependencyEnv('js', { NODE_PATH: '/existing' }).NODE_PATH).toBe(`${nodeDir()}${path.delimiter}/existing`);
  });
});

describe('parseScriptOutput', () => {
  it('returns empty messages for empty stdout', () => {
    expect(parseScriptOutput('')).toEqual({ wouldSendMessages: [] });
    expect(parseScriptOutput('   \n  ')).toEqual({ wouldSendMessages: [] });
  });

  it('treats raw stdout as one message when not JSON', () => {
    expect(parseScriptOutput('hello from script\n')).toEqual({
      wouldSendMessages: ['hello from script'],
    });
  });

  it('extracts string `response` from JSON', () => {
    const r = parseScriptOutput('{"response": "the answer"}');
    expect(r.wouldSendMessages).toEqual(['the answer']);
    expect(r.returnValue).toEqual({ response: 'the answer' });
  });

  it('extracts array `responses` from JSON', () => {
    const r = parseScriptOutput('{"responses": ["a", "b"]}');
    expect(r.wouldSendMessages).toEqual(['a', 'b']);
  });

  it('filters non-string entries from response array', () => {
    const r = parseScriptOutput('{"response": ["ok", 42, null, "fine"]}');
    expect(r.wouldSendMessages).toEqual(['ok', 'fine']);
  });

  it('exposes returnValue when JSON has no response/responses', () => {
    const r = parseScriptOutput('{"foo": 1, "bar": 2}');
    expect(r.wouldSendMessages).toEqual([]);
    expect(r.returnValue).toEqual({ foo: 1, bar: 2 });
  });

  it('handles a bare JSON string as both response and returnValue', () => {
    const r = parseScriptOutput('"single string"');
    expect(r.wouldSendMessages).toEqual(['single string']);
    expect(r.returnValue).toBe('single string');
  });
});

describe('resolveScriptPath', () => {
  it('rejects paths outside the scripts directory', () => {
    const r = resolveScriptPath('../etc/passwd');
    expect(r.ok).toBe(false);
  });

  it('rejects unknown extensions', () => {
    writeScript('weird.exe', '#!/bin/sh\necho nope\n');
    const r = resolveScriptPath('weird.exe');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/extension/);
  });

  it('resolves a bare filename to the scripts dir', () => {
    writeScript('hello.sh', '#!/bin/sh\necho hi\n');
    const r = resolveScriptPath('hello.sh');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe(path.join(scriptsDir, 'hello.sh'));
      expect(r.ext).toBe('sh');
    }
  });
});

describe('runScript', () => {
  it('captures stdout and exposes wouldSendMessages from a JSON response', async () => {
    writeScript('json-response.sh', '#!/bin/sh\necho \'{"response": "hi from script", "extra": 1}\'\n');
    const r = await runScript({ scriptPath: 'json-response.sh', env: {} });
    expect(r.success).toBe(true);
    expect(r.wouldSendMessages).toEqual(['hi from script']);
    expect(r.returnValue).toEqual({ response: 'hi from script', extra: 1 });
    expect(r.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('treats non-JSON stdout as a single message', async () => {
    writeScript('plain-text.sh', '#!/bin/sh\necho "plain text reply"\n');
    const r = await runScript({ scriptPath: 'plain-text.sh', env: {} });
    expect(r.success).toBe(true);
    expect(r.wouldSendMessages).toEqual(['plain text reply']);
  });

  it('passes env to the script', async () => {
    writeScript('echo-env.sh', '#!/bin/sh\necho "$MESHCORE_SOURCE_ID|$NODE_ID"\n');
    const r = await runScript({
      scriptPath: 'echo-env.sh',
      env: { MESHCORE_SOURCE_ID: 'src-1', NODE_ID: 'abc1234567890def' },
    });
    expect(r.success).toBe(true);
    expect(r.wouldSendMessages[0]).toBe('src-1|abc1234567890def');
  });

  it('passes argv to the script', async () => {
    writeScript('echo-args.sh', '#!/bin/sh\necho "args:$1:$2"\n');
    const r = await runScript({
      scriptPath: 'echo-args.sh',
      scriptArgs: ['first', 'second'],
      env: {},
    });
    expect(r.success).toBe(true);
    expect(r.wouldSendMessages[0]).toBe('args:first:second');
  });

  it('returns success=false with stderr when the script exits non-zero', async () => {
    writeScript('fail.sh', '#!/bin/sh\necho "broke" 1>&2\nexit 7\n');
    const r = await runScript({ scriptPath: 'fail.sh', env: {} });
    expect(r.success).toBe(false);
    expect(r.stderr).toMatch(/broke/);
    expect(r.error).toBeTruthy();
  });

  it('reports a timeout when the script hangs longer than timeoutMs', async () => {
    writeScript('hang.sh', '#!/bin/sh\nsleep 5\necho done\n');
    const r = await runScript({ scriptPath: 'hang.sh', env: {}, timeoutMs: 250 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/timed out/i);
  });

  it('returns a clear error when the script does not exist', async () => {
    const r = await runScript({ scriptPath: 'missing-xyz.sh', env: {} });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  it('rejects paths outside the scripts directory', async () => {
    const r = await runScript({ scriptPath: '../../etc/passwd', env: {} });
    expect(r.success).toBe(false);
  });
});
