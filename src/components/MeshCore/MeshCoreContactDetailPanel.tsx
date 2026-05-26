import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { formatRelativeTime } from '../../utils/datetime';
import { useSettings } from '../../contexts/SettingsContext';
import { MeshCoreRemoteConsole } from './MeshCoreRemoteConsole';
import type { MeshCoreActions, TracePathResult } from './hooks/useMeshCore';
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
  /** Manually push a forwarding route into the device's contact record
   *  via CMD_ADD_UPDATE_CONTACT. `outPath` is a comma-separated hex chain
   *  ("a3,7f,02"). Unset OR `advancedPathEditEnabled=false` hides the
   *  Edit Path… button. */
  onSetOutPath?: (publicKey: string, outPath: string) => Promise<boolean>;
  /** Send a trace-path diagnostic along the contact's cached path and
   *  return per-hop SNR data. Unset hides the Trace Path button. */
  onTracePath?: (publicKey: string) => Promise<TracePathResult | null>;
  /** Whether the current user may invoke write actions on this source's
   *  `nodes` resource. Required to gate the Reset Path / Share / Edit
   *  buttons. */
  canWriteNodes?: boolean;
  /** Is the source's device a Companion? Reset Path / Share Contact /
   *  manual edit are all companion-only. Defaults to `true` so callers
   *  that don't pass this still see the buttons when handlers are
   *  supplied. */
  isCompanion?: boolean;
  /** Server-side gated advanced toggle (settings.meshcoreAdvancedPathEdit).
   *  When false the Edit Path… button is hidden even if onSetOutPath is
   *  supplied. The server route also enforces this for defense in depth. */
  advancedPathEditEnabled?: boolean;
  /** When provided AND the contact is a Repeater (advType=2) or Room
   *  Server (advType=3), the remote-administration console is mounted
   *  below the details block. Pass the four hook actions it needs; leave
   *  unset to hide the console (e.g. on read-only sources). */
  remoteAdminActions?: Pick<
    MeshCoreActions,
    | 'loginRemote'
    | 'loginRemoteWithSaved'
    | 'sendCliCommand'
    | 'getRemoteAdminCapability'
    | 'forgetRemoteCredential'
    | 'getRemoteStatus'
  >;
  /** Whether the current user may invoke write actions on this source's
   *  `remote_admin` resource. When false the console is hidden even if
   *  `remoteAdminActions` is supplied. */
  canRemoteAdmin?: boolean;
}

const COLLAPSED_KEY = 'meshcoreContactDetailsCollapsed';

