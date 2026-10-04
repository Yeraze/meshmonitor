/**
 * Translation provider descriptors (#5518).
 *
 * One pure-data entry per provider names every config field that provider
 * owns. Everything else is derived from this file:
 *
 *   - the settings form (`TranslationConfigSection` renders the active
 *     provider's fields by `kind`);
 *   - the server allowlists (`VALID_SETTINGS_KEYS`, `GLOBAL_ONLY_SETTINGS_KEYS`,
 *     `SECRET_SETTINGS_KEYS` in `src/server/constants/settings.ts`);
 *   - the save-time URL check in `settingsRoutes.ts`;
 *   - the `ProviderConfig` handed to a provider (built from that provider's
 *     fields ONLY, so one provider can never read another's key);
 *   - the required-field check that runs before any request leaves the server.
 *
 * To add a provider: add its id to `TranslationProvider`, add a descriptor
 * here, add its instance in `src/server/services/translation/providers/`, add
 * its label/hint strings to `public/locales/en.json`, and add its setting keys
 * to the `SettingsDraft` type and the `handleSave` literal in
 * `SettingsTab.tsx` (both hand-written; a guard test in
 * `server.settings-persistence.test.ts` fails if they are missed).
 *
 * This file is shared by the browser and the server. Keep it data and pure
 * functions only: no fetch, no database, no React.
 */
import type { TranslationProvider } from './translation.js';

/** How a field is rendered, validated on save, and whether it is a secret. */
export type TranslationFieldKind = 'url' | 'secret' | 'text';

export interface TranslationProviderField {
  /** Settings-table key. Unique across all providers. */
  readonly settingKey: string;
  /** Key under which the provider instance reads the value from its config. */
  readonly configKey: string;
  /**
   * `url`: http(s) URL, checked on save. `secret`: password input, stripped
   * from `GET /api/settings` for non-admins. `text`: plain text.
   */
  readonly kind: TranslationFieldKind;
  /** A blank value is rejected before any request is sent. */
  readonly required: boolean;
  /** DOM id of the input; `data-testid` is `${inputId}-input`. */
  readonly inputId: string;
  /** i18n key (in `public/locales/en.json`) of the field label. */
  readonly labelKey: string;
  /** i18n key of the hint under the input. */
  readonly hintKey?: string;
  /** i18n key of a placeholder that is prose. */
  readonly placeholderKey?: string;
  /** Literal placeholder (a sample URL or key shape; not translated). */
  readonly placeholder?: string;
}

export interface TranslationProviderDescriptor {
  readonly id: TranslationProvider;
  /** i18n key of the provider's name in the provider select. */
  readonly labelKey: string;
  readonly fields: readonly TranslationProviderField[];
}

export const DEFAULT_TRANSLATION_PROVIDER: TranslationProvider = 'libretranslate';

export const TRANSLATION_PROVIDER_DESCRIPTORS = {
  libretranslate: {
    id: 'libretranslate',
    labelKey: 'settings.translation_provider_libretranslate',
    fields: [
      {
        settingKey: 'translationUrl',
        configKey: 'url',
        kind: 'url',
        required: false,
        inputId: 'libretranslate-url',
        labelKey: 'settings.translation_libretranslate_url',
        hintKey: 'settings.translation_libretranslate_url_desc',
        placeholder: 'http://libretranslate:5000',
      },
      {
        settingKey: 'translationLibreTranslateApiKey',
        configKey: 'apiKey',
        kind: 'secret',
        required: false,
        inputId: 'libretranslate-api-key',
        labelKey: 'settings.translation_libretranslate_api_key',
        placeholderKey: 'settings.translation_libretranslate_api_key_placeholder',
      },
    ],
  },
  openai: {
    id: 'openai',
    labelKey: 'settings.translation_provider_openai',
    fields: [
      {
        settingKey: 'translationOpenAiBaseUrl',
        configKey: 'openAiBaseUrl',
        kind: 'url',
        required: false,
        inputId: 'openai-base-url',
        labelKey: 'settings.translation_openai_base_url',
        hintKey: 'settings.translation_openai_base_url_desc',
        placeholder: 'http://host.docker.internal:11434/v1',
      },
      {
        settingKey: 'translationModel',
        configKey: 'model',
        kind: 'text',
        required: false,
        inputId: 'openai-model',
        labelKey: 'settings.translation_model',
        hintKey: 'settings.translation_openai_model_desc',
        placeholder: 'gpt-4o-mini',
      },
      {
        settingKey: 'translationOpenAiApiKey',
        configKey: 'apiKey',
        kind: 'secret',
        required: false,
        inputId: 'openai-api-key',
        labelKey: 'settings.translation_openai_api_key',
        placeholder: 'sk-...',
      },
    ],
  },
  deepl: {
    id: 'deepl',
    labelKey: 'settings.translation_provider_deepl',
    fields: [
      {
        settingKey: 'translationDeeplApiKey',
        configKey: 'apiKey',
        kind: 'secret',
        required: true,
        inputId: 'deepl-api-key',
        labelKey: 'settings.translation_deepl_api_key',
        hintKey: 'settings.translation_deepl_api_key_desc',
        placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx',
      },
      {
        settingKey: 'translationDeeplUrl',
        configKey: 'deeplUrl',
        kind: 'url',
        required: false,
        inputId: 'deepl-url',
        labelKey: 'settings.translation_deepl_url',
        hintKey: 'settings.translation_deepl_url_desc',
        placeholderKey: 'settings.translation_deepl_url_placeholder',
      },
    ],
  },
  google: {
    id: 'google',
    labelKey: 'settings.translation_provider_google',
    fields: [
      {
        settingKey: 'translationGoogleApiKey',
        configKey: 'apiKey',
        kind: 'secret',
        required: true,
        inputId: 'google-api-key',
        labelKey: 'settings.translation_google_api_key',
        hintKey: 'settings.translation_google_api_key_desc',
        placeholder: 'AIzaSy...',
      },
    ],
  },
} as const satisfies Record<TranslationProvider, TranslationProviderDescriptor>;

