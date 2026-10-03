import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { type TranslationProvider, STANDARD_LANGUAGES } from '../../types/translation';
import { UiIcon } from '../icons/index';
import styles from './TranslationConfigSection.module.css';

export interface TranslationConfigSectionProps {
  enabled: boolean;
  onEnabledChange: (val: boolean) => void;
  provider: TranslationProvider;
  onProviderChange: (val: TranslationProvider) => void;
  url: string;
  onUrlChange: (val: string) => void;
  deeplUrl?: string;
  onDeeplUrlChange?: (val: string) => void;
  apiKey: string;
  onApiKeyChange: (val: string) => void;
  model: string;
  onModelChange: (val: string) => void;
  openAiBaseUrl: string;
  onOpenAiBaseUrlChange: (val: string) => void;
  defaultLanguage: string;
  onDefaultLanguageChange: (val: string) => void;
  defaultOutgoingLanguage: string;
  onDefaultOutgoingLanguageChange: (val: string) => void;
}

export const TranslationConfigSection: React.FC<TranslationConfigSectionProps> = ({
  enabled,
  onEnabledChange,
  provider,
  onProviderChange,
  url,
  onUrlChange,
  deeplUrl = '',
  onDeeplUrlChange,
  apiKey,
  onApiKeyChange,
  model,
  onModelChange,
  openAiBaseUrl,
  onOpenAiBaseUrlChange,
  defaultLanguage,
  onDefaultLanguageChange,
  defaultOutgoingLanguage,
  onDefaultOutgoingLanguageChange,
}) => {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      const res = await apiService.testTranslationConfig({
        provider,
        url,
        deeplUrl,
        apiKey,
        model,
        openAiBaseUrl,
        targetLanguage: defaultOutgoingLanguage || 'ja',
        sourceLanguage: defaultLanguage || 'en',
      });

      setTestResult({
        success: true,
        message: `Success! Sample translation: "${res.translatedText}"`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestResult({
        success: false,
        message: msg || 'Translation test failed. Check settings and API key.',
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
                <option value="libretranslate">LibreTranslate (Local / Self-Hosted / Cloud)</option>
                <option value="openai">OpenAI-Compatible (Ollama, OpenRouter, OpenAI, vLLM)</option>
                <option value="deepl">DeepL API (Free / Pro)</option>
                <option value="google">Google Cloud Translation</option>
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

            {provider === 'libretranslate' && (
              <>
                <div className={styles.formGroup}>
                  <label htmlFor="libretranslate-url">{t('settings.translation_url', 'LibreTranslate URL')}</label>
                  <input
                    id="libretranslate-url"
                    type="text"
                    value={url}
                    onChange={(e) => onUrlChange(e.target.value)}
                    placeholder="http://libretranslate:5000"
                    className={styles.input}
                    data-testid="libretranslate-url-input"
                  />
                  <span className={styles.hint}>
                    {t('settings.translation_libretranslate_url_desc', 'URL of your LibreTranslate instance (e.g. http://localhost:5000 or http://libretranslate:5000 in Docker), or leave blank to use the default (http://libretranslate:5000).')}
                  </span>
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="libretranslate-api-key">{t('settings.translation_api_key', 'API Key (Optional)')}</label>
                  <input
                    id="libretranslate-api-key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => onApiKeyChange(e.target.value)}
                    placeholder="Leave empty if your server does not require a key"
                    className={styles.input}
                    autoComplete="off"
                    data-testid="libretranslate-api-key-input"
                  />
                </div>
              </>
            )}

            {provider === 'openai' && (
              <>
                <div className={styles.formGroup}>
                  <label htmlFor="openai-base-url">{t('settings.translation_openai_base_url', 'OpenAI Base URL')}</label>
                  <input
                    id="openai-base-url"
                    type="text"
                    value={openAiBaseUrl}
                    onChange={(e) => onOpenAiBaseUrlChange(e.target.value)}
                    placeholder="http://host.docker.internal:11434/v1/chat/completions"
                    className={styles.input}
                    data-testid="openai-base-url-input"
                  />
                  <span className={styles.hint}>
                    {t('settings.translation_openai_base_url_desc', 'Enter the Ollama, OpenRouter, or OpenAI URL, or leave blank to use the default (http://host.docker.internal:11434/v1/chat/completions).')}
                  </span>
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="openai-model">{t('settings.translation_model', 'Model Name')}</label>
                  <input
                    id="openai-model"
                    type="text"
                    value={model}
                    onChange={(e) => onModelChange(e.target.value)}
                    placeholder="gpt-4o-mini or llama3 or qwen2.5"
                    className={styles.input}
                    data-testid="openai-model-input"
                  />
                  <span className={styles.hint}>
                    {t('settings.translation_openai_model_desc', "The model identifier on your server (e.g. 'llama3.2', 'qwen2.5', or 'gpt-4o-mini').")}
                  </span>
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="openai-api-key">{t('settings.translation_api_key', 'API Key (Optional for local Ollama)')}</label>
                  <input
                    id="openai-api-key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => onApiKeyChange(e.target.value)}
                    placeholder="sk-..."
                    className={styles.input}
                    autoComplete="off"
                    data-testid="openai-api-key-input"
                  />
                </div>
              </>
            )}

            {provider === 'deepl' && (
              <>
                <div className={styles.formGroup}>
                  <label htmlFor="deepl-api-key">{t('settings.translation_api_key', 'DeepL Auth Key')}</label>
                  <input
                    id="deepl-api-key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => onApiKeyChange(e.target.value)}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx"
                    className={styles.input}
                    autoComplete="off"
                    data-testid="deepl-api-key-input"
                  />
                  <span className={styles.hint}>
                    {t('settings.deepl_api_key_hint', 'Keys ending in :fx will automatically use the DeepL Free API endpoint.')}
                  </span>
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="deepl-url">{t('settings.translation_deepl_url', 'Custom DeepL Base URL (Optional)')}</label>
                  <input
                    id="deepl-url"
                    type="text"
                    value={deeplUrl}
                    onChange={(e) => onDeeplUrlChange && onDeeplUrlChange(e.target.value)}
                    placeholder={t('settings.translation_deepl_url_placeholder', 'Leave empty for automatic endpoint selection')}
                    className={styles.input}
                    data-testid="deepl-url-input"
                  />
                  <span className={styles.hint}>
                    {t('settings.translation_deepl_url_desc', 'Most users should leave this blank to automatically route based on your auth key (DeepL Free vs. Pro). Only enter a URL if using a custom reverse proxy or enterprise gateway.')}
                  </span>
                </div>
              </>
            )}

            {provider === 'google' && (
              <div className={styles.formGroup}>
                <label htmlFor="google-api-key">{t('settings.translation_api_key', 'Google Cloud Translation API Key')}</label>
                <input
                  id="google-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => onApiKeyChange(e.target.value)}
                  placeholder="AIzaSy..."
                  className={styles.input}
                  autoComplete="off"
                  data-testid="google-api-key-input"
                />
                <span className={styles.hint}>
                  {t('settings.translation_google_api_key_desc', 'API key from your Google Cloud Console with Cloud Translation API enabled.')}
                </span>
              </div>
            )}

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
