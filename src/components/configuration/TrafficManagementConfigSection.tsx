import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

interface TrafficManagementConfigSectionProps {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  positionDedupEnabled: boolean;
  setPositionDedupEnabled: (value: boolean) => void;
  positionDedupTimeSecs: number;
  setPositionDedupTimeSecs: (value: number) => void;
  positionDedupDistanceMeters: number;
  setPositionDedupDistanceMeters: (value: number) => void;
  nodeinfoDirectResponseEnabled: boolean;
  setNodeinfoDirectResponseEnabled: (value: boolean) => void;
  nodeinfoDirectResponseMyNodeOnly: boolean;
  setNodeinfoDirectResponseMyNodeOnly: (value: boolean) => void;
  rateLimitEnabled: boolean;
  setRateLimitEnabled: (value: boolean) => void;
  rateLimitMaxPerNode: number;
  setRateLimitMaxPerNode: (value: number) => void;
  rateLimitWindowSecs: number;
  setRateLimitWindowSecs: (value: number) => void;
  unknownPacketDropEnabled: boolean;
  setUnknownPacketDropEnabled: (value: boolean) => void;
  unknownPacketGracePeriodSecs: number;
  setUnknownPacketGracePeriodSecs: (value: number) => void;
  hopExhaustionEnabled: boolean;
  setHopExhaustionEnabled: (value: boolean) => void;
  hopExhaustionMinHops: number;
  setHopExhaustionMinHops: (value: number) => void;
  hopExhaustionMaxHops: number;
  setHopExhaustionMaxHops: (value: number) => void;
  isDisabled: boolean;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const TrafficManagementConfigSection: React.FC<TrafficManagementConfigSectionProps> = ({
  enabled,
  setEnabled,
  positionDedupEnabled,
  setPositionDedupEnabled,
  positionDedupTimeSecs,
  setPositionDedupTimeSecs,
  positionDedupDistanceMeters,
  setPositionDedupDistanceMeters,
  nodeinfoDirectResponseEnabled,
  setNodeinfoDirectResponseEnabled,
  nodeinfoDirectResponseMyNodeOnly,
  setNodeinfoDirectResponseMyNodeOnly,
  rateLimitEnabled,
  setRateLimitEnabled,
  rateLimitMaxPerNode,
  setRateLimitMaxPerNode,
  rateLimitWindowSecs,
  setRateLimitWindowSecs,
  unknownPacketDropEnabled,
  setUnknownPacketDropEnabled,
  unknownPacketGracePeriodSecs,
  setUnknownPacketGracePeriodSecs,
  hopExhaustionEnabled,
  setHopExhaustionEnabled,
  hopExhaustionMinHops,
  setHopExhaustionMinHops,
  hopExhaustionMaxHops,
  setHopExhaustionMaxHops,
  isDisabled,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  // Track initial values for change detection
  const initialValuesRef = useRef({
    enabled, positionDedupEnabled, positionDedupTimeSecs, positionDedupDistanceMeters,
    nodeinfoDirectResponseEnabled, nodeinfoDirectResponseMyNodeOnly,
    rateLimitEnabled, rateLimitMaxPerNode, rateLimitWindowSecs,
    unknownPacketDropEnabled, unknownPacketGracePeriodSecs,
    hopExhaustionEnabled, hopExhaustionMinHops, hopExhaustionMaxHops
  });

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      enabled !== initial.enabled ||
      positionDedupEnabled !== initial.positionDedupEnabled ||
      positionDedupTimeSecs !== initial.positionDedupTimeSecs ||
      positionDedupDistanceMeters !== initial.positionDedupDistanceMeters ||
      nodeinfoDirectResponseEnabled !== initial.nodeinfoDirectResponseEnabled ||
      nodeinfoDirectResponseMyNodeOnly !== initial.nodeinfoDirectResponseMyNodeOnly ||
      rateLimitEnabled !== initial.rateLimitEnabled ||
      rateLimitMaxPerNode !== initial.rateLimitMaxPerNode ||
      rateLimitWindowSecs !== initial.rateLimitWindowSecs ||
      unknownPacketDropEnabled !== initial.unknownPacketDropEnabled ||
      unknownPacketGracePeriodSecs !== initial.unknownPacketGracePeriodSecs ||
      hopExhaustionEnabled !== initial.hopExhaustionEnabled ||
      hopExhaustionMinHops !== initial.hopExhaustionMinHops ||
      hopExhaustionMaxHops !== initial.hopExhaustionMaxHops
    );
  }, [enabled, positionDedupEnabled, positionDedupTimeSecs, positionDedupDistanceMeters,
    nodeinfoDirectResponseEnabled, nodeinfoDirectResponseMyNodeOnly,
    rateLimitEnabled, rateLimitMaxPerNode, rateLimitWindowSecs,
    unknownPacketDropEnabled, unknownPacketGracePeriodSecs,
    hopExhaustionEnabled, hopExhaustionMinHops, hopExhaustionMaxHops]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setEnabled(initial.enabled);
    setPositionDedupEnabled(initial.positionDedupEnabled);
    setPositionDedupTimeSecs(initial.positionDedupTimeSecs);
    setPositionDedupDistanceMeters(initial.positionDedupDistanceMeters);
    setNodeinfoDirectResponseEnabled(initial.nodeinfoDirectResponseEnabled);
    setNodeinfoDirectResponseMyNodeOnly(initial.nodeinfoDirectResponseMyNodeOnly);
    setRateLimitEnabled(initial.rateLimitEnabled);
    setRateLimitMaxPerNode(initial.rateLimitMaxPerNode);
    setRateLimitWindowSecs(initial.rateLimitWindowSecs);
    setUnknownPacketDropEnabled(initial.unknownPacketDropEnabled);
    setUnknownPacketGracePeriodSecs(initial.unknownPacketGracePeriodSecs);
    setHopExhaustionEnabled(initial.hopExhaustionEnabled);
    setHopExhaustionMinHops(initial.hopExhaustionMinHops);
    setHopExhaustionMaxHops(initial.hopExhaustionMaxHops);
  }, [setEnabled, setPositionDedupEnabled, setPositionDedupTimeSecs, setPositionDedupDistanceMeters,
    setNodeinfoDirectResponseEnabled, setNodeinfoDirectResponseMyNodeOnly,
    setRateLimitEnabled, setRateLimitMaxPerNode, setRateLimitWindowSecs,
    setUnknownPacketDropEnabled, setUnknownPacketGracePeriodSecs,
    setHopExhaustionEnabled, setHopExhaustionMinHops, setHopExhaustionMaxHops]);

  // Update initial values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      enabled, positionDedupEnabled, positionDedupTimeSecs, positionDedupDistanceMeters,
      nodeinfoDirectResponseEnabled, nodeinfoDirectResponseMyNodeOnly,
      rateLimitEnabled, rateLimitMaxPerNode, rateLimitWindowSecs,
      unknownPacketDropEnabled, unknownPacketGracePeriodSecs,
      hopExhaustionEnabled, hopExhaustionMinHops, hopExhaustionMaxHops
    };
  }, [onSave, enabled, positionDedupEnabled, positionDedupTimeSecs, positionDedupDistanceMeters,
    nodeinfoDirectResponseEnabled, nodeinfoDirectResponseMyNodeOnly,
    rateLimitEnabled, rateLimitMaxPerNode, rateLimitWindowSecs,
    unknownPacketDropEnabled, unknownPacketGracePeriodSecs,
    hopExhaustionEnabled, hopExhaustionMinHops, hopExhaustionMaxHops]);

  // Register with SaveBar
  useSaveBar({
    id: 'trafficmanagement-config',
    sectionName: t('trafficmanagement_config.title', 'Traffic Management'),
    hasChanges: hasChanges && !isDisabled,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
  });

  const subGroupStyle = {
    marginLeft: '1rem',
    paddingLeft: '1rem',
    borderLeft: '2px solid var(--ctp-surface1)',
    marginBottom: '1rem'
  };

  const subGroupTitleStyle = {
    fontSize: '0.9rem',
    fontWeight: 600 as const,
    color: 'var(--ctp-text)',
    marginBottom: '0.5rem',
    marginTop: '0.75rem'
  };

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('trafficmanagement_config.title', 'Traffic Management')}
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
          {t('trafficmanagement_config.unsupported', 'Unsupported by device firmware — Not yet available in any firmware release')}
        </div>
      )}

      <div style={isDisabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
        {/* Enable Module */}
        <div className="setting-item">
          <label htmlFor="trafficManagementEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              id="trafficManagementEnabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={isDisabled}
              style={{ marginTop: '0.2rem', flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('trafficmanagement_config.enabled', 'Enable Traffic Management')}</div>
              <span className="setting-description">{t('trafficmanagement_config.enabled_description', 'Enable traffic management features to control mesh network traffic')}</span>
            </div>
          </label>
        </div>

        {(enabled || isDisabled) && (
          <>
            {/* Position Dedup Group */}
            <div style={subGroupStyle}>
              <div style={subGroupTitleStyle}>{t('trafficmanagement_config.position_dedup', 'Position Deduplication')}</div>

              <div className="setting-item">
                <label htmlFor="positionDedupEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="positionDedupEnabled"
                    type="checkbox"
                    checked={positionDedupEnabled}
                    onChange={(e) => setPositionDedupEnabled(e.target.checked)}
                    disabled={isDisabled}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('trafficmanagement_config.position_dedup_enabled', 'Enable')}</div>
                    <span className="setting-description">{t('trafficmanagement_config.position_dedup_enabled_description', 'Deduplicate position packets from the same node')}</span>
                  </div>
                </label>
              </div>

              {(positionDedupEnabled || isDisabled) && (
                <>
                  <div className="setting-item">
                    <label htmlFor="positionDedupTimeSecs">
                      {t('trafficmanagement_config.position_dedup_time', 'Time Window (seconds)')}
                      <span className="setting-description">{t('trafficmanagement_config.position_dedup_time_description', 'Time window for deduplicating position packets')}</span>
                    </label>
                    <input
                      id="positionDedupTimeSecs"
                      type="number"
                      min="0"
                      value={positionDedupTimeSecs}
                      onChange={(e) => setPositionDedupTimeSecs(parseInt(e.target.value) || 0)}
                      disabled={isDisabled}
                      className="setting-input"
                    />
                  </div>

                  <div className="setting-item">
                    <label htmlFor="positionDedupDistanceMeters">
                      {t('trafficmanagement_config.position_dedup_distance', 'Distance Threshold (meters)')}
                      <span className="setting-description">{t('trafficmanagement_config.position_dedup_distance_description', 'Minimum distance change to consider a new position')}</span>
                    </label>
                    <input
                      id="positionDedupDistanceMeters"
                      type="number"
                      min="0"
                      value={positionDedupDistanceMeters}
                      onChange={(e) => setPositionDedupDistanceMeters(parseInt(e.target.value) || 0)}
                      disabled={isDisabled}
                      className="setting-input"
                    />
                  </div>
                </>
              )}
            </div>

            {/* NodeInfo Direct Response Group */}
            <div style={subGroupStyle}>
              <div style={subGroupTitleStyle}>{t('trafficmanagement_config.nodeinfo_direct_response', 'NodeInfo Direct Response')}</div>

              <div className="setting-item">
                <label htmlFor="nodeinfoDirectResponseEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="nodeinfoDirectResponseEnabled"
                    type="checkbox"
                    checked={nodeinfoDirectResponseEnabled}
                    onChange={(e) => setNodeinfoDirectResponseEnabled(e.target.checked)}
                    disabled={isDisabled}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('trafficmanagement_config.nodeinfo_direct_response_enabled', 'Enable')}</div>
                    <span className="setting-description">{t('trafficmanagement_config.nodeinfo_direct_response_enabled_description', 'Respond directly to NodeInfo requests instead of broadcasting')}</span>
                  </div>
                </label>
              </div>

              {(nodeinfoDirectResponseEnabled || isDisabled) && (
                <div className="setting-item">
                  <label htmlFor="nodeinfoDirectResponseMyNodeOnly" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                    <input
                      id="nodeinfoDirectResponseMyNodeOnly"
                      type="checkbox"
                      checked={nodeinfoDirectResponseMyNodeOnly}
                      onChange={(e) => setNodeinfoDirectResponseMyNodeOnly(e.target.checked)}
                      disabled={isDisabled}
                      style={{ marginTop: '0.2rem', flexShrink: 0 }}
                    />
                    <div style={{ flex: 1 }}>
                      <div>{t('trafficmanagement_config.nodeinfo_my_node_only', 'My Node Only')}</div>
                      <span className="setting-description">{t('trafficmanagement_config.nodeinfo_my_node_only_description', 'Only respond to requests specifically addressed to this node')}</span>
                    </div>
                  </label>
                </div>
              )}
            </div>

            {/* Rate Limiting Group */}
            <div style={subGroupStyle}>
              <div style={subGroupTitleStyle}>{t('trafficmanagement_config.rate_limiting', 'Rate Limiting')}</div>

              <div className="setting-item">
                <label htmlFor="rateLimitEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="rateLimitEnabled"
                    type="checkbox"
                    checked={rateLimitEnabled}
                    onChange={(e) => setRateLimitEnabled(e.target.checked)}
                    disabled={isDisabled}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('trafficmanagement_config.rate_limit_enabled', 'Enable')}</div>
                    <span className="setting-description">{t('trafficmanagement_config.rate_limit_enabled_description', 'Limit packet rate per node to reduce congestion')}</span>
                  </div>
                </label>
              </div>

              {(rateLimitEnabled || isDisabled) && (
                <>
                  <div className="setting-item">
                    <label htmlFor="rateLimitMaxPerNode">
                      {t('trafficmanagement_config.rate_limit_max', 'Max Packets Per Node')}
                      <span className="setting-description">{t('trafficmanagement_config.rate_limit_max_description', 'Maximum number of packets allowed per node within the time window')}</span>
                    </label>
                    <input
                      id="rateLimitMaxPerNode"
                      type="number"
                      min="0"
                      value={rateLimitMaxPerNode}
                      onChange={(e) => setRateLimitMaxPerNode(parseInt(e.target.value) || 0)}
                      disabled={isDisabled}
                      className="setting-input"
                    />
                  </div>

                  <div className="setting-item">
                    <label htmlFor="rateLimitWindowSecs">
                      {t('trafficmanagement_config.rate_limit_window', 'Window (seconds)')}
                      <span className="setting-description">{t('trafficmanagement_config.rate_limit_window_description', 'Time window for rate limiting')}</span>
                    </label>
                    <input
                      id="rateLimitWindowSecs"
                      type="number"
                      min="0"
                      value={rateLimitWindowSecs}
                      onChange={(e) => setRateLimitWindowSecs(parseInt(e.target.value) || 0)}
                      disabled={isDisabled}
                      className="setting-input"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Unknown Packet Drop Group */}
            <div style={subGroupStyle}>
              <div style={subGroupTitleStyle}>{t('trafficmanagement_config.unknown_packet_drop', 'Unknown Packet Drop')}</div>

              <div className="setting-item">
                <label htmlFor="unknownPacketDropEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="unknownPacketDropEnabled"
                    type="checkbox"
                    checked={unknownPacketDropEnabled}
                    onChange={(e) => setUnknownPacketDropEnabled(e.target.checked)}
                    disabled={isDisabled}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('trafficmanagement_config.unknown_packet_drop_enabled', 'Enable')}</div>
                    <span className="setting-description">{t('trafficmanagement_config.unknown_packet_drop_enabled_description', 'Drop packets from nodes not in the node database')}</span>
                  </div>
                </label>
              </div>

              {(unknownPacketDropEnabled || isDisabled) && (
                <div className="setting-item">
                  <label htmlFor="unknownPacketGracePeriodSecs">
                    {t('trafficmanagement_config.unknown_packet_grace_period', 'Grace Period (seconds)')}
                    <span className="setting-description">{t('trafficmanagement_config.unknown_packet_grace_period_description', 'Time to wait before dropping packets from unknown nodes')}</span>
                  </label>
                  <input
                    id="unknownPacketGracePeriodSecs"
                    type="number"
                    min="0"
                    value={unknownPacketGracePeriodSecs}
                    onChange={(e) => setUnknownPacketGracePeriodSecs(parseInt(e.target.value) || 0)}
                    disabled={isDisabled}
                    className="setting-input"
                  />
                </div>
              )}
            </div>

            {/* Hop Exhaustion Group */}
            <div style={subGroupStyle}>
              <div style={subGroupTitleStyle}>{t('trafficmanagement_config.hop_exhaustion', 'Hop Exhaustion')}</div>

              <div className="setting-item">
                <label htmlFor="hopExhaustionEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="hopExhaustionEnabled"
                    type="checkbox"
                    checked={hopExhaustionEnabled}
                    onChange={(e) => setHopExhaustionEnabled(e.target.checked)}
                    disabled={isDisabled}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('trafficmanagement_config.hop_exhaustion_enabled', 'Enable')}</div>
                    <span className="setting-description">{t('trafficmanagement_config.hop_exhaustion_enabled_description', 'Reduce hop limit on rebroadcasted packets to prevent excessive flooding')}</span>
                  </div>
                </label>
              </div>

              {(hopExhaustionEnabled || isDisabled) && (
                <>
                  <div className="setting-item">
                    <label htmlFor="hopExhaustionMinHops">
                      {t('trafficmanagement_config.hop_exhaustion_min', 'Minimum Hops')}
                      <span className="setting-description">{t('trafficmanagement_config.hop_exhaustion_min_description', 'Minimum hop limit to set on rebroadcasted packets')}</span>
                    </label>
                    <input
                      id="hopExhaustionMinHops"
                      type="number"
                      min="0"
                      max="7"
                      value={hopExhaustionMinHops}
                      onChange={(e) => setHopExhaustionMinHops(parseInt(e.target.value) || 0)}
                      disabled={isDisabled}
                      className="setting-input"
                    />
                  </div>

                  <div className="setting-item">
                    <label htmlFor="hopExhaustionMaxHops">
                      {t('trafficmanagement_config.hop_exhaustion_max', 'Maximum Hops')}
                      <span className="setting-description">{t('trafficmanagement_config.hop_exhaustion_max_description', 'Maximum hop limit before hop exhaustion is applied')}</span>
                    </label>
                    <input
                      id="hopExhaustionMaxHops"
                      type="number"
                      min="0"
                      max="7"
                      value={hopExhaustionMaxHops}
                      onChange={(e) => setHopExhaustionMaxHops(parseInt(e.target.value) || 0)}
                      disabled={isDisabled}
                      className="setting-input"
                    />
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default TrafficManagementConfigSection;
