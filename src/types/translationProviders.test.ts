/**
 * Translation provider descriptors (#5518): the data every other piece
 * (settings form, allowlists, URL validation, provider configs) derives from.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TranslationProvider } from './translation.js';
import {
  DEFAULT_TRANSLATION_PROVIDER,
  TRANSLATION_PROVIDER_DESCRIPTORS,
  TRANSLATION_PROVIDER_IDS,
  TRANSLATION_PROVIDER_SECRET_SETTING_KEYS,
  TRANSLATION_PROVIDER_SETTING_KEYS,
  TRANSLATION_PROVIDER_URL_SETTING_KEYS,
  buildTranslationProviderConfig,
  emptyTranslationProviderFieldValues,
  getTranslationProviderFields,
  isTranslationProvider,
  missingRequiredTranslationFields,
  type TranslationProviderField,
} from './translationProviders.js';
import { getTranslationProvider } from '../server/services/translation/providers/index.js';

const EN: Record<string, unknown> = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../public/locales/en.json'), 'utf-8'),
);

/**
 * Compile-time: a provider id with no descriptor fails `tsc` here (and at the
 * `satisfies` in the descriptor file). The runtime tests below cover the rest.
 */
const EVERY_ID: Record<TranslationProvider, true> = { libretranslate: true, openai: true, deepl: true, google: true };

const allFields = (): TranslationProviderField[] =>
  TRANSLATION_PROVIDER_IDS.flatMap((id) => [...getTranslationProviderFields(id)]);

describe('translation provider descriptors', () => {
  it('every TranslationProvider id has a descriptor and a provider instance', () => {
    expect([...TRANSLATION_PROVIDER_IDS].sort()).toEqual(Object.keys(EVERY_ID).sort());
    for (const id of TRANSLATION_PROVIDER_IDS) {
      expect(TRANSLATION_PROVIDER_DESCRIPTORS[id].id).toBe(id);
      expect(getTranslationProvider(id).id).toBe(id);
    }
    expect(TRANSLATION_PROVIDER_IDS).toContain(DEFAULT_TRANSLATION_PROVIDER);
  });

  it('isTranslationProvider accepts only declared ids', () => {
    for (const id of TRANSLATION_PROVIDER_IDS) expect(isTranslationProvider(id)).toBe(true);
    for (const bad of ['', 'nope', 'constructor', '__proto__', 'toString', null, undefined, 3]) {
      expect(isTranslationProvider(bad)).toBe(false);
    }
  });

  it('every label, hint and placeholder key exists in en.json with text', () => {
    const keys: string[] = [];
    for (const id of TRANSLATION_PROVIDER_IDS) keys.push(TRANSLATION_PROVIDER_DESCRIPTORS[id].labelKey);
    for (const field of allFields()) {
      keys.push(field.labelKey);
      if (field.hintKey) keys.push(field.hintKey);
      if (field.placeholderKey) keys.push(field.placeholderKey);
    }
    const missing = keys.filter((key) => typeof EN[key] !== 'string' || !(EN[key] as string).trim());
    expect(missing).toEqual([]);
  });

  it('each field of a provider has its own label key (no shared "API Key" label)', () => {
    const labels = allFields().map((f) => f.labelKey);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('settings keys and input ids are unique; config keys are unique within a provider', () => {
    const fields = allFields();
    expect(new Set(fields.map((f) => f.settingKey)).size).toBe(fields.length);
    expect(new Set(fields.map((f) => f.inputId)).size).toBe(fields.length);
    for (const id of TRANSLATION_PROVIDER_IDS) {
      const configKeys = getTranslationProviderFields(id).map((f) => f.configKey);
      expect(new Set(configKeys).size).toBe(configKeys.length);
    }
  });

  it('derived key lists match the fields by kind', () => {
    const fields = allFields();
    expect([...TRANSLATION_PROVIDER_SETTING_KEYS]).toEqual(fields.map((f) => f.settingKey));
    expect([...TRANSLATION_PROVIDER_SECRET_SETTING_KEYS]).toEqual(
      fields.filter((f) => f.kind === 'secret').map((f) => f.settingKey));
    expect([...TRANSLATION_PROVIDER_URL_SETTING_KEYS]).toEqual(
      fields.filter((f) => f.kind === 'url').map((f) => f.settingKey));
    expect(Object.keys(emptyTranslationProviderFieldValues()).sort()).toEqual([...TRANSLATION_PROVIDER_SETTING_KEYS].sort());
  });

  it('every provider has exactly one secret field, on a key of its own', () => {
    const secretKeys = TRANSLATION_PROVIDER_IDS.map((id) => {
      const secrets = getTranslationProviderFields(id).filter((f) => f.kind === 'secret');
      expect(secrets).toHaveLength(1);
      expect(secrets[0].configKey).toBe('apiKey');
      return secrets[0].settingKey;
    });
    expect(new Set(secretKeys).size).toBe(TRANSLATION_PROVIDER_IDS.length);
    expect(secretKeys).not.toContain('translationApiKey');
  });

  it('buildTranslationProviderConfig reads only the provider\'s own settings keys', () => {
    for (const id of TRANSLATION_PROVIDER_IDS) {
      const asked: string[] = [];
      const config = buildTranslationProviderConfig(id, (key) => {
        asked.push(key);
        return `value-of-${key}`;
      });
      const own = getTranslationProviderFields(id);
      expect(asked.sort()).toEqual(own.map((f) => f.settingKey).sort());
      expect(config).toEqual(Object.fromEntries(own.map((f) => [f.configKey, `value-of-${f.settingKey}`])));
    }
  });

  it('missingRequiredTranslationFields reports blank required fields only', () => {
    expect(missingRequiredTranslationFields('deepl', {}).map((f) => f.settingKey)).toEqual(['translationDeeplApiKey']);
    expect(missingRequiredTranslationFields('deepl', { apiKey: '  ' })).toHaveLength(1);
    expect(missingRequiredTranslationFields('deepl', { apiKey: 'k' })).toEqual([]);
    expect(missingRequiredTranslationFields('google', {}).map((f) => f.settingKey)).toEqual(['translationGoogleApiKey']);
    expect(missingRequiredTranslationFields('libretranslate', {})).toEqual([]);
    expect(missingRequiredTranslationFields('openai', {})).toEqual([]);
  });
});
