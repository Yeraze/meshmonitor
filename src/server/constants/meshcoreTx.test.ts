import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  RF_BRIDGE_COMMANDS,
  SERIAL_ONLY_BRIDGE_COMMANDS,
  isRfBridgeCommand,
  isTransmittingLocalCliVerb,
} from './meshcoreTx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Denylist-completeness test (#4547 Phase 1 §3.1).
 *
 * Reads meshcoreManager.ts and meshcoreNativeBackend.ts as text and extracts
 * every bridge-command literal each file references, then asserts every one
 * is classified in exactly one of RF_BRIDGE_COMMANDS / SERIAL_ONLY_BRIDGE_COMMANDS.
 *
 * This is the regression net for "someone adds a new bridge command and
 * forgets to classify it." A new `case '<name>':` added to the native
 * backend's dispatch switch without a matching entry in meshcoreTx.ts fails
 * this test at review time (verified manually during implementation by
 * temporarily adding a fake case and confirming this test fails, then
 * removing it).
 */

function extractSendBridgeCommandLiterals(source: string): string[] {
  // Matches `sendBridgeCommand('name'` and `sendBridgeCommand(\n  'name'`
  // (tolerates a newline/whitespace between the open paren and the literal —
  // there is one multi-line call site for 'trace_path').
  const re = /sendBridgeCommand\(\s*'([a-z_]+)'/g;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    names.add(match[1]);
  }
  return [...names];
}

/**
 * Isolate the source text of `private async dispatch(cmd: string, ...)` —
 * the bridge-command switch — by brace-counting from its signature to the
 * matching close brace. Anchoring here (rather than scanning the whole file)
 * keeps this test from tripping on an unrelated lowercase `case` label in
 * some other switch (push codes, status codes, etc.) added later.
 */
function extractDispatchMethodSource(source: string): string {
  const marker = 'private async dispatch(cmd: string';
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(
      "Could not locate 'private async dispatch(cmd: string' in meshcoreNativeBackend.ts — " +
        'has the bridge-command dispatch method been renamed or reshaped? Update the marker in ' +
        'extractDispatchMethodSource to match.',
    );
  }
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

function extractDispatchCaseLiterals(source: string): string[] {
  const dispatchSource = extractDispatchMethodSource(source);
  const re = /case '([a-z_]+)':/g;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(dispatchSource)) !== null) {
    names.add(match[1]);
  }
  return [...names];
}

describe('meshcoreTx denylist completeness (#4547)', () => {
  const managerSource = fs.readFileSync(
    path.join(__dirname, '../meshcoreManager.ts'),
    'utf-8',
  );
  const backendSource = fs.readFileSync(
    path.join(__dirname, '../meshcoreNativeBackend.ts'),
    'utf-8',
  );

  const managerCommands = extractSendBridgeCommandLiterals(managerSource);
  const backendCommands = extractDispatchCaseLiterals(backendSource);
  const allCommands = new Set<string>([...managerCommands, ...backendCommands]);

  it('extracted at least the expected command literals from source', () => {
    // Sanity check that the extraction itself isn't silently returning
    // nothing (e.g. a renamed method breaking the regex).
    expect(managerCommands.length).toBeGreaterThan(0);
    expect(backendCommands.length).toBeGreaterThan(0);
  });

  it('classifies every extracted command name in exactly one of the two sets', () => {
    const unclassified = [...allCommands].filter(
      (cmd) => !RF_BRIDGE_COMMANDS.has(cmd) && !SERIAL_ONLY_BRIDGE_COMMANDS.has(cmd),
    );
    expect(
      unclassified,
      `Unclassified bridge command(s) found in source: ${unclassified.join(', ')}. ` +
        `Add each to either RF_BRIDGE_COMMANDS or SERIAL_ONLY_BRIDGE_COMMANDS in ` +
        `src/server/constants/meshcoreTx.ts.`,
    ).toEqual([]);

    const doubleClassified = [...allCommands].filter(
      (cmd) => RF_BRIDGE_COMMANDS.has(cmd) && SERIAL_ONLY_BRIDGE_COMMANDS.has(cmd),
    );
    expect(doubleClassified).toEqual([]);
  });

  it('RF_BRIDGE_COMMANDS and SERIAL_ONLY_BRIDGE_COMMANDS are disjoint', () => {
    const overlap = [...RF_BRIDGE_COMMANDS].filter((cmd) => SERIAL_ONLY_BRIDGE_COMMANDS.has(cmd));
    expect(overlap).toEqual([]);
  });

  it('pins the current classification sizes (deliberate, like PER_SOURCE_KEYS_NOT_POSTABLE.size)', () => {
    expect(RF_BRIDGE_COMMANDS.size).toBe(14);
    expect(SERIAL_ONLY_BRIDGE_COMMANDS.size).toBe(29);
    expect(RF_BRIDGE_COMMANDS.size + SERIAL_ONLY_BRIDGE_COMMANDS.size).toBe(43);
  });
});

describe('isRfBridgeCommand (#4547)', () => {
  it('returns true (fail-closed) for a command name not in either set', () => {
    expect(isRfBridgeCommand('some_command_that_does_not_exist')).toBe(true);
  });

  it('returns false for every serial-only command', () => {
    for (const cmd of SERIAL_ONLY_BRIDGE_COMMANDS) {
      expect(isRfBridgeCommand(cmd)).toBe(false);
    }
  });

  it('returns true for every RF command', () => {
    for (const cmd of RF_BRIDGE_COMMANDS) {
      expect(isRfBridgeCommand(cmd)).toBe(true);
    }
  });
});

describe('isTransmittingLocalCliVerb (#4547)', () => {
  it.each(['advert', 'ADVERT', ' advert '])('returns true for %j', (cmd) => {
    expect(isTransmittingLocalCliVerb(cmd)).toBe(true);
  });

  it.each(['ver', 'stats radio', 'clock', 'help', 'get name'])('returns false for %j', (cmd) => {
    expect(isTransmittingLocalCliVerb(cmd)).toBe(false);
  });
});
