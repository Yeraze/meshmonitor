import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { formatRelativeTime } from '../../utils/datetime';
import { useSettings } from '../../contexts/SettingsContext';
import '../NodeDetailsBlock.css';

const DEVICE_TYPE_KEYS: Record<number, string> = {
  0: 'meshcore.device_type.unknown',
  1: 'meshcore.device_type.companion',
  2: 'meshcore.device_type.repeater',
  3: 'meshcore.device_type.room_server',
};

interface MeshCoreContactDetailPanelProps {
  contact: MeshCoreContact | null;
  publicKey: string;
}

const COLLAPSED_KEY = 'meshcoreContactDetailsCollapsed';

export const MeshCoreContactDetailPanel: React.FC<MeshCoreContactDetailPanelProps> = ({
  contact,
  publicKey,
}) => {
  const { t } = useTranslation();
  const { timeFormat, dateFormat } = useSettings();
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  });

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, isCollapsed.toString());
  }, [isCollapsed]);

  const name = contact?.advName || contact?.name || `${publicKey.substring(0, 8)}…`;
  const advType = contact?.advType;
  const rssi = contact?.rssi;
  const snr = contact?.snr;
  const lastSeen = contact?.lastSeen;
  const lastAdvert = contact?.lastAdvert;
  const pathLen = contact?.pathLen;
  const latitude = contact?.latitude;
  const longitude = contact?.longitude;
  const hasPosition = typeof latitude === 'number' && typeof longitude === 'number';

  const getSignalClass = (value: number | undefined): string => {
    if (value === undefined || value === null) return '';
    if (value > 10) return 'signal-good';
    if (value > 0) return 'signal-medium';
    return 'signal-low';
  };

  const formatTimestamp = (ts: number | undefined): string | null => {
    if (ts === undefined || ts === null) return null;
    return formatRelativeTime(ts, timeFormat, dateFormat, false);
  };

  return (
    <div className="node-details-block meshcore-contact-detail-panel">
      <div className="node-details-header">
        <h3 className="node-details-title">
          {t('meshcore.contact_details.title', 'Contact Details')}
        </h3>
        <button
          className="node-details-toggle"
          onClick={() => setIsCollapsed(prev => !prev)}
          aria-label={isCollapsed
            ? t('meshcore.contact_details.expand', 'Expand contact details')
            : t('meshcore.contact_details.collapse', 'Collapse contact details')}
        >
          {isCollapsed ? '▼' : '▲'}
        </button>
      </div>
      {!isCollapsed && (
        <div className="node-details-grid">
          {/* Name */}
          <div className="node-detail-card">
            <div className="node-detail-label">
              {t('meshcore.contact_details.name', 'Name')}
            </div>
            <div className="node-detail-value">{name}</div>
          </div>

          {/* Contact / Device Type */}
          {typeof advType === 'number' && (
            <div className="node-detail-card">
              <div className="node-detail-label">
                {t('meshcore.contact_details.type', 'Contact Type')}
              </div>
              <div className="node-detail-value">
                {t(DEVICE_TYPE_KEYS[advType] || 'meshcore.device_type.unknown', 'Unknown')}
              </div>
            </div>
          )}

          {/* Path length (hops) */}
          {typeof pathLen === 'number' && (
            <div className="node-detail-card">
              <div className="node-detail-label">
                {t('meshcore.contact_details.hops_away', 'Hops Away')}
              </div>
              <div className="node-detail-value">
                {pathLen === 0
                  ? t('node_details.direct', 'Direct')
                  : t('node_details.hops', { count: pathLen })}
              </div>
            </div>
          )}

          {/* RSSI */}
          {typeof rssi === 'number' && (
            <div className="node-detail-card">
              <div className="node-detail-label">{t('node_details.signal_rssi', 'Signal (RSSI)')}</div>
              <div className="node-detail-value">{`${rssi} dBm`}</div>
            </div>
          )}

          {/* SNR */}
          {typeof snr === 'number' && (
            <div className="node-detail-card">
              <div className="node-detail-label">{t('node_details.signal_snr', 'Signal (SNR)')}</div>
              <div className={`node-detail-value ${getSignalClass(snr)}`}>
                {`${snr.toFixed(1)} dB`}
              </div>
            </div>
          )}

          {/* Last Seen */}
          {typeof lastSeen === 'number' && (
            <div className="node-detail-card">
              <div className="node-detail-label">{t('node_details.last_heard', 'Last Heard')}</div>
              <div className="node-detail-value">{formatTimestamp(lastSeen)}</div>
            </div>
          )}

          {/* Last Advert */}
          {typeof lastAdvert === 'number' && (
            <div className="node-detail-card">
              <div className="node-detail-label">
                {t('meshcore.contact_details.last_advert', 'Last Advert')}
              </div>
              <div className="node-detail-value">
                {formatTimestamp(
                  // lastAdvert is delivered in seconds; convert to ms.
                  lastAdvert < 1e12 ? lastAdvert * 1000 : lastAdvert,
                )}
              </div>
            </div>
          )}

          {/* Position */}
          {hasPosition && (
            <div className="node-detail-card">
              <div className="node-detail-label">
                {t('meshcore.contact_details.position', 'Position')}
              </div>
              <div className="node-detail-value">
                {`${latitude!.toFixed(5)}, ${longitude!.toFixed(5)}`}
              </div>
            </div>
          )}

          {/* Public Key */}
          <div className="node-detail-card node-detail-card-2col">
            <div className="node-detail-label">{t('meshcore.public_key', 'Public Key')}</div>
            <div className="node-detail-value node-detail-public-key" title={publicKey}>
              {publicKey}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
