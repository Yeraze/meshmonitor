import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';
import { MODEM_PRESET_OPTIONS, REGION_OPTIONS } from './constants';

/**
 * MeshBeacon module config editor (firmware 2.8+, issue #3854).
 *
 * MeshBeacon lets a node periodically broadcast a short text message plus an
 * optional "offer" — a channel, region, and modem preset advertising another
 * mesh. Listening nodes deliver the text to their inbox and cache the offer for
 * the client app; firmware never auto-applies it.
 *
 * The wire message packs listen/broadcast/legacy-split into one `flags`
 * bitfield; this component works in three booleans and the parent packs them
 * (see packMeshBeaconFlags in admin-commands/useAdminCommandsState).
 */
interface MeshBeaconConfigSectionProps {
  listenEnabled: boolean;
  setListenEnabled: (value: boolean) => void;
  broadcastEnabled: boolean;
  setBroadcastEnabled: (value: boolean) => void;
  legacySplit: boolean;
  setLegacySplit: (value: boolean) => void;
  broadcastMessage: string;
  setBroadcastMessage: (value: string) => void;
  broadcastSendAsNode: number;
  setBroadcastSendAsNode: (value: number) => void;
  broadcastOfferChannelName: string;
  setBroadcastOfferChannelName: (value: string) => void;
  broadcastOfferChannelPsk: string;
  setBroadcastOfferChannelPsk: (value: string) => void;
  broadcastOfferRegion: number;
  setBroadcastOfferRegion: (value: number) => void;
  /** null = advertise no preset (the proto field is `optional`). */
  broadcastOfferPreset: number | null;
  setBroadcastOfferPreset: (value: number | null) => void;
  isDisabled: boolean;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

/** Firmware caps the beacon text at 100 bytes on send. */
const MESSAGE_MAX_BYTES = 100;

const MeshBeaconConfigSection: React.FC<MeshBeaconConfigSectionProps> = ({
  listenEnabled,
  setListenEnabled,
  broadcastEnabled,
  setBroadcastEnabled,
  legacySplit,
  setLegacySplit,
  broadcastMessage,
  setBroadcastMessage,
  broadcastSendAsNode,
  setBroadcastSendAsNode,
  broadcastOfferChannelName,
  setBroadcastOfferChannelName,
  broadcastOfferChannelPsk,
  setBroadcastOfferChannelPsk,
  broadcastOfferRegion,
  setBroadcastOfferRegion,
  broadcastOfferPreset,
  setBroadcastOfferPreset,
  isDisabled,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  const initialValuesRef = useRef({
    listenEnabled, broadcastEnabled, legacySplit, broadcastMessage,
    broadcastSendAsNode, broadcastOfferChannelName, broadcastOfferChannelPsk,
    broadcastOfferRegion, broadcastOfferPreset
  });

  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      listenEnabled !== initial.listenEnabled ||
      broadcastEnabled !== initial.broadcastEnabled ||
      legacySplit !== initial.legacySplit ||
      broadcastMessage !== initial.broadcastMessage ||
      broadcastSendAsNode !== initial.broadcastSendAsNode ||
      broadcastOfferChannelName !== initial.broadcastOfferChannelName ||
      broadcastOfferChannelPsk !== initial.broadcastOfferChannelPsk ||
      broadcastOfferRegion !== initial.broadcastOfferRegion ||
      broadcastOfferPreset !== initial.broadcastOfferPreset
    );
  }, [listenEnabled, broadcastEnabled, legacySplit, broadcastMessage,
    broadcastSendAsNode, broadcastOfferChannelName, broadcastOfferChannelPsk,
    broadcastOfferRegion, broadcastOfferPreset]);

  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setListenEnabled(initial.listenEnabled);
    setBroadcastEnabled(initial.broadcastEnabled);
    setLegacySplit(initial.legacySplit);
    setBroadcastMessage(initial.broadcastMessage);
    setBroadcastSendAsNode(initial.broadcastSendAsNode);
    setBroadcastOfferChannelName(initial.broadcastOfferChannelName);
    setBroadcastOfferChannelPsk(initial.broadcastOfferChannelPsk);
    setBroadcastOfferRegion(initial.broadcastOfferRegion);
    setBroadcastOfferPreset(initial.broadcastOfferPreset);
  }, [setListenEnabled, setBroadcastEnabled, setLegacySplit, setBroadcastMessage,
    setBroadcastSendAsNode, setBroadcastOfferChannelName, setBroadcastOfferChannelPsk,
    setBroadcastOfferRegion, setBroadcastOfferPreset]);

  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      listenEnabled, broadcastEnabled, legacySplit, broadcastMessage,
      broadcastSendAsNode, broadcastOfferChannelName, broadcastOfferChannelPsk,
      broadcastOfferRegion, broadcastOfferPreset
    };
  }, [onSave, listenEnabled, broadcastEnabled, legacySplit, broadcastMessage,
    broadcastSendAsNode, broadcastOfferChannelName, broadcastOfferChannelPsk,
    broadcastOfferRegion, broadcastOfferPreset]);

  const messageBytes = useMemo(
    () => new TextEncoder().encode(broadcastMessage).length,
    [broadcastMessage]
  );
  const messageTooLong = messageBytes > MESSAGE_MAX_BYTES;

  useSaveBar({
    id: 'meshbeacon-config',
    sectionName: t('meshbeacon_config.title', 'MeshBeacon'),
    // Block the save bar on an over-length message rather than letting the
    // server 400 it — the byte count is right next to the field.
    hasChanges: hasChanges && !isDisabled && !messageTooLong,
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
        {t('meshbeacon_config.title', 'MeshBeacon')}
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
          {t('meshbeacon_config.unsupported', 'Unsupported by this device — the MeshBeacon module is not in any released Meshtastic firmware yet (it is only on the development branch for 2.8). Saving here would not persist on the device. It requires firmware 2.8 or newer.')}
        </div>
      )}

      <div style={isDisabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
        {/* Listen */}
        <div className="setting-item">
          <label htmlFor="meshBeaconListenEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              id="meshBeaconListenEnabled"
              type="checkbox"
              checked={listenEnabled}
              onChange={(e) => setListenEnabled(e.target.checked)}
              disabled={isDisabled}
              style={{ marginTop: '0.2rem', flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('meshbeacon_config.listen_enabled', 'Listen for beacons')}</div>
              <span className="setting-description">{t('meshbeacon_config.listen_enabled_description', 'Receive beacons from other nodes. The text goes to the local inbox; any offered channel or preset is cached for you to act on — firmware never applies it automatically.')}</span>
            </div>
          </label>
        </div>

        {/* Broadcast */}
        <div className="setting-item">
          <label htmlFor="meshBeaconBroadcastEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              id="meshBeaconBroadcastEnabled"
              type="checkbox"
              checked={broadcastEnabled}
              onChange={(e) => setBroadcastEnabled(e.target.checked)}
              disabled={isDisabled}
              style={{ marginTop: '0.2rem', flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('meshbeacon_config.broadcast_enabled', 'Broadcast beacons')}</div>
              <span className="setting-description">{t('meshbeacon_config.broadcast_enabled_description', 'Periodically broadcast this node\'s beacon to the mesh.')}</span>
            </div>
          </label>
        </div>

        {(broadcastEnabled || isDisabled) && (
          <>
            <div style={subGroupStyle}>
              <div style={subGroupTitleStyle}>{t('meshbeacon_config.broadcast_section', 'Broadcast Content')}</div>

              <div className="setting-item">
                <label htmlFor="meshBeaconBroadcastMessage">{t('meshbeacon_config.broadcast_message', 'Beacon Message')}</label>
                <input
                  id="meshBeaconBroadcastMessage"
                  type="text"
                  value={broadcastMessage}
                  onChange={(e) => setBroadcastMessage(e.target.value)}
                  disabled={isDisabled}
                  className="setting-input"
                  placeholder={t('meshbeacon_config.broadcast_message_placeholder', 'e.g. Welcome to the local mesh')}
                />
                <span
                  className="setting-description"
                  style={messageTooLong ? { color: 'var(--color-danger)' } : undefined}
                >
                  {t('meshbeacon_config.broadcast_message_desc', 'Human-readable text sent with each beacon.')}
                  {' '}
                  {t('meshbeacon_config.broadcast_message_count', '{{used}}/{{max}} bytes used', {
                    used: messageBytes,
                    max: MESSAGE_MAX_BYTES
                  })}
                </span>
              </div>

              <div className="setting-item">
                <label htmlFor="meshBeaconLegacySplit" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="meshBeaconLegacySplit"
                    type="checkbox"
                    checked={legacySplit}
                    onChange={(e) => setLegacySplit(e.target.checked)}
                    disabled={isDisabled}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('meshbeacon_config.legacy_split', 'Legacy split')}</div>
                    <span className="setting-description">{t('meshbeacon_config.legacy_split_desc', 'Send the text and the offer as two packets, so nodes that only decode text messages still see the text. Costs one extra transmission per beacon.')}</span>
                  </div>
                </label>
              </div>

              <div className="setting-item">
                <label htmlFor="meshBeaconSendAsNode">{t('meshbeacon_config.send_as_node', 'Send As Node')}</label>
                <input
                  id="meshBeaconSendAsNode"
                  type="number"
                  min="0"
                  value={broadcastSendAsNode}
                  onChange={(e) => setBroadcastSendAsNode(parseInt(e.target.value) || 0)}
                  disabled={isDisabled}
                  className="setting-input"
                />
                <span className="setting-description">{t('meshbeacon_config.send_as_node_desc', 'Node number to send beacons as. 0 sends them as this node. A remote admin may only set this to their own node ID.')}</span>
              </div>
            </div>

            <div style={subGroupStyle}>
              <div style={subGroupTitleStyle}>{t('meshbeacon_config.offer_section', 'Offered Network (optional)')}</div>

              <div className="setting-item">
                <label htmlFor="meshBeaconOfferChannelName">{t('meshbeacon_config.offer_channel_name', 'Offer Channel Name')}</label>
                <input
                  id="meshBeaconOfferChannelName"
                  type="text"
                  value={broadcastOfferChannelName}
                  onChange={(e) => setBroadcastOfferChannelName(e.target.value)}
                  disabled={isDisabled}
                  className="setting-input"
                />
                <span className="setting-description">{t('meshbeacon_config.offer_channel_name_desc', 'Channel advertised to listeners. Leave blank to advertise no channel.')}</span>
              </div>

              {broadcastOfferChannelName.trim().length > 0 && (
                <div className="setting-item">
                  <label htmlFor="meshBeaconOfferChannelPsk">{t('meshbeacon_config.offer_channel_psk', 'Offer Channel PSK')}</label>
                  <input
                    id="meshBeaconOfferChannelPsk"
                    type="text"
                    value={broadcastOfferChannelPsk}
                    onChange={(e) => setBroadcastOfferChannelPsk(e.target.value)}
                    disabled={isDisabled}
                    className="setting-input"
                    placeholder={t('meshbeacon_config.offer_channel_psk_placeholder', 'base64, e.g. AQ==')}
                  />
                  <span className="setting-description">{t('meshbeacon_config.offer_channel_psk_desc', 'Base64 pre-shared key for the advertised channel. Anyone receiving the beacon can read this key.')}</span>
                </div>
              )}

              <div className="setting-item">
                <label htmlFor="meshBeaconOfferRegion">{t('meshbeacon_config.offer_region', 'Offer Region')}</label>
                <select
                  id="meshBeaconOfferRegion"
                  value={broadcastOfferRegion}
                  onChange={(e) => setBroadcastOfferRegion(parseInt(e.target.value) || 0)}
                  disabled={isDisabled}
                  className="setting-input"
                >
                  {REGION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <span className="setting-description">{t('meshbeacon_config.offer_region_desc', 'Region advertised alongside the preset.')}</span>
              </div>

              <div className="setting-item">
                <label htmlFor="meshBeaconOfferPreset">{t('meshbeacon_config.offer_preset', 'Offer Modem Preset')}</label>
                <select
                  id="meshBeaconOfferPreset"
                  value={broadcastOfferPreset === null ? '' : broadcastOfferPreset}
                  onChange={(e) => setBroadcastOfferPreset(e.target.value === '' ? null : parseInt(e.target.value))}
                  disabled={isDisabled}
                  className="setting-input"
                >
                  {/* Distinct from LONG_FAST (0): the proto field is optional, so
                      "none" and "LONG_FAST" say different things to listeners. */}
                  <option value="">{t('meshbeacon_config.offer_preset_none', 'None — advertise no preset')}</option>
                  {MODEM_PRESET_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.name} — {option.description}</option>
                  ))}
                </select>
                <span className="setting-description">{t('meshbeacon_config.offer_preset_desc', 'Modem preset advertised with the region — tells listeners "there is a mesh on this preset".')}</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default MeshBeaconConfigSection;
