import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeV4Body, decodeV4Text } from './decoder.js';
import { dumpV4 } from './dump.js';
import {
  McoImageV4CodecError,
  McoImageV4InvalidPayloadError,
  McoImageV4UnsupportedFormatError,
} from './errors.js';

interface Entry {
  name: string;
  bodyHex?: string;
  text: string;
  result?: 'ok' | 'invalid' | 'unsupported';
  message?: string | null;
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
  if (entry.message !== undefined && entry.message !== null) {
    expect((caught as Error).message).toBe(entry.message);
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
    if (entry.bodyHex !== undefined) {
      it('decodeV4Body', () => check(entry, () => decodeV4Body(hexToBytes(entry.bodyHex as string))));
    }
    it('decodeV4Text', () => check(entry, () => decodeV4Text(entry.text)));
  });
});