type Descriptors = typeof TRANSLATION_PROVIDER_DESCRIPTORS;
type AnyField = Descriptors[TranslationProvider]['fields'][number];

/** Every settings key a provider owns, as a literal union. */
export type TranslationProviderSettingKey = AnyField['settingKey'];
/** Every key a provider instance may read from its config. */
export type TranslationProviderConfigKey = AnyField['configKey'];
/** Settings keys of `kind: 'secret'` fields. */
export type TranslationProviderSecretSettingKey = Extract<AnyField, { kind: 'secret' }>['settingKey'];
/** Settings keys of `kind: 'url'` fields. */
export type TranslationProviderUrlSettingKey = Extract<AnyField, { kind: 'url' }>['settingKey'];

/** What a provider instance receives: its own fields, keyed by `configKey`. */
export type TranslationProviderConfig = Partial<Record<TranslationProviderConfigKey, string>>;

/** One string per provider settings key (the settings form's value bag). */
export type TranslationProviderFieldValues = Record<TranslationProviderSettingKey, string>;

export const TRANSLATION_PROVIDER_IDS = Object.keys(TRANSLATION_PROVIDER_DESCRIPTORS) as TranslationProvider[];

const ALL_FIELDS: readonly AnyField[] = TRANSLATION_PROVIDER_IDS.flatMap(
  (id): readonly AnyField[] => TRANSLATION_PROVIDER_DESCRIPTORS[id].fields,
);

/** Every provider-owned settings key. Spread into `VALID_SETTINGS_KEYS`. */
export const TRANSLATION_PROVIDER_SETTING_KEYS: readonly TranslationProviderSettingKey[] =
  ALL_FIELDS.map((f) => f.settingKey);

/** Provider-owned keys that hold a secret. Spread into `SECRET_SETTINGS_KEYS`. */
export const TRANSLATION_PROVIDER_SECRET_SETTING_KEYS: readonly TranslationProviderSecretSettingKey[] =
  ALL_FIELDS.filter((f): f is Extract<AnyField, { kind: 'secret' }> => f.kind === 'secret').map((f) => f.settingKey);

/** Provider-owned keys that hold an http(s) URL, validated on save. */
export const TRANSLATION_PROVIDER_URL_SETTING_KEYS: readonly TranslationProviderUrlSettingKey[] =
  ALL_FIELDS.filter((f): f is Extract<AnyField, { kind: 'url' }> => f.kind === 'url').map((f) => f.settingKey);

export function isTranslationProvider(value: unknown): value is TranslationProvider {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(TRANSLATION_PROVIDER_DESCRIPTORS, value);
}

export function getTranslationProviderFields(provider: TranslationProvider): readonly AnyField[] {
  return TRANSLATION_PROVIDER_DESCRIPTORS[provider].fields;
}

/** A form value bag with every provider field blank. */
export function emptyTranslationProviderFieldValues(): TranslationProviderFieldValues {
  const out = {} as TranslationProviderFieldValues;
  for (const key of TRANSLATION_PROVIDER_SETTING_KEYS) out[key] = '';
  return out;
}

/**
 * Build the config for ONE provider from a lookup by settings key. Only that
 * provider's own fields are read, so another provider's key or URL can never
 * end up in the result. `undefined` from the lookup leaves the field unset.
 */
export function buildTranslationProviderConfig(
  provider: TranslationProvider,
  read: (settingKey: TranslationProviderSettingKey) => string | null | undefined,
): TranslationProviderConfig {
  const config: TranslationProviderConfig = {};
  for (const field of getTranslationProviderFields(provider)) {
    const value = read(field.settingKey);
    if (typeof value === 'string') config[field.configKey] = value;
  }
  return config;
}

/** Required fields of `provider` that are blank in `config`. */
export function missingRequiredTranslationFields(
  provider: TranslationProvider,
  config: TranslationProviderConfig,
): AnyField[] {
  return getTranslationProviderFields(provider).filter(
    (field) => field.required && !(config[field.configKey] ?? '').trim(),
  );
}

/**
 * A provider config that lacks a required field. The server throws it before
 * any request leaves it. `missingFields` holds the settings keys.
 */
export class TranslationConfigError extends Error {
  readonly missingFields: TranslationProviderSettingKey[];

  constructor(provider: TranslationProvider, missingFields: TranslationProviderSettingKey[]) {
    super(`Translation provider "${provider}" is missing required setting(s): ${missingFields.join(', ')}`);
    this.name = 'TranslationConfigError';
    this.missingFields = missingFields;
  }
}
