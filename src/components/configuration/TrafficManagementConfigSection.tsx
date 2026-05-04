import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

interface TrafficManagementConfigSectionProps {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  positionDedupEnabled: boolean;
  setPositionDedupEnabled: (value: boolean) => void;
  positionPrecisionBits: number;
  setPositionPrecisionBits: (value: number) => void;
  positionMinIntervalSecs: number;
  setPositionMinIntervalSecs: (value: number) => void;
  nodeinfoDirectResponse: boolean;
  setNodeinfoDirectResponse: (value: boolean) => void;
  nodeinfoDirectResponseMaxHops: number;
  setNodeinfoDirectResponseMaxHops: (value: number) => void;
  rateLimitEnabled: boolean;
  setRateLimitEnabled: (value: boolean) => void;
  rateLimitWindowSecs: number;
  setRateLimitWindowSecs: (value: number) => void;
  rateLimitMaxPackets: number;
  setRateLimitMaxPackets: (value: number) => void;
  dropUnknownEnabled: boolean;
  setDropUnknownEnabled: (value: boolean) => void;
  unknownPacketThreshold: number;
  setUnknownPacketThreshold: (value: number) => void;
  exhaustHopTelemetry: boolean;
  setExhaustHopTelemetry: (value: boolean) => void;
  exhaustHopPosition: boolean;
  setExhaustHopPosition: (value: boolean) => void;
  routerPreserveHops: boolean;
  setRouterPreserveHops: (value: boolean) => void;
  isDisabled: boolean;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const TrafficManagementConfigSection: React.FC<TrafficManagementConfigSectionProps> = ({
  enabled,
  setEnabled,
  positionDedupEnabled,
  setPositionDedupEnabled,
  positionPrecisionBits,
  setPositionPrecisionBits,
  positionMinIntervalSecs,
  setPositionMinIntervalSecs,
  nodeinfoDirectResponse,
  setNodeinfoDirectResponse,
  nodeinfoDirectResponseMaxHops,
  setNodeinfoDirectResponseMaxHops,
  rateLimitEnabled,
  setRateLimitEnabled,
  rateLimitWindowSecs,
  setRateLimitWindowSecs,
  rateLimitMaxPackets,
  setRateLimitMaxPackets,
  dropUnknownEnabled,
  setDropUnknownEnabled,
  unknownPacketThreshold,
  setUnknownPacketThreshold,
  exhaustHopTelemetry,
  setExhaustHopTelemetry,
  exhaustHopPosition,
  setExhaustHopPosition,
  routerPreserveHops,
  setRouterPreserveHops,
  isDisabled,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  const initialValuesRef = useRef({
    enabled, positionDedupEnabled, positionPrecisionBits, positionMinIntervalSecs,
    nodeinfoDirectResponse, nodeinfoDirectResponseMaxHops,
    rateLimitEnabled, rateLimitWindowSecs, rateLimitMaxPackets,
    dropUnknownEnabled, unknownPacketThreshold,
    exhaustHopTelemetry, exhaustHopPosition, routerPreserveHops
  });

  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      enabled !== initial.enabled ||
      positionDedupEnabled !== initial.positionDedupEnabled ||
      positionPrecisionBits !== initial.positionPrecisionBits ||
      positionMinIntervalSecs !== initial.positionMinIntervalSecs ||
      nodeinfoDirectResponse !== initial.nodeinfoDirectResponse ||
      nodeinfoDirectResponseMaxHops !== initial.nodeinfoDirectResponseMaxHops ||
      rateLimitEnabled !== initial.rateLimitEnabled ||
      rateLimitWindowSecs !== initial.rateLimitWindowSecs ||
      rateLimitMaxPackets !== initial.rateLimitMaxPackets ||
      dropUnknownEnabled !== initial.dropUnknownEnabled ||
      unknownPacketThreshold !== initial.unknownPacketThreshold ||
      exhaustHopTelemetry !== initial.exhaustHopTelemetry ||
      exhaustHopPosition !== initial.exhaustHopPosition ||
      routerPreserveHops !== initial.routerPreserveHops
    );
  }, [enabled, positionDedupEnabled, positionPrecisionBits, positionMinIntervalSecs,
    nodeinfoDirectResponse, nodeinfoDirectResponseMaxHops,
    rateLimitEnabled, rateLimitWindowSecs, rateLimitMaxPackets,
    dropUnknownEnabled, unknownPacketThreshold,
    exhaustHopTelemetry, exhaustHopPosition, routerPreserveHops]);

  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setEnabled(initial.enabled);
    setPositionDedupEnabled(initial.positionDedupEnabled);
    setPositionPrecisionBits(initial.positionPrecisionBits);
    setPositionMinIntervalSecs(initial.positionMinIntervalSecs);
    setNodeinfoDirectResponse(initial.nodeinfoDirectResponse);
    setNodeinfoDirectResponseMaxHops(initial.nodeinfoDirectResponseMaxHops);
    setRateLimitEnabled(initial.rateLimitEnabled);
    setRateLimitWindowSecs(initial.rateLimitWindowSecs);
    setRateLimitMaxPackets(initial.rateLimitMaxPackets);
    setDropUnknownEnabled(initial.dropUnknownEnabled);
    setUnknownPacketThreshold(initial.unknownPacketThreshold);
    setExhaustHopTelemetry(initial.exhaustHopTelemetry);
    setExhaustHopPosition(initial.exhaustHopPosition);
    setRouterPreserveHops(initial.routerPreserveHops);
  }, [setEnabled, setPositionDedupEnabled, setPositionPrecisionBits, setPositionMinIntervalSecs,
    setNodeinfoDirectResponse, setNodeinfoDirectResponseMaxHops,
    setRateLimitEnabled, setRateLimitWindowSecs, setRateLimitMaxPackets,
    setDropUnknownEnabled, setUnknownPacketThreshold,
    setExhaustHopTelemetry, setExhaustHopPosition, setRouterPreserveHops]);

  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      enabled, positionDedupEnabled, positionPrecisionBits, positionMinIntervalSecs,
      nodeinfoDirectResponse, nodeinfoDirectResponseMaxHops,
      rateLimitEnabled, rateLimitWindowSecs, rateLimitMaxPackets,
      dropUnknownEnabled, unknownPacketThreshold,
      exhaustHopTelemetry, exhaustHopPosition, routerPreserveHops
    };
  }, [onSave, enabled, positionDedupEnabled, positionPrecisionBits, positionMinIntervalSecs,
    nodeinfoDirectResponse, nodeinfoDirectResponseMaxHops,
    rateLimitEnabled, rateLimitWindowSecs, rateLimitMaxPackets,
    dropUnknownEnabled, unknownPacketThreshold,
    exhaustHopTelemetry, exhaustHopPosition, routerPreserveHops]);

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
          {t('trafficmanagement_config.unsupported', 'Unsupported by device firmware — Requires v2.7.20 alpha or newer (not yet in any stable release)')}
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
              <span className="setting-description">{t('trafficmanagement_config.enabled_description', 'Packet inspection and traffic shaping to reduce channel utilization')}</span>
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
                    <span className="setting-description">{t('trafficmanagement_config.position_dedup_enabled_description', 'Drop redundant position broadcasts')}</span>
                  </div>
                </label>
              </div>

              {(positionDedupEnabled || isDisabled) && (
                <>
                  <div className="setting-item">
                    <label htmlFor="positionPrecisionBits">
                      {t('trafficmanagement_config.position_precision_bits', 'Precision Bits (0-32)')}
                      <span className="setting-description">{t('trafficmanagement_config.position_precision_bits_description', 'Number of bits of precision (geohash) for position dedup. More bits = finer granularity.')}</span>
                    </label>
                    <input
                      id="positionPrecisionBits"
                      type="range"
                      min="0"
                      max="32"
                      value={positionPrecisionBits}
                      onChange={(e) => setPositionPrecisionBits(parseInt(e.target.value) || 0)}
                      disabled={isDisabled}
                      className="setting-input"
                      style={{ width: '100%' }}
                    />
                    <div style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
                      {t('trafficmanagement_config.position_precision_bits_value', '{{bits}} bits', { bits: positionPrecisionBits })}
                    </div>
                  </div>

                  <div className="setting-item">
                    <label htmlFor="positionMinIntervalSecs">
                      {t('trafficmanagement_config.position_min_interval_secs', 'Minimum Interval (seconds)')}
                      <span className="setting-description">{t('trafficmanagement_config.position_min_interval_secs_description', 'Minimum seconds between position updates from the same node')}</span>
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
                </>
              )}
            </div>

            {/* NodeInfo Direct Response Group */}
            <div style={subGroupStyle}>
              <div style={subGroupTitleStyle}>{t('trafficmanagement_config.nodeinfo_direct_response', 'NodeInfo Direct Response')}</div>

              <div className="setting-item">
                <label htmlFor="nodeinfoDirectResponse" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="nodeinfoDirectResponse"
                    type="checkbox"
                    checked={nodeinfoDirectResponse}
                    onChange={(e) => setNodeinfoDirectResponse(e.target.checked)}
                    disabled={isDisabled}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('trafficmanagement_config.nodeinfo_direct_response_enabled', 'Enable')}</div>
                    <span className="setting-description">{t('trafficmanagement_config.nodeinfo_direct_response_enabled_description', 'Respond directly to NodeInfo requests from local cache')}</span>
                  </div>
                </label>
              </div>

              {(nodeinfoDirectResponse || isDisabled) && (
                <div className="setting-item">
                  <label htmlFor="nodeinfoDirectResponseMaxHops">
                    {t('trafficmanagement_config.nodeinfo_max_hops', 'Max Hops')}
                    <span className="setting-description">{t('trafficmanagement_config.nodeinfo_max_hops_description', 'Minimum hop distance from requestor before responding from cache')}</span>
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
                    <span className="setting-description">{t('trafficmanagement_config.rate_limit_enabled_description', 'Throttle chatty nodes')}</span>
                  </div>
                </label>
              </div>

              {(rateLimitEnabled || isDisabled) && (
                <>
                  <div className="setting-item">
                    <label htmlFor="rateLimitWindowSecs">
                      {t('trafficmanagement_config.rate_limit_window', 'Window (seconds)')}
                      <span className="setting-description">{t('trafficmanagement_config.rate_limit_window_description', 'Time window for rate limiting calculations')}</span>
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
                      <span className="setting-description">{t('trafficmanagement_config.rate_limit_max_packets_description', 'Maximum packets allowed per node within the window')}</span>
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
                </>
              )}
            </div>

            {/* Drop Unknown Group */}
            <div style={subGroupStyle}>
              <div style={subGroupTitleStyle}>{t('trafficmanagement_config.drop_unknown', 'Drop Unknown Packets')}</div>

              <div className="setting-item">
                <label htmlFor="dropUnknownEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="dropUnknownEnabled"
                    type="checkbox"
                    checked={dropUnknownEnabled}
                    onChange={(e) => setDropUnknownEnabled(e.target.checked)}
                    disabled={isDisabled}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('trafficmanagement_config.drop_unknown_enabled', 'Enable')}</div>
                    <span className="setting-description">{t('trafficmanagement_config.drop_unknown_enabled_description', 'Drop unknown/undecryptable packets after threshold')}</span>
                  </div>
                </label>
              </div>

              {(dropUnknownEnabled || isDisabled) && (
                <div className="setting-item">
                  <label htmlFor="unknownPacketThreshold">
                    {t('trafficmanagement_config.unknown_packet_threshold', 'Unknown Packet Threshold')}
                    <span className="setting-description">{t('trafficmanagement_config.unknown_packet_threshold_description', 'Number of unknown packets from a node before dropping')}</span>
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
              )}
            </div>

            {/* Hop Limit Exhaustion Group */}
            <div style={subGroupStyle}>
              <div style={subGroupTitleStyle}>{t('trafficmanagement_config.hop_exhaustion', 'Hop Limit Exhaustion')}</div>

              <div className="setting-item">
                <label htmlFor="exhaustHopTelemetry" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="exhaustHopTelemetry"
                    type="checkbox"
                    checked={exhaustHopTelemetry}
                    onChange={(e) => setExhaustHopTelemetry(e.target.checked)}
                    disabled={isDisabled}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('trafficmanagement_config.exhaust_hop_telemetry', 'Exhaust Hop Limit on Relayed Telemetry')}</div>
                    <span className="setting-description">{t('trafficmanagement_config.exhaust_hop_telemetry_description', 'Set hop_limit=0 on relayed telemetry broadcasts (own packets unaffected)')}</span>
                  </div>
                </label>
              </div>

              <div className="setting-item">
                <label htmlFor="exhaustHopPosition" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="exhaustHopPosition"
                    type="checkbox"
                    checked={exhaustHopPosition}
                    onChange={(e) => setExhaustHopPosition(e.target.checked)}
                    disabled={isDisabled}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('trafficmanagement_config.exhaust_hop_position', 'Exhaust Hop Limit on Relayed Positions')}</div>
                    <span className="setting-description">{t('trafficmanagement_config.exhaust_hop_position_description', 'Set hop_limit=0 on relayed position broadcasts (own packets unaffected)')}</span>
                  </div>
                </label>
              </div>

              <div className="setting-item">
                <label htmlFor="routerPreserveHops" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="routerPreserveHops"
                    type="checkbox"
                    checked={routerPreserveHops}
                    onChange={(e) => setRouterPreserveHops(e.target.checked)}
                    disabled={isDisabled}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('trafficmanagement_config.router_preserve_hops', 'Router Preserve Hops')}</div>
                    <span className="setting-description">{t('trafficmanagement_config.router_preserve_hops_description', 'Preserve hop_limit for router-to-router traffic')}</span>
                  </div>
                </label>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default TrafficManagementConfigSection;
