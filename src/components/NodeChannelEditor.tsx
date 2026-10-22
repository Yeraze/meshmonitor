import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import styles from './NodeChannelEditor.module.css';

interface ChannelOption {
  id: number;
  name?: string;
}

interface NodeChannelEditorProps {
  /** The node's stored channel; undefined when none is recorded. */
  channel: number | undefined;
  locked: boolean;
  /** The source's channels, for the picker. */
  channels: ChannelOption[];
  /** Persist the new channel (null clears it) and lock state. */
  onSave: (channel: number | null, locked: boolean) => Promise<void>;
}

const NONE = '';

function channelLabel(id: number, channels: ChannelOption[]): string {
  const name = channels.find(ch => ch.id === id)?.name;
  return name ? `${id} (${name})` : `${id}`;
}

/**
 * Node details "Channel" card with an editor (#5923). The channel decides
 * which channel-scoped viewers see the node, and it was once recorded from
 * packets the node couldn't have sent on that channel. Users with nodes:write
 * can set or clear it here, and lock it so traffic stops changing it.
 */
const NodeChannelEditor: React.FC<NodeChannelEditorProps> = ({ channel, locked, channels, onSave }) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draftChannel, setDraftChannel] = useState<string>(NONE);
  const [draftLocked, setDraftLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraftChannel(channel === undefined ? NONE : String(channel));
      setDraftLocked(locked);
      setError(null);
    }
  }, [channel, locked, editing]);

  // Offer the source's channels, plus the stored one if the list lacks it
  // (e.g. a channel since removed from the radio).
  const options = [...channels].sort((a, b) => a.id - b.id);
  if (channel !== undefined && !options.some(ch => ch.id === channel)) {
    options.push({ id: channel });
  }

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draftChannel === NONE ? null : Number(draftChannel), draftLocked);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('node_details.channel_save_failed', 'Could not save the channel'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`node-detail-card ${styles.card}`} data-testid="node-channel-editor">
      <div className="node-detail-label">{t('node_details.channel')}</div>
      {!editing ? (
        <div className={`node-detail-value ${styles.valueRow}`}>
          <span>{channel === undefined ? t('node_details.channel_none', 'None') : channelLabel(channel, channels)}</span>
          {locked && (
            <span className={styles.lockBadge} title={t('node_details.channel_locked_hint', 'Locked: traffic does not change this channel')}>
              <UiIcon name="encrypted" size={12} /> {t('node_details.channel_locked', 'Locked')}
            </span>
          )}
          <button type="button" className={styles.editButton} onClick={() => setEditing(true)}>
            {t('common.edit', 'Edit')}
          </button>
        </div>
      ) : (
        <div className={styles.editor}>
          <select
            aria-label={t('node_details.channel')}
            value={draftChannel}
            onChange={e => setDraftChannel(e.target.value)}
            disabled={saving}
          >
            <option value={NONE}>{t('node_details.channel_none', 'None')}</option>
            {options.map(ch => (
              <option key={ch.id} value={String(ch.id)}>{channelLabel(ch.id, channels)}</option>
            ))}
          </select>
          <label className={styles.lockToggle}>
            <input
              type="checkbox"
              checked={draftLocked}
              onChange={e => setDraftLocked(e.target.checked)}
              disabled={saving}
            />
            {t('node_details.channel_lock_label', 'Lock (traffic will not change it)')}
          </label>
          <span className={styles.hint}>
            {t('node_details.channel_edit_hint', 'Unlocked, the next packet decoded with a channel key updates it again.')}
          </span>
          {error && <span className={styles.error}>{error}</span>}
          <div className={styles.actions}>
            <button type="button" onClick={() => setEditing(false)} disabled={saving}>
              {t('common.cancel', 'Cancel')}
            </button>
            <button type="button" className={styles.save} onClick={handleSave} disabled={saving}>
              {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default NodeChannelEditor;
