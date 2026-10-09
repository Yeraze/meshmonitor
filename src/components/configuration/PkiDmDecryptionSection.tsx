/**
 * PkiDmDecryptionSection — per-source opt-in for server-side PKI direct-message
 * decryption (issue #3441). When enabled, MeshMonitor extracts the source's
 * local-node X25519 private key from the device and stores it encrypted, then
 * decrypts PKI DMs addressed to that node (including ones relayed still-encrypted
 * via MQTT) so they appear in the unified Messages view.
 *
 * Gated server-side by the per-source `configuration` permission. Talks to
 * GET /api/sources/:id/pki-dm/status and POST /api/sources/:id/pki-dm.
 *
 * It is a MeshMonitor-side switch, so it sits on the source's Settings page
 * (#5683 follow-up; it was on Device Configuration). The grant did not move
 * with it: the status route needs `configuration:read` and the switch needs
 * `configuration:write`, so the host passes `canWrite` and a viewer without it
 * gets the switch disabled, with the reason.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSource } from '../../contexts/SourceContext';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import apiService from '../../services/api';
import { UiIcon } from '../icons';

interface PkiDmStatus {
  enabled: boolean;
  globallyEnabled: boolean;
  keyStored: boolean;
  canStore: boolean;
  reason?: string | null;
}

interface PkiDmDecryptionSectionProps {
  /** Anchor id of the section on the host page. */
  sectionId?: string;
  /** Section class of the host page (`settings-section` on Settings). */
  className?: string;
  /** The viewer holds `configuration:write` on this source. Default true. */
  canWrite?: boolean;
}

const PkiDmDecryptionSection: React.FC<PkiDmDecryptionSectionProps> = ({
  sectionId = 'config-pki-dm',
  className = 'config-section',
  canWrite = true,
}) => {
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
    <div className={className} id={sectionId} data-testid="pki-dm-section">
      <h3><UiIcon name="unlock" /> {t('config.pki_dm.title', 'PKI Direct Message Decryption')}</h3>
      <p className="config-description">
        {t(
          'config.pki_dm.description',
          'Decrypt PKI-encrypted direct messages addressed to this node — including ones relayed still-encrypted via MQTT — so they appear in the unified Messages view. MeshMonitor stores this node\'s private key, encrypted at rest. Only enable on sources you trust this server with.',
        )}
      </p>

      {!status.globallyEnabled && (
        <div className="config-warning" role="alert">
          {t('config.pki_dm.globally_disabled_global_settings', 'PKI direct message decryption is turned off globally. Enable it under Security in Global Settings before turning it on per source.')}
        </div>
      )}

      {status.globallyEnabled && !status.canStore && (
        <div className="config-warning" role="alert">
          {status.reason || t('config.pki_dm.no_secret', 'SESSION_SECRET is not configured, so keys cannot be stored persistently.')}
        </div>
      )}

      <label className="config-toggle">
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={!canWrite || loading || !status.globallyEnabled || (!status.enabled && !status.canStore)}
          title={!canWrite ? t('config.pki_dm.no_write', 'Changing this needs the Device Configuration write permission on this source.') : undefined}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>{t('config.pki_dm.enable', 'Decrypt PKI direct messages for this source')}</span>
      </label>

      <div className="config-pki-dm__state">
        {status.enabled && <UiIcon name={status.keyStored ? 'check' : 'time'} />}{' '}
        {status.enabled
          ? status.keyStored
            ? t('config.pki_dm.key_stored', 'Private key stored — DMs to this node will be decrypted.')
            : t('config.pki_dm.key_pending', 'Enabled — the key will be extracted the next time this source connects.')
          : t('config.pki_dm.disabled', 'Disabled — PKI DMs to this node are not decrypted server-side.')}
      </div>

      {!canWrite && (
        <p className="setting-description" role="status">
          {t('config.pki_dm.no_write', 'Changing this needs the Device Configuration write permission on this source.')}
        </p>
      )}

      {error && <div className="config-error" role="alert">{error}</div>}
    </div>
  );
};

export default PkiDmDecryptionSection;
