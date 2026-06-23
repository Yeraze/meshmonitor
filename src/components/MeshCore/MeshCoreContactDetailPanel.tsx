import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import {
  parsePathHops,
  joinPathHops,
  pathHashBytesOf,
  repeaterHopOptions,
  resolveHop,
  type PathHop,
} from '../../utils/meshcorePath';
import { formatRelativeTime } from '../../utils/datetime';
import { useSettings } from '../../contexts/SettingsContext';
import { useSource } from '../../contexts/SourceContext';
import { MeshCoreRemoteConsole } from './MeshCoreRemoteConsole';
import type { MeshCoreActions, TracePathResult } from './hooks/useMeshCore';
import api from '../../services/api';
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
  onShareContact?: (publicKey: string) => Promise<{ ok: boolean; error?: string }>;
  /** Manually push a forwarding route into the device's contact record
   *  via CMD_ADD_UPDATE_CONTACT. `outPath` is a comma-separated hex chain
   *  ("a3,7f,02"). Unset hides the Define Path… button. */
  onSetOutPath?: (publicKey: string, outPath: string, hashBytes?: 1 | 2 | 3) => Promise<boolean>;
  /** Known contacts used to build a path by repeater name (the picker maps a
   *  repeater to its first-public-key-byte hop). Typically the full contact
   *  list; the panel filters to repeaters/room servers internally. */
  repeaters?: MeshCoreContact[];
  /** Send a trace-path diagnostic along the contact's cached path and
   *  return per-hop SNR data. Unset hides the Trace Path button. */
  onTracePath?: (publicKey: string) => Promise<TracePathResult | null>;
  /** Flood a path-discovery request to learn the forwarding route. The
   *  path update arrives asynchronously. Unset hides the button. */
  onDiscoverPath?: (publicKey: string) => Promise<boolean>;
  /** Whether the current user may invoke write actions on this source's
   *  `nodes` resource. Required to gate the Reset Path / Share / Edit
   *  buttons. */
  canWriteNodes?: boolean;
  /** Is the source's device a Companion? Reset Path / Share Contact /
   *  manual edit are all companion-only. Defaults to `true` so callers
   *  that don't pass this still see the buttons when handlers are
   *  supplied. */
  isCompanion?: boolean;
  /** Remove a contact from the device. Unset hides the Remove button. */
  onRemoveContact?: (publicKey: string) => Promise<boolean>;
  /** Export a contact as a signed advert blob. Unset hides the Export button. */
  onExportContact?: (publicKey: string) => Promise<number[] | null>;
  /** Query the neighbour list from a remote repeater. Unset hides the
   *  Neighbours button. */
  onGetNeighbours?: (publicKey: string, opts?: { count?: number }) => Promise<{
    total: number;
    neighbours: { publicKeyPrefix: string; heardSecondsAgo: number; snr: number }[];
  } | null>;
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
  repeaters,
  onTracePath,
  onDiscoverPath,
  onRemoveContact,
  onExportContact,
  onGetNeighbours,
  canWriteNodes = false,
  isCompanion = true,
  remoteAdminActions,
  canRemoteAdmin = false,
}) => {
  const { t } = useTranslation();
  const { timeFormat, dateFormat } = useSettings();
  const { sourceId } = useSource();
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
  const [discovering, setDiscovering] = useState(false);

  // Remove contact state
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Export contact state
  const [exporting, setExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);

  // Neighbours state
  const [neighboursLoading, setNeighboursLoading] = useState(false);
  const [neighboursData, setNeighboursData] = useState<{
    total: number;
    neighbours: { publicKeyPrefix: string; name?: string | null; heardSecondsAgo: number; snr: number }[];
    fetchedAt?: number;
  } | null>(null);

  // Path-editor modal state. The hop chain is built by repeater name; each
  // hop is a 1-byte hex routing hash.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorHops, setEditorHops] = useState<PathHop[]>([]);
  const [editorHashBytes, setEditorHashBytes] = useState<1 | 2 | 3>(1);
  const [customByte, setCustomByte] = useState('');
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
    setDiscovering(false);
    setRemoving(false);
    setRemoveError(null);
    setExporting(false);
    setExportSuccess(false);
    setNeighboursLoading(false);
    setNeighboursData(null);
  }, [publicKey]);

  // Auto-load stored neighbor data from the database for repeaters.
  const loadStoredNeighbors = useCallback(async () => {
    if (!sourceId || contact?.advType !== 2) return;
    try {
      const resp = await api.get<{
        success: boolean;
        data: { items: Array<{ neighborPublicKey: string; neighborName: string | null; snr: number | null; timestamp: number }> };
      }>(`/api/sources/${sourceId}/meshcore/neighbors?since=0&node=${encodeURIComponent(publicKey)}`);
      if (resp.success && resp.data.items.length > 0) {
        const ts = resp.data.items[0].timestamp;
        setNeighboursData({
          total: resp.data.items.length,
          neighbours: resp.data.items.map((n) => ({
            publicKeyPrefix: n.neighborPublicKey.substring(0, 8),
            name: n.neighborName,
            heardSecondsAgo: 0,
            snr: n.snr ?? 0,
          })),
          fetchedAt: ts,
        });
      }
    } catch {
      // Stored data is a nicety — if the fetch fails, the user can
      // still click Neighbours to fetch live data.
    }
  }, [sourceId, publicKey, contact?.advType]);

  useEffect(() => {
    void loadStoredNeighbors();
  }, [loadStoredNeighbors]);

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
    !!onSetOutPath && canWriteNodes && isCompanion;

  // Repeater/room options for the path picker, derived from the contact list.
  const hopOptions = React.useMemo(
    () => repeaterHopOptions(repeaters ?? [], editorHashBytes),
    [repeaters, editorHashBytes],
  );
  const canShowTraceButton =
    !!onTracePath && canWriteNodes && isCompanion && pathKnown && pathLen! > 0;
  const canShowDiscoverButton =
    !!onDiscoverPath && canWriteNodes && isCompanion;
  const canShowRemoveButton =
    !!onRemoveContact && canWriteNodes && isCompanion;
  const canShowExportButton =
    !!onExportContact && isCompanion;
  const canShowNeighboursButton =
    !!onGetNeighbours && isCompanion && advType === 2;

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

  const handleDiscoverPath = async () => {
    if (!onDiscoverPath || discovering) return;
    setDiscovering(true);
    try {
      await onDiscoverPath(publicKey);
    } finally {
      setDiscovering(false);
    }
  };

  const openEditor = () => {
    const hops = parsePathHops(outPath);
    setEditorHops(hops);
    setEditorHashBytes(pathHashBytesOf(hops));
    setCustomByte('');
    setEditorError(null);
    setEditorOpen(true);
  };

  // Max hops the firmware allows (bottom 6 bits of the packed path_len byte),
  // also bounded by the 64-byte path buffer (hops * hashBytes <= 64).
  const maxHops = Math.min(63, Math.floor(64 / editorHashBytes));

  const addHop = (byte: PathHop) => {
    if (editorHops.length >= maxHops) return;
    setEditorHops((prev) => [...prev, byte]);
  };

  // Changing the hash width invalidates existing hex hops (a 1-byte "a3" can't
  // be widened without the repeater's extra bytes), so clear them.
  const changeHashBytes = (next: 1 | 2 | 3) => {
    if (next === editorHashBytes) return;
    setEditorHashBytes(next);
    setEditorHops([]);
    setCustomByte('');
    setEditorError(null);
  };

  const addCustomHop = () => {
    const tok = customByte.trim().toLowerCase();
    if (!new RegExp(`^[0-9a-f]{${editorHashBytes * 2}}$`).test(tok)) {
      setEditorError(
        t('meshcore.contact_details.edit_path_invalid_byte', `Enter a ${editorHashBytes}-byte hex hash (${editorHashBytes * 2} hex chars).`),
      );
      return;
    }
    setEditorError(null);
    addHop(tok);
    setCustomByte('');
  };

  const removeHop = (index: number) => {
    setEditorHops((prev) => prev.filter((_, i) => i !== index));
  };

  const moveHop = (index: number, delta: number) => {
    setEditorHops((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const handleSaveEditor = async () => {
    if (!onSetOutPath || editorSaving) return;
    if (editorHops.length > maxHops) {
      setEditorError(
        t('meshcore.contact_details.edit_path_too_long', `Path too long: ${editorHops.length} hops (max ${maxHops}).`),
      );
      return;
    }
    setEditorSaving(true);
    setEditorError(null);
    try {
      const ok = await onSetOutPath(publicKey, joinPathHops(editorHops), editorHashBytes);
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
      const result = await onShareContact(publicKey);
      if (result.ok) {
        setShareSuccess(true);
        window.setTimeout(() => setShareSuccess(false), 2200);
      } else {
        setShareError(
          result.error ||
            t('meshcore.contact_details.share_contact_error', 'Share contact failed.'),
        );
      }
    } finally {
      setSharing(false);
    }
  };

  const handleRemoveContact = async () => {
    if (!onRemoveContact || removing) return;
    const confirmMessage = t(
      'meshcore.contact_details.remove_contact_confirm',
      `Remove ${name} from the device's contact list? This cannot be undone.`,
    );
    if (typeof window !== 'undefined' && !window.confirm(confirmMessage)) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const ok = await onRemoveContact(publicKey);
      if (!ok) {
        setRemoveError(t('meshcore.contact_details.remove_contact_error', 'Remove contact failed.'));
      }
    } finally {
      setRemoving(false);
    }
  };

  const handleExportContact = async () => {
    if (!onExportContact || exporting) return;
    setExporting(true);
    setExportSuccess(false);
    try {
      const bytes = await onExportContact(publicKey);
      if (bytes) {
        const url = `meshcore://${bytes.map(b => b.toString(16).padStart(2, '0')).join('')}`;
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          window.prompt(
            t('meshcore.contact_details.export_contact_copy_fallback', 'Copy this meshcore:// URL:'),
            url,
          );
        }
        setExportSuccess(true);
        window.setTimeout(() => setExportSuccess(false), 2200);
      }
    } finally {
      setExporting(false);
    }
  };

  const handleGetNeighbours = async () => {
    if (!onGetNeighbours || neighboursLoading) return;
    setNeighboursLoading(true);
    setNeighboursData(null);
    try {
      const result = await onGetNeighbours(publicKey, { count: 20 });
      if (result) {
        setNeighboursData({ ...result, fetchedAt: Date.now() });
      }
    } finally {
      setNeighboursLoading(false);
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
          {(canShowResetButton || canShowShareButton || canShowEditButton || canShowTraceButton || canShowDiscoverButton || canShowRemoveButton || canShowExportButton || canShowNeighboursButton) &&
            (canShowShareButton || canShowEditButton || canShowTraceButton || canShowDiscoverButton || canShowRemoveButton || canShowExportButton || canShowNeighboursButton || pathKnown) && (
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
                    aria-label={t('meshcore.contact_details.edit_path_button', 'Define Path…')}
                  >
                    {t('meshcore.contact_details.edit_path_button', 'Define Path…')}
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
                {canShowDiscoverButton && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleDiscoverPath}
                    disabled={discovering}
                    aria-label={t('meshcore.contact_details.discover_path_button', 'Discover Path')}
                  >
                    {discovering
                      ? t('meshcore.contact_details.discover_path_running', 'Discovering…')
                      : t('meshcore.contact_details.discover_path_button', 'Discover Path')}
                  </button>
                )}
                {canShowExportButton && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleExportContact}
                    disabled={exporting}
                    aria-label={t('meshcore.contact_details.export_contact_button', 'Export')}
                  >
                    {exporting
                      ? t('meshcore.contact_details.export_contact_running', 'Exporting…')
                      : t('meshcore.contact_details.export_contact_button', 'Export')}
                  </button>
                )}
                {canShowNeighboursButton && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleGetNeighbours}
                    disabled={neighboursLoading}
                    aria-label={t('meshcore.contact_details.neighbours_button', 'Neighbours')}
                  >
                    {neighboursLoading
                      ? t('meshcore.contact_details.neighbours_loading', 'Loading…')
                      : t('meshcore.contact_details.neighbours_button', 'Neighbours')}
                  </button>
                )}
                {canShowRemoveButton && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleRemoveContact}
                    disabled={removing}
                    style={{ color: 'var(--ctp-red)' }}
                    aria-label={t('meshcore.contact_details.remove_contact_button', 'Remove')}
                  >
                    {removing
                      ? t('meshcore.contact_details.remove_contact_running', 'Removing…')
                      : t('meshcore.contact_details.remove_contact_button', 'Remove')}
                  </button>
                )}
                {resetError && (
                  <span style={{ color: 'var(--ctp-red)' }} role="alert">{resetError}</span>
                )}
                {shareError && (
                  <span style={{ color: 'var(--ctp-red)' }} role="alert">{shareError}</span>
                )}
                {removeError && (
                  <span style={{ color: 'var(--ctp-red)' }} role="alert">{removeError}</span>
                )}
                {shareSuccess && (
                  <span style={{ color: 'var(--ctp-green)' }} role="status">
                    {t('meshcore.contact_details.share_contact_success', 'Advert broadcast.')}
                  </span>
                )}
                {exportSuccess && (
                  <span style={{ color: 'var(--ctp-green)' }} role="status">
                    {t('meshcore.contact_details.export_contact_success', 'Copied to clipboard.')}
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

          {/* Neighbours results */}
          {neighboursData && (
            <div className="node-detail-card node-detail-card-2col">
              <div className="node-detail-label">
                {t('meshcore.contact_details.neighbours_results', 'Neighbours')}
                {' '}({neighboursData.total} {t('meshcore.contact_details.neighbours_total', 'total')})
                {neighboursData.fetchedAt && (
                  <span style={{ fontSize: '0.8em', opacity: 0.6, marginLeft: '0.5rem' }}>
                    {formatRelativeTime(neighboursData.fetchedAt, timeFormat, dateFormat)}
                  </span>
                )}
              </div>
              <div className="node-detail-value">
                {neighboursData.neighbours.length === 0 ? (
                  <span style={{ opacity: 0.7 }}>
                    {t('meshcore.contact_details.neighbours_none', 'No neighbours reported.')}
                  </span>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono, monospace)', fontSize: '0.9em' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--ctp-surface1, #45475a)' }}>
                        <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>
                          {t('meshcore.contact_details.neighbours_name', 'Node')}
                        </th>
                        <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem' }}>
                          {t('meshcore.contact_details.neighbours_snr', 'SNR')}
                        </th>
                        <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem' }}>
                          {t('meshcore.contact_details.neighbours_heard', 'Last Heard')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {neighboursData.neighbours.map((n, i) => (
                        <tr key={i}>
                          <td style={{ padding: '0.25rem 0.5rem' }} title={n.publicKeyPrefix}>
                            {n.name || n.publicKeyPrefix}
                          </td>
                          <td style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}
                              className={getSignalClass(n.snr)}>
                            {n.snr.toFixed(2)} dB
                          </td>
                          <td style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}>
                            {n.heardSecondsAgo < 60
                              ? `${n.heardSecondsAgo}s ago`
                              : n.heardSecondsAgo < 3600
                                ? `${Math.floor(n.heardSecondsAgo / 60)}m ago`
                                : `${Math.floor(n.heardSecondsAgo / 3600)}h ago`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
              {t('meshcore.contact_details.edit_path_dialog_title', 'Define forwarding path')}
            </h3>
            <p style={{ marginBottom: '0.75rem' }}>
              {t(
                'meshcore.contact_details.edit_path_dialog_hint',
                'Build the route to this contact by adding repeater hops in order, from your node outward. An empty path is a zero-hop direct send (0..64 hops).',
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

            {/* Per-hop hash width (1/2/3 bytes). Changing it clears the
                current hops since the hex hashes are width-specific. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
              <label htmlFor="mc-path-hash-bytes">
                {t('meshcore.contact_details.edit_path_hash_width', 'Hop hash width:')}
              </label>
              <select
                id="mc-path-hash-bytes"
                aria-label={t('meshcore.contact_details.edit_path_hash_width', 'Hop hash width:')}
                value={editorHashBytes}
                disabled={editorSaving}
                onChange={(e) => changeHashBytes(Number(e.target.value) as 1 | 2 | 3)}
                style={{ padding: '0.4rem', boxSizing: 'border-box' }}
              >
                <option value={1}>{t('meshcore.contact_details.edit_path_hash_1', '1 byte (default)')}</option>
                <option value={2}>{t('meshcore.contact_details.edit_path_hash_2', '2 bytes')}</option>
                <option value={3}>{t('meshcore.contact_details.edit_path_hash_3', '3 bytes')}</option>
              </select>
            </div>

            {/* Ordered hop list */}
            <label style={{ display: 'block', marginBottom: '0.4rem' }}>
              {t('meshcore.contact_details.edit_path_label', 'Path ({{count}} hops):', { count: editorHops.length })}
            </label>
            {editorHops.length === 0 ? (
              <div style={{ fontSize: '0.85em', opacity: 0.7, marginBottom: '0.6rem' }}>
                {t('meshcore.contact_details.edit_path_zero_hops', 'Direct path (no repeater hops).')}
              </div>
            ) : (
              <ol style={{ listStyle: 'none', padding: 0, margin: '0 0 0.6rem' }}>
                {editorHops.map((byte, i) => {
                  const resolved = resolveHop(byte, hopOptions);
                  return (
                    <li
                      key={`${byte}-${i}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.35rem 0.5rem',
                        marginBottom: '0.25rem',
                        background: 'var(--ctp-surface0, #313244)',
                        borderRadius: '4px',
                      }}
                    >
                      <span style={{ opacity: 0.6, minWidth: '1.4rem' }}>{i + 1}.</span>
                      <span style={{ flex: 1 }}>
                        {resolved.label}
                        <span style={{ opacity: 0.6, fontFamily: 'var(--font-mono, monospace)', marginLeft: '0.4rem' }}>
                          (0x{byte})
                        </span>
                      </span>
                      <button type="button" className="btn-secondary" disabled={editorSaving || i === 0}
                        aria-label={t('meshcore.contact_details.edit_path_move_up', 'Move hop up')}
                        onClick={() => moveHop(i, -1)} style={{ padding: '0.1rem 0.4rem' }}>↑</button>
                      <button type="button" className="btn-secondary" disabled={editorSaving || i === editorHops.length - 1}
                        aria-label={t('meshcore.contact_details.edit_path_move_down', 'Move hop down')}
                        onClick={() => moveHop(i, 1)} style={{ padding: '0.1rem 0.4rem' }}>↓</button>
                      <button type="button" className="btn-secondary" disabled={editorSaving}
                        aria-label={t('meshcore.contact_details.edit_path_remove_hop', 'Remove hop')}
                        onClick={() => removeHop(i)} style={{ padding: '0.1rem 0.4rem' }}>✕</button>
                    </li>
                  );
                })}
              </ol>
            )}

            {/* Add a repeater hop by name */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
              <select
                aria-label={t('meshcore.contact_details.edit_path_add_repeater_aria', 'Add repeater hop')}
                disabled={editorSaving || editorHops.length >= maxHops}
                value=""
                onChange={(e) => { if (e.target.value) addHop(e.target.value); }}
                style={{ flex: 1, minWidth: '12rem', padding: '0.45rem', boxSizing: 'border-box' }}
              >
                <option value="">
                  {hopOptions.length === 0
                    ? t('meshcore.contact_details.edit_path_no_repeaters', 'No known repeaters')
                    : t('meshcore.contact_details.edit_path_add_repeater', '+ Add repeater hop…')}
                </option>
                {hopOptions.map((o) => (
                  <option key={o.publicKey} value={o.hopByte}>
                    {o.name} (0x{o.hopByte})
                  </option>
                ))}
              </select>
            </div>

            {/* Add a raw byte for a repeater you haven't met */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', alignItems: 'center' }}>
              <input
                type="text"
                value={customByte}
                onChange={(e) => setCustomByte(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomHop(); } }}
                disabled={editorSaving || editorHops.length >= maxHops}
                placeholder={t('meshcore.contact_details.edit_path_custom_byte', 'or hex byte (a3)')}
                style={{ width: '8rem', padding: '0.45rem', fontFamily: 'var(--font-mono, monospace)', boxSizing: 'border-box' }}
              />
              <button type="button" className="btn-secondary" onClick={addCustomHop}
                disabled={editorSaving || editorHops.length >= maxHops || customByte.trim() === ''}>
                {t('meshcore.contact_details.edit_path_add_byte', 'Add')}
              </button>
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
