import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

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
          backgroundColor: 'var(--ctp-surface0)',
          borderRadius: '0.5rem',
          color: 'var(--ctp-subtext0)',
          fontStyle: 'italic',
          marginBottom: '1rem'
        }}>
          {t('statusmessage_config.unsupported', 'Unsupported by device firmware — Requires firmware 2.7.19 or greater')}
        </div>
      )}

      <div style={isDisabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
        {/* Node Status */}
        <div className="setting-item">
          <label htmlFor="statusMessageNodeStatus">
            {t('statusmessage_config.node_status', 'Node Status')}
            <span className="setting-description">
              {t('statusmessage_config.node_status_description', 'A short status message displayed on the node. Maximum 80 characters.')}
            </span>
          </label>
          <div style={{ position: 'relative' }}>
            <input
              id="statusMessageNodeStatus"
              type="text"
              maxLength={80}
              value={nodeStatus}
              onChange={(e) => setNodeStatus(e.target.value)}
              className="setting-input"
              disabled={isDisabled}
              placeholder={t('statusmessage_config.node_status_placeholder', 'Enter status message...')}
            />
            <span style={{
              position: 'absolute',
              right: '0.5rem',
              bottom: '-1.2rem',
              fontSize: '0.75rem',
              color: nodeStatus.length >= 70 ? 'var(--ctp-peach)' : 'var(--ctp-subtext0)'
            }}>
              {nodeStatus.length}/80
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StatusMessageConfigSection;
