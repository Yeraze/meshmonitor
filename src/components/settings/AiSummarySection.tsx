/**
 * AiSummarySection — the OpenAI-compatible endpoint the Automation Engine's
 * "Summarize channels" step calls (#6566). Global Settings page, admins only.
 *
 * All three keys are admin-only on the server (ADMIN_ONLY_SETTINGS_KEYS);
 * `ai_summary_api_token` is also hidden from non-admins on read by its
 * `_token` suffix. Self-contained like DefaultMeshtasticSourceSection: its
 * own load, its own save bar, the unscoped `POST /api/settings`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { useToast } from '../ToastContainer';
import { useSaveBar } from '../../hooks/useSaveBar';
import { logger } from '../../utils/logger';
import { UiIcon } from '../icons';
import styles from './AiSummarySection.module.css';

export const AI_SUMMARY_SECTION_ID = 'settings-ai-summary';

const KEYS = { baseUrl: 'aiSummaryBaseUrl', model: 'aiSummaryModel', apiKey: 'ai_summary_api_token' } as const;
type Values = Record<keyof typeof KEYS, string>;
const EMPTY: Values = { baseUrl: '', model: '', apiKey: '' };

export const AiSummarySection: React.FC = () => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [values, setValues] = useState<Values>(EMPTY);
  const [initial, setInitial] = useState<Values>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await apiService.get<Record<string, string>>('/api/settings');
        if (cancelled) return;
        const read = (k: string) => (typeof settings?.[k] === 'string' ? settings[k].trim() : '');
        const stored = { baseUrl: read(KEYS.baseUrl), model: read(KEYS.model), apiKey: read(KEYS.apiKey) };
        setValues(stored);
        setInitial(stored);
      } catch (error) {
        if (!(error instanceof ApiError)) logger.error('Failed to load AI summary settings:', error);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const hasChanges = loaded && (Object.keys(KEYS) as Array<keyof Values>).some((k) => values[k] !== initial[k]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const trimmed = { baseUrl: values.baseUrl.trim(), model: values.model.trim(), apiKey: values.apiKey.trim() };
      await apiService.post('/api/settings', {
        [KEYS.baseUrl]: trimmed.baseUrl,
        [KEYS.model]: trimmed.model,
        [KEYS.apiKey]: trimmed.apiKey,
      });
      setValues(trimmed);
      setInitial(trimmed);
      showToast(t('settings.ai_summary.saved', 'AI summary settings saved'), 'success');
    } catch (error) {
      logger.error('Failed to save AI summary settings:', error);
      showToast(t('settings.ai_summary.save_failed', 'Failed to save AI summary settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [values, showToast, t]);

  const handleDismiss = useCallback(() => setValues(initial), [initial]);

  useSaveBar({
    id: 'ai-summary',
    sectionName: t('settings.ai_summary.title', 'AI channel summaries'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const field = (key: keyof Values, label: string, placeholder: string, type = 'text') => (
    <div className={styles.field}>
      <label htmlFor={`ai-summary-${key}`}>{label}</label>
      <input
        id={`ai-summary-${key}`}
        className={styles.input}
        type={type}
        value={values[key]}
        placeholder={placeholder}
        disabled={!loaded}
        autoComplete="off"
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
      />
    </div>
  );

  return (
    <div id={AI_SUMMARY_SECTION_ID} className="settings-section" data-testid="ai-summary-section">
      <h3 className={styles.heading}>
        <UiIcon name="sparkles" size={16} />
        <span>{t('settings.ai_summary.title', 'AI channel summaries')}</span>
      </h3>
      <p className={styles.description}>
        {t(
          'settings.ai_summary.description',
          'The AI endpoint used by the "Summarize channels" automation step. Any OpenAI-compatible chat endpoint works: OpenAI, or a local model through Ollama, LM Studio or vLLM. Leave the URL blank for OpenAI.',
        )}
      </p>
      <p className={styles.warning} data-testid="ai-summary-privacy">
        <UiIcon name="alert" size={14} />
        <span>
          {t(
            'settings.ai_summary.privacy',
            'Each summary sends the chosen channels’ messages, with sender names, to this endpoint. Use a local model if they must stay on your network.',
          )}
        </span>
      </p>
      {field('baseUrl', t('settings.ai_summary.base_url', 'Base URL'), 'https://api.openai.com/v1')}
      {field('model', t('settings.ai_summary.model', 'Model'), 'gpt-4o-mini')}
      {field('apiKey', t('settings.ai_summary.api_key', 'API key'), t('settings.ai_summary.api_key_placeholder', 'Blank for a local model'), 'password')}
    </div>
  );
};

export default AiSummarySection;
