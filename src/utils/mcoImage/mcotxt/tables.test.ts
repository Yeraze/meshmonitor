import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MCOTXT_GEN0_MODELS, MCOTXT_LANGUAGE_CODES } from './tables.js';

// Wire hashes from HDDen/meshcore-open tag 9.5.1-mod-1.9.0, lib/MCOtxt/models/generated/v1/model_*.dart
// (MIT, (c) 2025 zjs81).
const DART_HASHES: Record<string, string> = {
  en: '55988b3bb2a000adf6e768a8541df5a25fec1628b4ec661a10b577e3af8b3770',
  ru: 'd123c4978a635bf1b26fe37261b7e96a0206b3ba15b2a80542e560f00d1eb193',
  fr: '910c5821a202a9b35313a9b939355f09d1c4293fe2ed246fed0123639d379ccb',
  de: '00b971288fee56f37535ce03b4ac0d8ebddfc12ecbd5ef282ab4b0f4a659f451',
  it: 'f6d073a1d6ae6344eaac445b86fb8a454b276a740fd40651956b1ff28f5af270',
  uk: '949992c57156526843cdb9634c5c14bee23218878f116ef90be2a8497274c131',
  be: 'dd23c2b82288e0a4452f237ccd905055974779e3cc5cc6f3d03be1b24e5bb1fd',
};

const cp = (text: string): number[] => Array.from(text, (s) => s.codePointAt(0) as number);

function canon(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map((k) => JSON.stringify(k) + ':' + canon(record[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

describe('MCOtxt generation-0 tables', () => {
  it('has seven models in wire order', () => {
    expect(MCOTXT_GEN0_MODELS).toHaveLength(7);
    MCOTXT_GEN0_MODELS.forEach((model, index) => expect(model.id).toBe(index));
  });

  MCOTXT_LANGUAGE_CODES.forEach((code, id) => {
    it(`${code}: recomputed wire hash matches the embedded and the Dart hash`, () => {
      const model = MCOTXT_GEN0_MODELS[id]!;
      const s = model.source;
      const symbols = cp(s.primary + s.extension);
      const upper = cp(s.upper);
      const lower = cp(s.lower);
      const uppercaseMap = upper
        .map((u, i) => ({ lowercaseSymbolIndex: symbols.indexOf(lower[i]!), uppercaseCodepoint: u }))
        .sort((a, b) => a.uppercaseCodepoint - b.uppercaseCodepoint);
      const doc = {
        codecVersion: 1,
        language: code,
        languageId: id,
        primarySymbols: cp(s.primary),
        extensionSymbols: cp(s.extension),
        startTop4Indexes: s.start,
        punctStartTop4Indexes: s.afterPunct,
        top4Indexes: s.rows,
        uppercaseMap,
      };
      const hash = createHash('sha256').update(canon(doc), 'utf8').digest('hex');
      expect(hash).toBe(model.hash);
      expect(hash).toBe(DART_HASHES[code]);
    });
  });
});
