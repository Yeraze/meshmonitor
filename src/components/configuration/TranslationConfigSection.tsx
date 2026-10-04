import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { type TranslationProvider, STANDARD_LANGUAGES } from '../../types/translation';
import {
  TRANSLATION_PROVIDER_DESCRIPTORS,
  TRANSLATION_PROVIDER_IDS,
  buildTranslationProviderConfig,
  getTranslationProviderFields,
  missingRequiredTranslationFields,
  type TranslationProviderFieldValues,
  type TranslationProviderSettingKey,
} from '../../types/translationProviders';
import { UiIcon } from '../icons/index';
import styles from './TranslationConfigSection.module.css';

export interface TranslationConfigSectionProps {
  enabled: boolean;
  onEnabledChange: (val: boolean) => void;
  provider: TranslationProvider;
  onProviderChange: (val: TranslationProvider) => void;
  /** One value per provider settings key (every provider, not just the active one). */
  values: TranslationProviderFieldValues;
  /** `key` is the settings key of the edited field. */
  onFieldChange: (key: TranslationProviderSettingKey, value: string) => void;
  defaultLanguage: string;
  onDefaultLanguageChange: (val: string) => void;
  defaultOutgoingLanguage: string;
  onDefaultOutgoingLanguageChange: (val: string) => void;
}

/**
 * Message Translation settings. The provider list and each provider's inputs
 * are rendered from the provider descriptors
 * (`src/types/translationProviders.ts`, #5518): only the active provider's
 * fields are shown, and each field reads and writes its own settings key.
 */
export const TranslationConfigSection: React.FC<TranslationConfigSectionProps> = ({
  enabled,
  onEnabledChange,
  provider,
  onProviderChange,
  values,
  onFieldChange,
  defaultLanguage,
  onDefaultLanguageChange,
  defaultOutgoingLanguage,
  onDefaultOutgoingLanguageChange,
}) => {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const fields = getTranslationProviderFields(provider);

  const handleTest = async () => {
    setTestResult(null);

    // The active provider's fields only, under the names the provider reads.
    const providerConfig = buildTranslationProviderConfig(provider, (key) => values[key] ?? '');
    const missing = missingRequiredTranslationFields(provider, providerConfig);
    if (missing.length > 0) {
      setTestResult({
        success: false,
        message: t('settings.translation_required_field', '{{field}} is required', {
          field: t(missing[0].labelKey),
        }),
      });
      return;
    }

    setTesting(true);
    try {
      const res = await apiService.testTranslationConfig({
        provider,
        ...providerConfig,
        targetLanguage: defaultOutgoingLanguage || 'ja',
        sourceLanguage: defaultLanguage || 'en',
      });

      setTestResult({
        success: true,
        message: t('settings.translation_test_sample', 'Success! Sample translation: "{{text}}"', {
          text: res.translatedText,
        }),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestResult({
        success: false,
        message: msg || t('settings.translation_test_failed_generic', 'Translation test failed. Check settings and API key.'),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div id="settings-translation" className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            style={{ cursor: 'pointer' }}
            data-testid="translation-enabled-toggle"
          />
          <span>{t('settings.translation_enabled', 'Enable Message Translation')}</span>
        </label>
      </h3>
      <p className="setting-description">
        {t(
          'settings.translation_section_desc',
          'Configure inline on-demand translation for mesh and direct messages. When enabled, translation actions are shown on incoming and outgoing chat messages.'
        )}
      </p>

      {enabled && (
        <div className={styles.container} style={{ marginTop: '1rem' }}>
          <div className={styles.formGroup}>
            <label htmlFor="translation-provider">{t('settings.translation_provider', 'Translation Provider')}</label>
              <select
                id="translation-provider"
                value={provider}
                onChange={(e) => onProviderChange(e.target.value as TranslationProvider)}
                className={styles.select}
                data-testid="translation-provider-select"
              >
                {TRANSLATION_PROVIDER_IDS.map((id) => (
                  <option key={id} value={id}>
                    {t(TRANSLATION_PROVIDER_DESCRIPTORS[id].labelKey)}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.formGroup}>
              <label htmlFor="translation-default-language">{t('settings.translation_default_lang', 'Primary / Local Language (Incoming messages)')}</label>
              <select
                id="translation-default-language"
                value={defaultLanguage || 'en'}
                onChange={(e) => onDefaultLanguageChange(e.target.value)}
                className={styles.select}
                data-testid="translation-default-lang-select"
              >
                {STANDARD_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.name} ({lang.code})
                  </option>
                ))}
              </select>
              <span className={styles.hint}>
                {t('settings.translation_default_lang_desc', 'Your language. Incoming foreign messages will be translated into this language.')}
              </span>
            </div>

            <div className={styles.formGroup}>
              <label htmlFor="translation-outgoing-language">{t('settings.translation_default_outgoing_lang', 'Default Foreign Language (Outgoing composer)')}</label>
              <select
                id="translation-outgoing-language"
                value={defaultOutgoingLanguage || 'ja'}
                onChange={(e) => onDefaultOutgoingLanguageChange(e.target.value)}
                className={styles.select}
                data-testid="translation-outgoing-lang-select"
              >
                {STANDARD_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.name} ({lang.code})
                  </option>
                ))}
              </select>
              <span className={styles.hint}>
                {t('settings.translation_default_outgoing_lang_desc', 'When translating an outgoing message in the composer, this language will be selected by default.')}
              </span>
            </div>

            {fields.map((field) => (
              <div className={styles.formGroup} key={field.settingKey}>
                <label htmlFor={field.inputId}>
                  {t(field.labelKey)}
                  {field.required && <span aria-hidden="true"> *</span>}
                </label>
                <input
                  id={field.inputId}
                  type={field.kind === 'secret' ? 'password' : 'text'}
                  value={values[field.settingKey] ?? ''}
                  onChange={(e) => onFieldChange(field.settingKey, e.target.value)}
                  placeholder={'placeholderKey' in field ? t(field.placeholderKey) : field.placeholder}
                  className={styles.input}
                  autoComplete={field.kind === 'secret' ? 'off' : undefined}
                  aria-required={field.required}
                  data-testid={`${field.inputId}-input`}
                />
                {'hintKey' in field && <span className={styles.hint}>{t(field.hintKey)}</span>}
              </div>
            ))}

            <div className={styles.testRow}>
              <button
                type="button"
                onClick={handleTest}
                disabled={testing}
                className={styles.testButton}
                data-testid="translation-test-button"
              >
                <UiIcon name="translate" size={15} />
                {testing ? t('settings.translation_testing', 'Testing...') : t('settings.translation_test_btn', 'Test Connection')}
              </button>
              {testResult && (
                <span className={testResult.success ? styles.testSuccess : styles.testError}>
                  {testResult.message}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    );
};
