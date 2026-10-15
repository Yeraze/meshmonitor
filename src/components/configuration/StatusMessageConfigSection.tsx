import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSectionBaseline } from '../../hooks/useSectionBaseline';
import styles from './StatusMessageConfigSection.module.css';
import { NODE_STATUS_MAX_BYTES, truncateToUtf8Bytes, utf8ByteLength } from '../../utils/statusMessage';
import { ConfigSection } from '../shared/config/ConfigSection';

interface StatusMessageConfigSectionProps {
  nodeStatus: string;
  setNodeStatus: (value: string) => void;
  isDisabled: boolean;
  isSaving: boolean;
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
}

const StatusMessageConfigSection: React.FC<StatusMessageConfigSectionProps> = ({
  nodeStatus,
  setNodeStatus,
  isDisabled,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const nodeStatusBytes = utf8ByteLength(nodeStatus);

  // What the node holds; moves on a successful save (#5797)
  const values = {
    nodeStatus
  };
  const { baseline, hasChanges, commit } = useSectionBaseline(values);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setNodeStatus(baseline.nodeStatus);
  }, [baseline, setNodeStatus]);

  // Move the baseline only when the node took the save
  const handleSave = async () => {
    if (await onSave()) commit(values);
  };

  // Register with SaveBar
  useSaveBar({
    id: 'statusmessage-config',
    sectionName: t('statusmessage_config.title', 'Status Message'),
    hasChanges: hasChanges && !isDisabled,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
  });

  return (
    <ConfigSection title={t('statusmessage_config.title', 'Status Message')} docsUrl="https://meshtastic.org/docs/configuration/module/status-message/">

      {isDisabled && (
        <div style={{
          padding: '1rem',
          backgroundColor: 'var(--color-surface)',
          borderRadius: '0.5rem',
          color: 'var(--color-text-subtle)',
          fontStyle: 'italic',
          marginBottom: '1rem'
        }}>
          {t('statusmessage_config.unsupported', 'Unsupported by device firmware — Requires firmware 2.7.20 or greater')}
        </div>
      )}

      <div style={isDisabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
        {/* Node Status */}
        <div className="setting-item">
          <label htmlFor="statusMessageNodeStatus">
            {t('statusmessage_config.node_status', 'Node Status')}
            <span className="setting-description">
              {t(
                'statusmessage_config.node_status_description_bytes',
                'A short status message shown for this node. Up to {{max}} bytes: an emoji takes 4 or more.',
                { max: NODE_STATUS_MAX_BYTES },
              )}
            </span>
          </label>
          <div className={styles.field}>
            <input
              id="statusMessageNodeStatus"
              type="text"
              value={nodeStatus}
              // The firmware limit is in UTF-8 bytes, so `maxLength` (which
              // counts UTF-16 units) let emoji overflow it (#5616). Cut at the
              // byte limit on whole characters instead.
              onChange={(e) => setNodeStatus(truncateToUtf8Bytes(e.target.value))}
              className={`setting-input ${styles.input}`}
              disabled={isDisabled}
              placeholder={t('statusmessage_config.node_status_placeholder', 'Enter status message...')}
            />
            <span
              className={nodeStatusBytes >= NODE_STATUS_MAX_BYTES - 10 ? `${styles.counter} ${styles.counterNearLimit}` : styles.counter}
              data-testid="status-message-counter"
            >
              {t('statusmessage_config.byte_counter', '{{used}}/{{max}} bytes', { used: nodeStatusBytes, max: NODE_STATUS_MAX_BYTES })}
            </span>
          </div>
        </div>
      </div>
    </ConfigSection>
  );
};

export default StatusMessageConfigSection;
