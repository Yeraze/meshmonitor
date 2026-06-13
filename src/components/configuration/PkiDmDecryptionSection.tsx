/**
 * PkiDmDecryptionSection — per-source opt-in for server-side PKI direct-message
 * decryption (issue #3441). When enabled, MeshMonitor extracts the source's
 * local-node X25519 private key from the device and stores it encrypted, then
 * decrypts PKI DMs addressed to that node (including ones relayed still-encrypted
 * via MQTT) so they appear in the unified Messages view.
 *
 * Gated server-side by the per-source `configuration` permission. Talks to
 * GET/POST /api/sources/:id/pki-dm.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSource } from '../../contexts/SourceContext';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import apiService from '../../services/api';

interface PkiDmStatus {
  enabled: boolean;
  keyStored: boolean;
  canStore: boolean;
  reason?: string | null;
}

const PkiDmDecryptionSection: React.FC = () => {
  const { t } = useTranslation();
  const { sourceId } = useSource();
  const csrfFetch = useCsrfFetch();

  const [status, setStatus] = useState<PkiDmStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sourceId) return;
    try {
      const baseUrl = await apiService.getBaseUrl();
      const res = await csrfFetch(`${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/pki-dm/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
      setError(null);
    } catch (_e) {
      // A 403 here just means the user lacks configuration permission on this
      // source; render nothing rather than an error.
      setStatus(null);
    }
  }, [sourceId, csrfFetch]);

  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(async (enabled: boolean) => {
    if (!sourceId) return;
    setLoading(true);
    setError(null);
    try {
      const baseUrl = await apiService.getBaseUrl();
      const res = await csrfFetch(`${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/pki-dm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sourceId, csrfFetch, load]);

  // Only Meshtastic sources have a status (the endpoint 400s for MeshCore); if
  // we never got one, don't render the section.
  if (!sourceId || !status) return null;

  return (
    <div className="config-section" id="config-pki-dm">
      <h3>{t('config.pki_dm.title', '🔓 PKI Direct Message Decryption')}</h3>
      <p className="config-description">
        {t(
          'config.pki_dm.description',
          'Decrypt PKI-encrypted direct messages addressed to this node — including ones relayed still-encrypted via MQTT — so they appear in the unified Messages view. MeshMonitor stores this node\'s private key, encrypted at rest. Only enable on sources you trust this server with.',
        )}
      </p>

      {!status.canStore && (
        <div className="config-warning" role="alert">
          {status.reason || t('config.pki_dm.no_secret', 'SESSION_SECRET is not configured, so keys cannot be stored persistently.')}
        </div>
      )}

      <label className="config-toggle">
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={loading || (!status.enabled && !status.canStore)}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>{t('config.pki_dm.enable', 'Decrypt PKI direct messages for this source')}</span>
      </label>

      <div className="config-pki-dm__state">
        {status.enabled
          ? status.keyStored
            ? t('config.pki_dm.key_stored', '✓ Private key stored — DMs to this node will be decrypted.')
            : t('config.pki_dm.key_pending', '⏳ Enabled — the key will be extracted the next time this source connects.')
          : t('config.pki_dm.disabled', 'Disabled — PKI DMs to this node are not decrypted server-side.')}
      </div>

      {error && <div className="config-error" role="alert">{error}</div>}
    </div>
  );
};

export default PkiDmDecryptionSection;
