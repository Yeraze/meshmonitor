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
  /** Trigger CMD_RESET_PATH for this contact. Provided by the parent's
   *  MeshCoreActions; unset means the button is hidden (e.g. read-only
   *  embeds that don't have the actions wired up). */
  onResetPath?: (publicKey: string) => Promise<boolean>;
  /** Trigger CMD_SHARE_CONTACT for this contact, broadcasting their saved
   *  advert to nearby nodes. Unset hides the Share button. */
  onShareContact?: (publicKey: string) => Promise<boolean>;
  /** Whether the current user may invoke write actions on this source's
   *  `nodes` resource. Required to gate the Reset Path / Share buttons. */
  canWriteNodes?: boolean;
  /** Is the source's device a Companion? Both Reset Path and Share Contact
   *  are companion-only (CMD_RESET_PATH / CMD_SHARE_CONTACT aren't supported
   *  by Repeater firmware). Defaults to `true` so callers that don't pass
   *  this still see the buttons when the action handlers are supplied. */
  isCompanion?: boolean;
}

const COLLAPSED_KEY = 'meshcoreContactDetailsCollapsed';

export const MeshCoreContactDetailPanel: React.FC<MeshCoreContactDetailPanelProps> = ({
  contact,
  publicKey,
  onResetPath,
  onShareContact,
  canWriteNodes = false,
  isCompanion = true,
}) => {
  const { t } = useTranslation();
  const { timeFormat, dateFormat } = useSettings();
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  });
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareSuccess, setShareSuccess] = useState(false);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, isCollapsed.toString());
  }, [isCollapsed]);

  // Clear transient action state when the selected contact changes so a
  // previous failure / success doesn't bleed into a new node.
  useEffect(() => {
    setResetError(null);
    setResetting(false);
    setShareError(null);
    setSharing(false);
    setShareSuccess(false);
  }, [publicKey]);

  const name = contact?.advName || contact?.name || `${publicKey.substring(0, 8)}…`;
  const advType = contact?.advType;
  const rssi = contact?.rssi;
  const snr = contact?.snr;
  const lastSeen = contact?.lastSeen;
  const lastAdvert = contact?.lastAdvert;
  const pathLen = contact?.pathLen;
  const outPath = contact?.outPath;
  const latitude = contact?.latitude;
  const longitude = contact?.longitude;
  const hasPosition = typeof latitude === 'number' && typeof longitude === 'number';
  const pathKnown = typeof pathLen === 'number' && pathLen !== null && pathLen >= 0;
  const canShowResetButton =
    !!onResetPath && canWriteNodes && isCompanion;
  const canShowShareButton =
    !!onShareContact && canWriteNodes && isCompanion;

  const handleResetPath = async () => {
    if (!onResetPath || resetting) return;
    const confirmMessage = t(
      'meshcore.contact_details.reset_path_confirm',
      `Clear the cached route to ${name}? The next send to this contact will rediscover the path via flooding.`,
    );
    if (typeof window !== 'undefined' && !window.confirm(confirmMessage)) {
      return;
    }
    setResetting(true);
    setResetError(null);
    try {
      const ok = await onResetPath(publicKey);
      if (!ok) {
        setResetError(
          t('meshcore.contact_details.reset_path_error', 'Reset path failed.'),
        );
      }
    } finally {
      setResetting(false);
    }
  };

  const handleShareContact = async () => {
    if (!onShareContact || sharing) return;
    const confirmMessage = t(
      'meshcore.contact_details.share_contact_confirm',
      `Broadcast ${name}'s contact info to nearby nodes? This sends a zero-hop advert with their identity, name and position.`,
    );
    if (typeof window !== 'undefined' && !window.confirm(confirmMessage)) {
      return;
    }
    setSharing(true);
    setShareError(null);
    setShareSuccess(false);
    try {
      const ok = await onShareContact(publicKey);
      if (ok) {
        setShareSuccess(true);
        window.setTimeout(() => setShareSuccess(false), 2200);
      } else {
        setShareError(
          t('meshcore.contact_details.share_contact_error', 'Share contact failed.'),
        );
      }
    } finally {
      setSharing(false);
    }
  };

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
          <div className="node-detail-card">
            <div className="node-detail-label">
              {t('meshcore.contact_details.hops_away', 'Hops Away')}
            </div>
            <div className="node-detail-value">
              {pathKnown
                ? (pathLen === 0
                  ? t('node_details.direct', 'Direct')
                  : t('node_details.hops', { count: pathLen as number }))
                : t('meshcore.contact_details.path_unknown', 'Unknown — next send will flood')}
            </div>
          </div>

          {/* Path bytes (hex chain). Show only when known so the panel
              stays compact for fresh contacts. */}
          {pathKnown && pathLen! > 0 && typeof outPath === 'string' && outPath.length > 0 && (
            <div className="node-detail-card node-detail-card-2col">
              <div className="node-detail-label">
                {t('meshcore.contact_details.path', 'Path')}
              </div>
              <div
                className="node-detail-value"
                title={outPath}
                style={{ fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all' }}
              >
                {outPath}
              </div>
            </div>
          )}

          {/* Contact actions — companion-only, write-permission-gated.
              Reset Path is hidden when the route is already unknown so
              users don't fire a no-op CMD_RESET_PATH; Share is always
              available because the device retransmits the stored advert
              regardless of route state. Rendered in one card so the
              actions stay grouped at the bottom of the grid. */}
          {(canShowResetButton || canShowShareButton) && (canShowShareButton || pathKnown) && (
            <div className="node-detail-card node-detail-card-2col">
              <div className="node-detail-label">
                {t('meshcore.contact_details.actions_label', 'Actions')}
              </div>
              <div className="node-detail-value" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                {canShowResetButton && pathKnown && (
                  <button
                    type="button"
                    onClick={handleResetPath}
                    disabled={resetting}
                    aria-label={t('meshcore.contact_details.reset_path_button', 'Reset Path')}
                  >
                    {resetting
                      ? t('meshcore.contact_details.reset_path_running', 'Resetting…')
                      : t('meshcore.contact_details.reset_path_button', 'Reset Path')}
                  </button>
                )}
                {canShowShareButton && (
                  <button
                    type="button"
                    onClick={handleShareContact}
                    disabled={sharing}
                    aria-label={t('meshcore.contact_details.share_contact_button', 'Share Contact')}
                  >
                    {sharing
                      ? t('meshcore.contact_details.share_contact_running', 'Sharing…')
                      : t('meshcore.contact_details.share_contact_button', 'Share Contact')}
                  </button>
                )}
                {resetError && (
                  <span style={{ color: 'var(--ctp-red)' }} role="alert">{resetError}</span>
                )}
                {shareError && (
                  <span style={{ color: 'var(--ctp-red)' }} role="alert">{shareError}</span>
                )}
                {shareSuccess && (
                  <span style={{ color: 'var(--ctp-green)' }} role="status">
                    {t('meshcore.contact_details.share_contact_success', 'Advert broadcast.')}
                  </span>
                )}
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
