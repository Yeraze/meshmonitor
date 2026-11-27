import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeV4Body, decodeV4Text } from './decoder.js';
import { dumpV4 } from './dump.js';
import {
  McoImageV4CodecError,
  McoImageV4InvalidPayloadError,
  McoImageV4UnsupportedFormatError,
} from './errors.js';

const HOST_ERROR_PREFIX = 'Invalid v4 payload: ';

/**
 * Raster layers go through the Phase 1 v3 decoder, which ports the upstream JavaScript codec;
 * the Dart codec words two of its messages differently. Same error, same class.
 */
const DART_V3_MESSAGES: Record<string, string> = {
  'Compact sparse color index out of range': 'Sparse color index out of range',
  'Compact sparse palette contains background': 'Sparse palette contains background',
};

interface Entry {
  name: string;
  bodyHex?: string | null;
  text: string;
  result?: 'ok' | 'invalid' | 'unsupported';
  message?: string | null;
  messageExact?: boolean;
  dump?: unknown;
}

function load(file: string): Entry[] {
  const url = new URL(`../__fixtures__/${file}`, import.meta.url);
  if (!existsSync(url)) return [];
  const json = JSON.parse(readFileSync(url, 'utf8')) as { entries: Entry[] };
  return json.entries;
}

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

function check(entry: Entry, run: () => ReturnType<typeof decodeV4Body>): void {
  const result = entry.result ?? 'ok';
  if (result === 'ok') {
    expect(dumpV4(run())).toEqual(entry.dump);
    return;
  }
  const cls = result === 'invalid' ? McoImageV4InvalidPayloadError : McoImageV4UnsupportedFormatError;
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(cls);
  expect(caught).toBeInstanceOf(McoImageV4CodecError);
  // 'Invalid v4 payload: <host error>' wraps a Dart FormatException / TypeError text that
  // JavaScript cannot reproduce; the class is checked, the wrapper prefix is checked.
  const message = (caught as Error).message;
  if (entry.message !== undefined && entry.message !== null && entry.messageExact !== false) {
    const hostText = /^(MCOtxt: Invalid MCOtxt (?:RAW_UTF8|UTF8_RUN) bytes: )/.exec(entry.message);
    if (entry.message.startsWith(HOST_ERROR_PREFIX)) expect(message.startsWith(HOST_ERROR_PREFIX)).toBe(true);
    else if (hostText) expect(message.startsWith(hostText[1])).toBe(true);
    else expect(message).toBe(DART_V3_MESSAGES[entry.message] ?? entry.message);
  }
}

describe.each([
  ['v4-reference-fixtures.json'],
  ['v4-differential-fixtures.json'],
])('%s', (file) => {
  const entries = load(file);
  it('has entries', () => {
    expect(entries.length).toBeGreaterThan(0);
  });
  describe.each(entries.map((e, i) => [`${i}: ${e.name}`, e] as const))('%s', (_label, entry) => {
    if (typeof entry.bodyHex === 'string') {
      it('decodeV4Body', () => check(entry, () => decodeV4Body(hexToBytes(entry.bodyHex as string))));
    }
    it('decodeV4Text', () => check(entry, () => decodeV4Text(entry.text)));
  });
});
