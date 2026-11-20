/**
 * Editable list of topic-rewrite rules for one direction of an mqtt_bridge
 * (#6516). Shared by the bridge Configuration page and the broker modal.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { MAX_TOPIC_REWRITE_RULES } from '../../server/constants/mqttBridge.js';
import type { BridgeRewriteStrings } from './mqttBridgeConfig';
import styles from './TopicRewriteList.module.css';

interface TopicRewriteListProps {
  title: string;
  rows: BridgeRewriteStrings[];
  onChange: (rows: BridgeRewriteStrings[]) => void;
  disabled?: boolean;
  fromPlaceholder?: string;
  toPlaceholder?: string;
  /** Mark the first row as the one a packet goes to (uplink without fan-out). */
  markPrimary?: boolean;
}

export function TopicRewriteList({
  title,
  rows,
  onChange,
  disabled = false,
  fromPlaceholder,
  toPlaceholder,
  markPrimary = false,
}: TopicRewriteListProps) {
  const { t } = useTranslation();
  // Row to focus when it mounts: the one "Add rule" just created.
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const update = (i: number, next: Partial<BridgeRewriteStrings>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...next } : r)));

  return (
    <div className={styles.list}>
      <span className={styles.title}>{title}</span>
      {rows.map((row, i) => (
        <div key={i} className={styles.row}>
          <input
            className="dashboard-form-input"
            aria-label={`${title} ${i + 1} ${t('mqtt_bridge_config.rewrite_from', 'from')}`}
            value={row.from}
            disabled={disabled}
            autoFocus={i === focusRow}
            placeholder={fromPlaceholder}
            onChange={(e) => update(i, { from: e.target.value })}
          />
          <span className={styles.arrow} aria-hidden="true">
            <UiIcon name="forward" size={14} />
          </span>
          <input
            className="dashboard-form-input"
            aria-label={`${title} ${i + 1} ${t('mqtt_bridge_config.rewrite_to', 'to')}`}
            value={row.to}
            disabled={disabled}
            placeholder={toPlaceholder}
            onChange={(e) => update(i, { to: e.target.value })}
          />
          <button
            type="button"
            className={styles.iconButton}
            disabled={disabled}
            aria-label={t('mqtt_bridge_config.rewrite_remove', 'Remove rule')}
            title={t('mqtt_bridge_config.rewrite_remove', 'Remove rule')}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <UiIcon name="delete" size={14} />
          </button>
          {markPrimary && i === 0 && rows.length > 1 && (
            <span className={styles.primary}>
              {t('mqtt_bridge_config.rewrite_primary', 'Primary: a packet goes to the first rule that matches')}
            </span>
          )}
        </div>
      ))}
      <button
        type="button"
        className={styles.addButton}
        disabled={disabled || rows.length >= MAX_TOPIC_REWRITE_RULES}
        onClick={() => {
          setFocusRow(rows.length);
          onChange([...rows, { from: '', to: '' }]);
        }}
      >
        <UiIcon name="plus" size={12} />
        {t('mqtt_bridge_config.rewrite_add', 'Add rule')}
      </button>
      {rows.length >= MAX_TOPIC_REWRITE_RULES && (
        <span className={styles.help}>
          {t('mqtt_bridge_config.rewrite_max', 'At most {{max}} rules per direction.', {
            max: MAX_TOPIC_REWRITE_RULES,
          })}
        </span>
      )}
    </div>
  );
}