export const MeshCoreContactDetailPanel: React.FC<MeshCoreContactDetailPanelProps> = ({
  contact,
  publicKey,
  onResetPath,
  onShareContact,
  onSetOutPath,
  onTracePath,
  canWriteNodes = false,
  isCompanion = true,
  advancedPathEditEnabled = false,
  remoteAdminActions,
  canRemoteAdmin = false,
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

  // Trace-path state
  const [tracing, setTracing] = useState(false);
  const [traceResult, setTraceResult] = useState<TracePathResult | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);

  // Path-editor modal state. Only mounted when advancedPathEditEnabled.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorDraft, setEditorDraft] = useState('');
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

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
    setEditorOpen(false);
    setEditorError(null);
    setEditorSaving(false);
    setTracing(false);
    setTraceResult(null);
    setTraceError(null);
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
  const canShowEditButton =
    !!onSetOutPath && canWriteNodes && isCompanion && advancedPathEditEnabled;
  const canShowTraceButton =
    !!onTracePath && canWriteNodes && isCompanion && pathKnown && pathLen! > 0;

  const handleTracePath = async () => {
    if (!onTracePath || tracing) return;
    setTracing(true);
    setTraceError(null);
    setTraceResult(null);
    try {
      const result = await onTracePath(publicKey);
      if (result) {
        setTraceResult(result);
      } else {
        setTraceError(
          t('meshcore.contact_details.trace_path_error', 'Trace path failed or timed out.'),
        );
      }
    } finally {
      setTracing(false);
    }
  };

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

  const openEditor = () => {
    setEditorDraft(outPath ?? '');
    setEditorError(null);
    setEditorOpen(true);
  };

  const HEX_PATH_REGEX = /^\s*([0-9a-fA-F]{1,2})(\s*,\s*[0-9a-fA-F]{1,2})*\s*$/;

  const handleSaveEditor = async () => {
    if (!onSetOutPath || editorSaving) return;
    const draft = editorDraft.trim();
    if (draft !== '' && !HEX_PATH_REGEX.test(draft)) {
      setEditorError(
        t(
          'meshcore.contact_details.edit_path_invalid',
          'Path must be comma-separated hex bytes, e.g. "a3,7f,02" (max 64).',
        ),
      );
      return;
    }
    const hopCount = draft === '' ? 0 : draft.split(',').length;
    if (hopCount > 64) {
      setEditorError(
        t(
          'meshcore.contact_details.edit_path_too_long',
          `Path too long: ${hopCount} hops (max 64).`,
        ),
      );
      return;
    }
    setEditorSaving(true);
    setEditorError(null);
    try {
      const ok = await onSetOutPath(publicKey, draft);
      if (!ok) {
        setEditorError(
          t('meshcore.contact_details.edit_path_save_failed', 'Save failed.'),
        );
      } else {
        setEditorOpen(false);
      }
    } finally {
      setEditorSaving(false);
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
          {(canShowResetButton || canShowShareButton || canShowEditButton || canShowTraceButton) &&
            (canShowShareButton || canShowEditButton || canShowTraceButton || pathKnown) && (
            <div className="node-detail-card node-detail-card-2col">
              <div className="node-detail-label">
                {t('meshcore.contact_details.actions_label', 'Actions')}
              </div>
              <div className="node-detail-value" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                {canShowResetButton && pathKnown && (
                  <button
                    type="button"
                    className="btn-secondary"
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
                    className="btn-secondary"
                    onClick={handleShareContact}
                    disabled={sharing}
                    aria-label={t('meshcore.contact_details.share_contact_button', 'Share Contact')}
                  >
                    {sharing
                      ? t('meshcore.contact_details.share_contact_running', 'Sharing…')
                      : t('meshcore.contact_details.share_contact_button', 'Share Contact')}
                  </button>
                )}
                {canShowEditButton && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={openEditor}
                    aria-label={t('meshcore.contact_details.edit_path_button', 'Edit Path…')}
                  >
                    {t('meshcore.contact_details.edit_path_button', 'Edit Path…')}
                  </button>
                )}
                {canShowTraceButton && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleTracePath}
                    disabled={tracing}
                    aria-label={t('meshcore.contact_details.trace_path_button', 'Trace Path')}
                  >
                    {tracing
                      ? t('meshcore.contact_details.trace_path_running', 'Tracing…')
                      : t('meshcore.contact_details.trace_path_button', 'Trace Path')}
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
                {traceError && (
                  <span style={{ color: 'var(--ctp-red)' }} role="alert">{traceError}</span>
                )}
              </div>
            </div>
          )}

          {/* Trace Path results */}
          {traceResult && (
            <div className="node-detail-card node-detail-card-2col">
              <div className="node-detail-label">
                {t('meshcore.contact_details.trace_path_results', 'Trace Path Results')}
              </div>
              <div className="node-detail-value">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono, monospace)', fontSize: '0.9em' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--ctp-surface1, #45475a)' }}>
                      <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>
                        {t('meshcore.contact_details.trace_hop', 'Hop')}
                      </th>
                      <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>
                        {t('meshcore.contact_details.trace_hash', 'Hash')}
                      </th>
                      <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem' }}>
                        {t('meshcore.contact_details.trace_snr', 'SNR')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {traceResult.hops.map((hop) => {
                      const pathHashes = outPath?.split(',') ?? [];
                      return (
                        <tr key={hop.index}>
                          <td style={{ padding: '0.25rem 0.5rem' }}>{hop.index + 1}</td>
                          <td style={{ padding: '0.25rem 0.5rem' }}>{pathHashes[hop.index] ?? '??'}</td>
                          <td style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}
                              className={getSignalClass(hop.snr)}>
                            {hop.snr.toFixed(2)} dB
                          </td>
                        </tr>
                      );
                    })}
                    <tr style={{ borderTop: '1px solid var(--ctp-surface1, #45475a)' }}>
                      <td style={{ padding: '0.25rem 0.5rem' }} colSpan={2}>
                        {t('meshcore.contact_details.trace_destination', 'Destination')}
                      </td>
                      <td style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}
                          className={getSignalClass(traceResult.lastSnr)}>
                        {traceResult.lastSnr.toFixed(2)} dB
                      </td>
                    </tr>
                  </tbody>
                </table>
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

      {editorOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('meshcore.contact_details.edit_path_dialog_title', 'Edit forwarding path')}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget && !editorSaving) setEditorOpen(false); }}
        >
          <div
            style={{
              background: 'var(--ctp-base, #1e1e2e)',
              color: 'var(--ctp-text, #cdd6f4)',
              padding: '1.25rem 1.5rem',
              borderRadius: '8px',
              maxWidth: '32rem',
              width: '90%',
              boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            }}
          >
            <h3 style={{ marginTop: 0 }}>
              {t('meshcore.contact_details.edit_path_dialog_title', 'Edit forwarding path')}
            </h3>
            <p style={{ marginBottom: '0.75rem' }}>
              {t(
                'meshcore.contact_details.edit_path_dialog_hint',
                'Enter the new hop chain as comma-separated hex bytes (e.g. "a3,7f,02"). Each byte is one hop hash; 0..64 bytes total. Leave empty to set a zero-hop direct path.',
              )}
            </p>
            <div
              style={{
                background: 'var(--ctp-surface0, #313244)',
                color: 'var(--ctp-yellow, #f9e2af)',
                padding: '0.6rem 0.8rem',
                borderRadius: '4px',
                marginBottom: '0.75rem',
                fontSize: '0.9em',
              }}
              role="alert"
            >
              {t(
                'meshcore.contact_details.edit_path_warning',
                'Manual paths bypass auto-discovery. Stale hops silently drop direct sends until the next flood. Use "Reset Path" instead if you just want to re-discover.',
              )}
            </div>
            <label style={{ display: 'block', marginBottom: '0.5rem' }}>
              {t('meshcore.contact_details.edit_path_label', 'New path (hex chain):')}
            </label>
            <input
              type="text"
              value={editorDraft}
              onChange={(e) => setEditorDraft(e.target.value)}
              disabled={editorSaving}
              placeholder="a3,7f,02"
              style={{
                width: '100%',
                padding: '0.5rem',
                marginBottom: '0.5rem',
                fontFamily: 'var(--font-mono, monospace)',
                boxSizing: 'border-box',
              }}
              autoFocus
            />
            <div style={{ fontSize: '0.85em', opacity: 0.8, marginBottom: '0.75rem' }}>
              {editorDraft.trim() === ''
                ? t('meshcore.contact_details.edit_path_zero_hops', '0 hops (direct path)')
                : t('meshcore.contact_details.edit_path_hop_count', { count: editorDraft.trim().split(',').length })}
            </div>
            {editorError && (
              <div style={{ color: 'var(--ctp-red)', marginBottom: '0.75rem' }} role="alert">
                {editorError}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setEditorOpen(false)}
                disabled={editorSaving}
              >
                {t('meshcore.contact_details.edit_path_cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleSaveEditor}
                disabled={editorSaving}
              >
                {editorSaving
                  ? t('meshcore.contact_details.edit_path_saving', 'Saving…')
                  : t('meshcore.contact_details.edit_path_save', 'Save Path')}
              </button>
            </div>
          </div>
        </div>
      )}

      {remoteAdminActions
        && canRemoteAdmin
        && isCompanion
        && (advType === 2 || advType === 3) && (
        <MeshCoreRemoteConsole
          publicKey={publicKey}
          contactName={name}
          actions={remoteAdminActions}
        />
      )}
    </div>
  );
};
