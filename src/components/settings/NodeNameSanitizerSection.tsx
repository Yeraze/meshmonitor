/**
 * NodeNameSanitizerSection — node-name anti-spam (#6382), in Global
 * Settings → Security. Admin only.
 *
 * When on, MeshMonitor replaces invite links in node names (Telegram,
 * Discord, WhatsApp, any URL, plus admin patterns) with a placeholder before
 * the name is stored. Self-saving through the shared save bar, like
 * ReliablePkiSection. The re-scan button cleans names already stored.
 * Sends nothing on air.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { logger } from '../../utils/logger';
import { UiIcon } from '../icons';
import {
  BUILTIN_SPAM_HOSTS,
  DEFAULT_NODE_NAME_PLACEHOLDER,
  NODE_NAME_SANITIZE_BUILTINS,
  NODE_NAME_SANITIZE_CUSTOM_PATTERNS,
  NODE_NAME_SANITIZE_ENABLED,
  NODE_NAME_SANITIZE_PLACEHOLDER,
  parseCustomPatternList,
} from '../../utils/nodeNameSanitizerConstants';
import styles from './NodeNameSanitizerSection.module.css';

interface Draft {
  enabled: boolean;
  builtins: boolean;
  patterns: string;
  placeholder: string;
}

interface Status {
  active: boolean;
  hits: { total: number; meshtastic: number; meshcore: number; lastHitAt: number | null };
}

interface RescanResult {
  scanned: number;
  nodesChanged: number;
  meshcoreNodesChanged: number;
}

const EMPTY: Draft = { enabled: false, builtins: true, patterns: '', placeholder: '' };

function fromSettings(s: Record<string, unknown> | null | undefined): Draft {
  const raw = (k: string) => (s?.[k] === undefined || s?.[k] === null ? '' : String(s[k]));
  return {
    enabled: raw(NODE_NAME_SANITIZE_ENABLED) === 'true',
    builtins: raw(NODE_NAME_SANITIZE_BUILTINS) !== 'false',
    patterns: parseCustomPatternList(raw(NODE_NAME_SANITIZE_CUSTOM_PATTERNS)).join('\n'),
    placeholder: raw(NODE_NAME_SANITIZE_PLACEHOLDER),
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return a.enabled === b.enabled && a.builtins === b.builtins
    && a.patterns === b.patterns && a.placeholder === b.placeholder;
}

export const NodeNameSanitizerSection: React.FC = () => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { authStatus } = useAuth();
  const isAdmin = authStatus?.user?.isAdmin ?? false;

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [initial, setInitial] = useState<Draft>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [rescanResult, setRescanResult] = useState<RescanResult | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await apiService.get<{ data?: Status }>('/api/node-name-sanitizer/status');
      setStatus(res?.data ?? null);
    } catch (error) {
      if (!(error instanceof ApiError)) logger.error('Failed to load node-name anti-spam status:', error);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await apiService.get<Record<string, unknown>>('/api/settings');
        if (cancelled) return;
        const d = fromSettings(settings);
        setDraft(d);
        setInitial(d);
      } catch (error) {
        if (!(error instanceof ApiError)) logger.error('Failed to load node-name anti-spam settings:', error);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    void loadStatus();
    return () => { cancelled = true; };
  }, [isAdmin, loadStatus]);

  const hasChanges = loaded && !sameDraft(draft, initial);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const patterns = draft.patterns.split('\n').map((p) => p.trim()).filter(Boolean);
      await apiService.post('/api/settings', {
        [NODE_NAME_SANITIZE_ENABLED]: draft.enabled ? 'true' : 'false',
        [NODE_NAME_SANITIZE_BUILTINS]: draft.builtins ? 'true' : 'false',
        [NODE_NAME_SANITIZE_CUSTOM_PATTERNS]: JSON.stringify(patterns),
        [NODE_NAME_SANITIZE_PLACEHOLDER]: draft.placeholder.trim(),
      });
      const saved = { ...draft, patterns: patterns.join('\n'), placeholder: draft.placeholder.trim() };
      setDraft(saved);
      setInitial(saved);
      showToast(t('settings.node_name_sanitizer.saved', 'Node name anti-spam settings saved'), 'success');
      void loadStatus();
    } catch (error) {
      logger.error('Failed to save node-name anti-spam settings:', error);
      const detail = error instanceof ApiError ? error.message : '';
      showToast(
        t('settings.node_name_sanitizer.save_failed', 'Failed to save node name anti-spam settings') + (detail ? `: ${detail}` : ''),
        'error',
      );
    } finally {
      setIsSaving(false);
    }
  }, [draft, showToast, t, loadStatus]);

  const handleDismiss = useCallback(() => setDraft(initial), [initial]);

  useSaveBar({
    id: 'node-name-sanitizer',
    sectionName: t('settings.node_name_sanitizer.title', 'Node name anti-spam'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const handleRescan = useCallback(async () => {
    setRescanning(true);
    setRescanResult(null);
    try {
      const res = await apiService.post<{ data?: RescanResult }>('/api/node-name-sanitizer/rescan', {});
      const result = res?.data ?? null;
      setRescanResult(result);
      if (result) {
        showToast(t('settings.node_name_sanitizer.rescan_done', {
          n: result.nodesChanged + result.meshcoreNodesChanged,
          defaultValue: 'Re-scan finished: {{n}} name(s) changed',
        }), 'success');
      }
      void loadStatus();
    } catch (error) {
      logger.error('Node-name re-scan failed:', error);
      const detail = error instanceof ApiError ? error.message : '';
      showToast(
        t('settings.node_name_sanitizer.rescan_failed', 'Re-scan failed') + (detail ? `: ${detail}` : ''),
        'error',
      );
    } finally {
      setRescanning(false);
    }
  }, [showToast, t, loadStatus]);

  if (!isAdmin) return null;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const canRescan = loaded && initial.enabled && !hasChanges && !rescanning;

  return (
    <div className={styles.section} data-testid="node-name-sanitizer">
      <h4 className={styles.heading}>
        <UiIcon name="filter" size={16} />
        <span>{t('settings.node_name_sanitizer.title', 'Node name anti-spam')}</span>
      </h4>
      <p className={styles.description}>
        {t(
          'settings.node_name_sanitizer.description',
          'Replace links in node names with a placeholder before they are stored, so "Name t.me/spam" becomes "Name [spammer]". Applies to every source, including MQTT. Your own nodes are never changed. Old names are not kept, so turning this off does not bring them back.',
        )}
      </p>

      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={!loaded}
          onChange={(e) => set('enabled', e.target.checked)}
          data-testid="node-name-sanitizer-enabled"
        />
        <span>{t('settings.node_name_sanitizer.enabled', 'Remove links from node names')}</span>
      </label>

      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={draft.builtins}
          disabled={!loaded || !draft.enabled}
          onChange={(e) => set('builtins', e.target.checked)}
        />
        <span>
          {t('settings.node_name_sanitizer.builtins', {
            hosts: BUILTIN_SPAM_HOSTS.join(', '),
            defaultValue: 'Built-in rules: any http(s):// link, plus {{hosts}}',
          })}
        </span>
      </label>

      <label className={styles.field} htmlFor="nodeNameSanitizePatterns">
        <span>{t('settings.node_name_sanitizer.patterns_label', 'Extra hosts or patterns (one per line)')}</span>
        <textarea
          id="nodeNameSanitizePatterns"
          className={styles.textarea}
          rows={4}
          value={draft.patterns}
          disabled={!loaded || !draft.enabled}
          placeholder={'spam.example\nbit\\.ly/\\S*'}
          onChange={(e) => set('patterns', e.target.value)}
          data-testid="node-name-sanitizer-patterns"
        />
        <span className={styles.hint}>
          {t(
            'settings.node_name_sanitizer.patterns_hint',
            'A plain host such as spam.example matches spam.example/anything. Anything else is a regular expression (RE2 syntax, case-insensitive, at most 256 characters).',
          )}
        </span>
      </label>

      <label className={styles.field} htmlFor="nodeNameSanitizePlaceholder">
        <span>{t('settings.node_name_sanitizer.placeholder_label', 'Placeholder')}</span>
        <input
          id="nodeNameSanitizePlaceholder"
          type="text"
          className={styles.input}
          value={draft.placeholder}
          maxLength={24}
          disabled={!loaded || !draft.enabled}
          placeholder={DEFAULT_NODE_NAME_PLACEHOLDER}
          onChange={(e) => set('placeholder', e.target.value)}
        />
      </label>

      <div className={styles.footer}>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void handleRescan()}
          disabled={!canRescan}
          data-testid="node-name-sanitizer-rescan"
        >
          <UiIcon name="refresh" size={14} />
          <span>
            {rescanning
              ? t('settings.node_name_sanitizer.rescanning', 'Re-scanning…')
              : t('settings.node_name_sanitizer.rescan', 'Re-scan existing node names')}
          </span>
        </button>
        {status && (
          <span className={styles.hint} data-testid="node-name-sanitizer-hits">
            {t('settings.node_name_sanitizer.hits', {
              n: status.hits.total,
              defaultValue: 'Names rewritten since the server started: {{n}}',
            })}
          </span>
        )}
      </div>
      {rescanResult && (
        <p className={styles.hint} data-testid="node-name-sanitizer-rescan-result">
          {t('settings.node_name_sanitizer.rescan_result', {
            scanned: rescanResult.scanned,
            meshtastic: rescanResult.nodesChanged,
            meshcore: rescanResult.meshcoreNodesChanged,
            defaultValue: 'Scanned {{scanned}} rows: {{meshtastic}} Meshtastic and {{meshcore}} MeshCore names changed.',
          })}
        </p>
      )}
    </div>
  );
};

export default NodeNameSanitizerSection;
