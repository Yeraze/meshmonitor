import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

/**
 * Traffic Management (TMM) module config — v2.8 "non-zero implies enabled" schema.
 *
 * Meshtastic protobufs commit d4f7ddb1 removed the nine bool toggles and
 * `position_precision_bits` from `TrafficManagementConfig` and reserved their
 * tags. Every remaining knob is a uint32 where a non-zero value implicitly
 * enables the feature and 0 disables it — that is exactly how
 * `TrafficManagementModule.cpp` reads them on firmware develop. Position
 * precision is now driven by the channel's own `position_precision` ceiling,
 * so there is no TMM field for it any more (#5123).
 *
 * The module-level on/off switch is `moduleConfig.has_traffic_management`,
 * which the device sets when it receives this config — there is no separate
 * `enabled` field to send.
 */
interface TrafficManagementConfigSectionProps {
  positionMinIntervalSecs: number;
  setPositionMinIntervalSecs: (value: number) => void;
  nodeinfoDirectResponseMaxHops: number;
  setNodeinfoDirectResponseMaxHops: (value: number) => void;
  rateLimitWindowSecs: number;
  setRateLimitWindowSecs: (value: number) => void;
  rateLimitMaxPackets: number;
  setRateLimitMaxPackets: (value: number) => void;
  unknownPacketThreshold: number;
  setUnknownPacketThreshold: (value: number) => void;
  isDisabled: boolean;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const TrafficManagementConfigSection: React.FC<TrafficManagementConfigSectionProps> = ({
  positionMinIntervalSecs,
  setPositionMinIntervalSecs,
  nodeinfoDirectResponseMaxHops,
  setNodeinfoDirectResponseMaxHops,
  rateLimitWindowSecs,
  setRateLimitWindowSecs,
  rateLimitMaxPackets,
  setRateLimitMaxPackets,
  unknownPacketThreshold,
  setUnknownPacketThreshold,
  isDisabled,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  const initialValuesRef = useRef({
    positionMinIntervalSecs,
    nodeinfoDirectResponseMaxHops,
    rateLimitWindowSecs,
    rateLimitMaxPackets,
    unknownPacketThreshold
  });

  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      positionMinIntervalSecs !== initial.positionMinIntervalSecs ||
      nodeinfoDirectResponseMaxHops !== initial.nodeinfoDirectResponseMaxHops ||
      rateLimitWindowSecs !== initial.rateLimitWindowSecs ||
      rateLimitMaxPackets !== initial.rateLimitMaxPackets ||
      unknownPacketThreshold !== initial.unknownPacketThreshold
    );
  }, [positionMinIntervalSecs, nodeinfoDirectResponseMaxHops,
    rateLimitWindowSecs, rateLimitMaxPackets, unknownPacketThreshold]);

  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setPositionMinIntervalSecs(initial.positionMinIntervalSecs);
    setNodeinfoDirectResponseMaxHops(initial.nodeinfoDirectResponseMaxHops);
    setRateLimitWindowSecs(initial.rateLimitWindowSecs);
    setRateLimitMaxPackets(initial.rateLimitMaxPackets);
    setUnknownPacketThreshold(initial.unknownPacketThreshold);
  }, [setPositionMinIntervalSecs, setNodeinfoDirectResponseMaxHops,
    setRateLimitWindowSecs, setRateLimitMaxPackets, setUnknownPacketThreshold]);

  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      positionMinIntervalSecs,
      nodeinfoDirectResponseMaxHops,
      rateLimitWindowSecs,
      rateLimitMaxPackets,
      unknownPacketThreshold
    };
  }, [onSave, positionMinIntervalSecs, nodeinfoDirectResponseMaxHops,
    rateLimitWindowSecs, rateLimitMaxPackets, unknownPacketThreshold]);

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
    borderLeft: '2px solid var(--color-surface-hover)',
    marginBottom: '1rem'
  };

  const subGroupTitleStyle = {
    fontSize: '0.9rem',
    fontWeight: 600 as const,
    color: 'var(--color-text)',
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
          backgroundColor: 'var(--color-surface)',
          borderRadius: '0.5rem',
          color: 'var(--color-text-subtle)',
          fontStyle: 'italic',
          marginBottom: '1rem'
        }}>
          {t('trafficmanagement_config.unsupported', 'Unsupported by this device — Traffic Management requires Meshtastic firmware 2.8.0 or newer. Saving on 2.7.x firmware would not persist on the device.')}
        </div>
      )}

      <div style={isDisabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
        <p className="setting-description" style={{ marginBottom: '1rem' }}>
          {t('trafficmanagement_config.zero_disables', 'Packet inspection and traffic shaping to reduce channel utilization. Each setting below is enabled by giving it a non-zero value; leave it at 0 to turn that feature off.')}
        </p>

        {/* Position Dedup Group */}
        <div style={subGroupStyle}>
          <div style={subGroupTitleStyle}>{t('trafficmanagement_config.position_dedup', 'Position Deduplication')}</div>

          <div className="setting-item">
            <label htmlFor="positionMinIntervalSecs">
              {t('trafficmanagement_config.position_min_interval_secs', 'Minimum Interval (seconds)')}
              <span className="setting-description">{t('trafficmanagement_config.position_min_interval_secs_description', 'Minimum seconds between position updates from the same node. 0 disables position deduplication. Position precision is taken from the channel\'s own Position Precision setting.')}</span>
            </label>
            <input
              id="positionMinIntervalSecs"
              type="number"
              min="0"
              value={positionMinIntervalSecs}
              onChange={(e) => setPositionMinIntervalSecs(parseInt(e.target.value) || 0)}
              disabled={isDisabled}
              className="setting-input"
            />
          </div>
        </div>

        {/* NodeInfo Direct Response Group */}
        <div style={subGroupStyle}>
          <div style={subGroupTitleStyle}>{t('trafficmanagement_config.nodeinfo_direct_response', 'NodeInfo Direct Response')}</div>

          <div className="setting-item">
            <label htmlFor="nodeinfoDirectResponseMaxHops">
              {t('trafficmanagement_config.nodeinfo_max_hops', 'Max Hops')}
              <span className="setting-description">{t('trafficmanagement_config.nodeinfo_max_hops_description', 'Maximum hop distance from the requestor at which NodeInfo requests are answered from the local cache. 0 disables direct response.')}</span>
            </label>
            <input
              id="nodeinfoDirectResponseMaxHops"
              type="number"
              min="0"
              max="7"
              value={nodeinfoDirectResponseMaxHops}
              onChange={(e) => setNodeinfoDirectResponseMaxHops(parseInt(e.target.value) || 0)}
              disabled={isDisabled}
              className="setting-input"
            />
          </div>
        </div>

        {/* Rate Limiting Group */}
        <div style={subGroupStyle}>
          <div style={subGroupTitleStyle}>{t('trafficmanagement_config.rate_limiting', 'Rate Limiting')}</div>

          <div className="setting-item">
            <label htmlFor="rateLimitWindowSecs">
              {t('trafficmanagement_config.rate_limit_window', 'Window (seconds)')}
              <span className="setting-description">{t('trafficmanagement_config.rate_limit_window_description', 'Time window for rate limiting calculations. Rate limiting runs only when both this and Max Packets are non-zero.')}</span>
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

          <div className="setting-item">
            <label htmlFor="rateLimitMaxPackets">
              {t('trafficmanagement_config.rate_limit_max_packets', 'Max Packets Per Window')}
              <span className="setting-description">{t('trafficmanagement_config.rate_limit_max_packets_description', 'Maximum packets allowed per node within the window. Rate limiting runs only when both this and Window are non-zero.')}</span>
            </label>
            <input
              id="rateLimitMaxPackets"
              type="number"
              min="0"
              value={rateLimitMaxPackets}
              onChange={(e) => setRateLimitMaxPackets(parseInt(e.target.value) || 0)}
              disabled={isDisabled}
              className="setting-input"
            />
          </div>
        </div>

        {/* Drop Unknown Group */}
        <div style={subGroupStyle}>
          <div style={subGroupTitleStyle}>{t('trafficmanagement_config.drop_unknown', 'Drop Unknown Packets')}</div>

          <div className="setting-item">
            <label htmlFor="unknownPacketThreshold">
              {t('trafficmanagement_config.unknown_packet_threshold', 'Unknown Packet Threshold')}
              <span className="setting-description">{t('trafficmanagement_config.unknown_packet_threshold_description', 'Number of unknown/undecryptable packets from a node within the rate window before it is dropped. 0 disables unknown-packet filtering.')}</span>
            </label>
            <input
              id="unknownPacketThreshold"
              type="number"
              min="0"
              value={unknownPacketThreshold}
              onChange={(e) => setUnknownPacketThreshold(parseInt(e.target.value) || 0)}
              disabled={isDisabled}
              className="setting-input"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default TrafficManagementConfigSection;
