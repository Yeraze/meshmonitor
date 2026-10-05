import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';
import styles from './StatusMessageConfigSection.module.css';
import { NODE_STATUS_MAX_BYTES, truncateToUtf8Bytes, utf8ByteLength } from '../../utils/statusMessage';

interface StatusMessageConfigSectionProps {
  nodeStatus: string;
  setNodeStatus: (value: string) => void;
  isDisabled: boolean;
  isSaving: boolean;
  onSave: () => Promise<void>;
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

  // Track initial values for change detection
  const initialValuesRef = useRef({
    nodeStatus
  });

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return nodeStatus !== initial.nodeStatus;
  }, [nodeStatus]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setNodeStatus(initial.nodeStatus);
  }, [setNodeStatus]);

  // Update initial values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = { nodeStatus };
  }, [onSave, nodeStatus]);

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
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('statusmessage_config.title', 'Status Message')}
        <a
          href="https://meshtastic.org/docs/configuration/module/status-message/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('statusmessage_config.view_docs', 'View Meshtastic docs')}
        >
          ?
        </a>
      </h3>

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
    </div>
  );
};

export default StatusMessageConfigSection;
