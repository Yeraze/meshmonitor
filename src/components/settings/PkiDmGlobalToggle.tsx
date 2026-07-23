/**
 * PkiDmGlobalToggle — the global master switch for PKI direct-message
 * decryption (issue #3441), shown in the global Settings → Security section.
 *
 * This is the instance-wide kill switch: while OFF (the default), no source
 * decrypts PKI DMs, the per-source toggles are inert, and turning it off forgets
 * every stored private key. Self-contained: reads/writes the global
 * `pkiDmDecryptionGloballyEnabled` setting directly via /api/settings.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import apiService from '../../services/api';

const PkiDmGlobalToggle: React.FC = () => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiService.get<Record<string, unknown>>('/api/settings');
        if (!cancelled) setEnabled(String(data?.pkiDmDecryptionGloballyEnabled) === 'true');
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onToggle = useCallback(async (next: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const baseUrl = await apiService.getBaseUrl();
      const res = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pkiDmDecryptionGloballyEnabled: next ? 'true' : 'false' }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      setEnabled(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [csrfFetch]);

  if (enabled === null) return null;

  return (
    <div className="settings-field" id="settings-pki-dm">
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => void onToggle(e.target.checked)}
        />
        <span>{t('settings.pki_dm.enable', 'Enable PKI direct message decryption')}</span>
      </label>
      <p className="settings-description">
        {t(
          'settings.pki_dm.description',
          'Master switch for decrypting PKI-encrypted direct messages server-side so they appear in the unified Messages view. Off by default. When on, you can enable it per source under that source\'s Configuration tab (which stores that node\'s private key, encrypted). Turning this off forgets every stored key and stops all decryption. Requires SESSION_SECRET to be configured.',
        )}
      </p>
      {error && <div className="settings-error" role="alert">{error}</div>}
    </div>
  );
};

export default PkiDmGlobalToggle;
