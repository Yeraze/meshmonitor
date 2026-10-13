/**
 * MeshCoreReactionsSection (#5759).
 *
 * Two switches for emoji reactions from MeshCore One and meshcore-open:
 *  - show them as chips (this source), and
 *  - let Auto-Acknowledge answer them (every MeshCore source).
 *
 * The second one costs airtime: a reaction is one tap for the sender, and each
 * could trigger a reply. The warning sits beside the box, always visible.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { parseJsonResponse } from '../../utils/parseJsonResponse';
import { useToast } from '../ToastContainer';
import { UiIcon } from '../icons';
import { MC_REACTION_FORMAT_VERSION } from '../../utils/meshcoreReactions';
import styles from './MeshCoreReactionsSection.module.css';

interface MeshCoreReactionsSectionProps {
  baseUrl: string;
  sourceId: string;
}

const isOn = (v: unknown): boolean => v === true || v === 'true' || v === '1';

export const MeshCoreReactionsSection: React.FC<MeshCoreReactionsSectionProps> = ({ baseUrl, sourceId }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const sourceUrl = `${baseUrl}/api/settings?sourceId=${encodeURIComponent(sourceId)}`;
  const globalUrl = `${baseUrl}/api/settings`;
  const [inbound, setInbound] = useState(true);
  const [ack, setAck] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(sourceUrl);
        if (!res.ok) return;
        const settings = await parseJsonResponse(res);
        if (cancelled || !settings) return;
        const inboundValue = settings.meshcoreReactionsInboundEnabled;
        // On unless stored off.
        setInbound(!(inboundValue === false || inboundValue === 'false' || inboundValue === '0'));
        setAck(isOn(settings.meshcoreReactionsAckOnReceive));
      } catch {
        // Keep the defaults; the boxes stay usable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [csrfFetch, sourceUrl]);

  const save = useCallback(async (
    url: string,
    key: 'meshcoreReactionsInboundEnabled' | 'meshcoreReactionsAckOnReceive',
    next: boolean,
    apply: (value: boolean) => void,
  ) => {
    apply(next);
    setSaving(true);
    const saved = await csrfFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: next }),
    }).then(res => res.ok, () => false);
    setSaving(false);
    if (!saved) {
      apply(!next);
      showToast(t('meshcore.reactions.settings.save_failed', 'Failed to save the reaction setting'), 'error');
    }
  }, [csrfFetch, showToast, t]);

  return (
    <div className={`form-section ${styles.section}`} data-testid="meshcore-reactions-settings">
      <h3>{t('meshcore.reactions.settings.title', 'Reactions')}</h3>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={inbound}
          disabled={saving}
          data-testid="meshcore-reactions-inbound"
          onChange={e => void save(sourceUrl, 'meshcoreReactionsInboundEnabled', e.target.checked, setInbound)}
        />
        <span>{t('meshcore.reactions.settings.inbound_label', 'Show MeshCore reactions')}</span>
      </label>
      <p className="hint">
        {t(
          'meshcore.reactions.settings.inbound_help',
          'Reactions from MeshCore One and meshcore-open show as chips under the message. Turn this off to keep them as plain text lines.',
        )}
      </p>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={ack}
          disabled={saving}
          data-testid="meshcore-reactions-ack"
          onChange={e => void save(globalUrl, 'meshcoreReactionsAckOnReceive', e.target.checked, setAck)}
        />
        <span>
          {t('meshcore.reactions.settings.ack_label', 'Auto-Acknowledge may answer reactions (all MeshCore sources)')}
        </span>
      </label>
      <div className={styles.warning} role="note" data-testid="meshcore-reactions-ack-warning">
        <span className={styles.warningIcon}><UiIcon name="alert" size={16} /></span>
        <span>
          {t(
            'meshcore.reactions.settings.ack_warning',
            'A reaction is one tap for the sender. With this on, each one can trigger an Auto-Acknowledge reply on the air. Leave it off on busy channels.',
          )}
        </span>
      </div>
      <p className="hint">
        {t('meshcore.reactions.settings.format_note', 'Wire format v{{version}} (MeshCore One 1.4.1 and later).', {
          version: MC_REACTION_FORMAT_VERSION,
        })}
      </p>
    </div>
  );
};
