import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';

interface SecurityDigestCardProps {
  sourceId: string | null | undefined;
}

/**
 * Daily Apprise digest settings for one source (#6281). The four per-source keys
 * save with `?sourceId=` and load through the same query (which also shows a
 * global value as the default); the enable switch and send time are global, as
 * the scheduler is.
 */
export const SecurityDigestCard: React.FC<SecurityDigestCardProps> = ({ sourceId }) => {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [appriseUrl, setAppriseUrl] = useState('');
  const [time, setTime] = useState('06:00');
  const [reportType, setReportType] = useState<'summary' | 'detailed'>('summary');
  const [suppressEmpty, setSuppressEmpty] = useState(true);
  const [format, setFormat] = useState<'text' | 'markdown'>('text');
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const q = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
        const settings = await api.get<Record<string, string>>(`/api/settings${q}`);
        if (cancelled) return;
        setEnabled(settings.securityDigestEnabled === 'true');
        setAppriseUrl(settings.securityDigestAppriseUrl || '');
        setTime(settings.securityDigestTime || '06:00');
        setReportType((settings.securityDigestReportType as 'summary' | 'detailed') || 'summary');
        setSuppressEmpty(settings.securityDigestSuppressEmpty !== 'false');
        setFormat((settings.securityDigestFormat as 'text' | 'markdown') || 'text');
      } catch {
        // Settings may not exist yet, use defaults
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [sourceId]);

  const save = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      // The four digest keys that belong to one source; the service falls back to the global row for each.
      const perSource = {
        securityDigestAppriseUrl: appriseUrl,
        securityDigestReportType: reportType,
        securityDigestSuppressEmpty: String(suppressEmpty),
        securityDigestFormat: format,
      };
      const q = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
      await api.post(`/api/settings${q}`, perSource);
      await api.post('/api/settings', {
        securityDigestEnabled: String(enabled),
        securityDigestTime: time,
      });
      setMessage({ type: 'success', text: t('common.saved', 'Settings saved') });
    } catch {
      setMessage({ type: 'error', text: t('common.save_failed', 'Failed to save settings') });
    } finally {
      setSaving(false);
    }
  }, [sourceId, appriseUrl, reportType, suppressEmpty, format, enabled, time, t]);

  const sendNow = useCallback(async () => {
    setSending(true);
    setMessage(null);
    try {
      const result = await api.post<{ success: boolean; skipped?: boolean; message: string }>(
        '/api/security/digest/send',
        sourceId ? { sourceId } : {},
      );
      if (result.skipped) {
        setMessage({ type: 'success', text: t('security.digest_skipped', 'Skipped: no Apprise URL is set for this source.') });
      } else {
        setMessage({ type: result.success ? 'success' : 'error', text: result.message });
      }
    } catch {
      setMessage({ type: 'error', text: t('common.failed', 'Failed to send digest') });
    } finally {
      setSending(false);
    }
  }, [sourceId, t]);

  return (
    <div className="issues-section digest-section">
      <h3>{t('security.digest_title', 'Security Digest')}</h3>
      <p className="section-description">
        {t('security.digest_description', 'Schedule a daily security report delivered via Apprise.')}
      </p>
      <div className="digest-controls">
        <div className="digest-row">
          <label className="digest-label">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            {t('security.digest_enabled', 'Enable daily digest')}
          </label>
        </div>
        <div className="digest-row">
          <label className="digest-label">{t('security.digest_apprise_url', 'Apprise URL')}</label>
          <input
            type="text"
            className="digest-input"
            value={appriseUrl}
            onChange={e => setAppriseUrl(e.target.value)}
            placeholder="discord://webhook_id/webhook_token"
          />
        </div>
        <div className="digest-row">
          <label className="digest-label">{t('security.digest_time', 'Send at')}</label>
          <input
            type="time"
            className="digest-input digest-time"
            value={time}
            onChange={e => setTime(e.target.value)}
          />
        </div>
        <div className="digest-row">
          <label className="digest-label">{t('security.digest_report_type', 'Report type')}</label>
          <select
            className="digest-input digest-select"
            value={reportType}
            onChange={e => setReportType(e.target.value as 'summary' | 'detailed')}
          >
            <option value="summary">{t('security.digest_summary', 'Summary')}</option>
            <option value="detailed">{t('security.digest_detailed', 'Detailed')}</option>
          </select>
        </div>
        <div className="digest-row">
          <label className="digest-label">{t('security.digest_format', 'Format')}</label>
          <select
            className="digest-input digest-select"
            value={format}
            onChange={e => setFormat(e.target.value as 'text' | 'markdown')}
          >
            <option value="text">{t('security.digest_format_text', 'Plain Text')}</option>
            <option value="markdown">{t('security.digest_format_markdown', 'Markdown')}</option>
          </select>
        </div>
        <div className="digest-row">
          <label className="digest-label">
            <input type="checkbox" checked={suppressEmpty} onChange={e => setSuppressEmpty(e.target.checked)} />
            {t('security.digest_suppress_empty', 'Suppress when no issues')}
          </label>
        </div>
        <div className="digest-actions">
          <button className="digest-save-btn" onClick={save} disabled={saving}>
            {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
          </button>
          <button className="digest-send-btn" onClick={sendNow} disabled={sending || !appriseUrl}>
            {sending ? t('common.sending', 'Sending...') : t('security.digest_send_now', 'Send Now')}
          </button>
        </div>
        {message && <div className={`digest-message ${message.type}`}>{message.text}</div>}
      </div>
    </div>
  );
};
