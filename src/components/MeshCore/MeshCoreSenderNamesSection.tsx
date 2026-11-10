/**
 * MeshCoreSenderNamesSection - API sender-name override policy (#6282), on
 * Device Configuration (companion only).
 *
 *   GET / PUT …/meshcore/config/sender-names {enabled, allowedNames}   `configuration`
 *
 * Off by default. When on, an API caller with its normal channel write grant
 * may send under one of the listed names instead of the node name. Nothing
 * here transmits.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreActions, SenderNamePolicy } from './hooks/useMeshCore';
import { useToast } from '../ToastContainer';
import { ConfigSection } from '../shared/config/ConfigSection';
import { SENDER_NAME_ALLOWLIST_MAX, normalizeSenderName, validateMeshcoreSenderName } from '../../utils/meshcoreSenderName';
import styles from './MeshCoreDeviceSettingSections.module.css';

export interface MeshCoreSenderNamesSectionProps {
  connected: boolean;
  loading?: boolean;
  actions: Pick<MeshCoreActions, 'getSenderNamePolicy' | 'setSenderNamePolicy'>;
  /** `configuration:write` on this source. */
  canWriteConfig: boolean;
}

const toLines = (names: string[]) => names.join('\n');

/** One name per non-blank line, trimmed and de-duplicated. */
const parseLines = (text: string): string[] => {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const n = normalizeSenderName(line);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
};

export const MeshCoreSenderNamesSection: React.FC<MeshCoreSenderNamesSectionProps> = ({
  connected,
  loading = false,
  actions,
  canWriteConfig,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { getSenderNamePolicy, setSenderNamePolicy } = actions;

  const [saved, setSaved] = useState<SenderNamePolicy>({ enabled: false, allowedNames: [] });
  const [enabled, setEnabled] = useState(false);
  const [namesText, setNamesText] = useState('');
  const [saving, setSaving] = useState(false);

  const apply = useCallback((p: SenderNamePolicy) => {
    setSaved(p);
    setEnabled(p.enabled);
    setNamesText(toLines(p.allowedNames));
  }, []);

  useEffect(() => {
    if (!connected) return;
    void getSenderNamePolicy().then((p) => { if (p) apply(p); });
  }, [connected, getSenderNamePolicy, apply]);

  const names = parseLines(namesText);
  const dirty = enabled !== saved.enabled || toLines(names) !== toLines(saved.allowedNames);
  const disabled = !canWriteConfig || !connected || loading || saving;

  const handleSave = async () => {
    if (names.length > SENDER_NAME_ALLOWLIST_MAX) {
      showToast(t('meshcore.sender_names.too_many', 'At most 16 names are allowed'), 'error');
      return;
    }
    for (const n of names) {
      if (!validateMeshcoreSenderName(n).ok) {
        showToast(t('meshcore.sender_names.invalid', 'Invalid name: {{name}}', { name: n }), 'error');
        return;
      }
    }
    setSaving(true);
    try {
      const result = await setSenderNamePolicy({ enabled, allowedNames: names });
      if (!result) {
        showToast(t('meshcore.sender_names.save_failed', 'Failed to save sender names'), 'error');
        return;
      }
      apply(result);
      showToast(t('meshcore.sender_names.saved', 'Sender names saved'), 'success');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id="meshcore-sender-names">
      <ConfigSection
        title={t('meshcore.sender_names.title', 'API sender names')}
        description={t('meshcore.sender_names.hint',
          "Lets an API caller send a channel message under one of these names instead of this node's name. Off by default. A caller still needs write access to the channel.")}
        collapsible
      >
        <div>
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={disabled}
            />
            {t('meshcore.sender_names.enable', 'Allow API callers to send under these names')}
          </label>
          <div className={styles.block}>
            <label htmlFor="mcSenderNames">{t('meshcore.sender_names.names_label', 'Allowed names, one per line')}</label>
            <textarea
              id="mcSenderNames"
              className={styles.grow}
              rows={4}
              value={namesText}
              onChange={(e) => setNamesText(e.target.value)}
              placeholder={t('meshcore.sender_names.names_placeholder', 'Alerts Bot')}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
            />
            <p className={`hint ${styles.smallHint}`}>
              {t('meshcore.sender_names.names_hint', 'Up to 16 names, 1 to 31 bytes each. No colon, no control characters, no leading #.')}
            </p>
          </div>
          <p className={styles.warning}>
            {t('meshcore.sender_names.warning',
              'Anyone who can send on this source can then post under these names, and MeshCore cannot prove who sent a channel message. List only names you want your API callers to use. Needs companion firmware 1.16 or later, with client repeat off.')}
          </p>
          <div className={styles.row}>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={disabled || !dirty}
              aria-label={t('meshcore.sender_names.save', 'Save sender names')}
            >
              {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </div>
        </div>
      </ConfigSection>
    </div>
  );
};

export default MeshCoreSenderNamesSection;
