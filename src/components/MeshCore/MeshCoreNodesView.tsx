import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreNode } from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { MeshCoreMap } from './MeshCoreMap';

const MOBILE_BREAKPOINT = 768;
const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT;

const DEVICE_TYPE_KEYS: Record<number, string> = {
  0: 'meshcore.device_type.unknown',
  1: 'meshcore.device_type.companion',
  2: 'meshcore.device_type.repeater',
  3: 'meshcore.device_type.room_server',
};

interface MeshCoreNodesViewProps {
  nodes: MeshCoreNode[];
  contacts: MeshCoreContact[];
  onImportContact?: (advertBytes: number[]) => Promise<boolean>;
}

interface MergedRow {
  publicKey: string;
  name: string;
  advType?: number;
  rssi?: number;
  snr?: number;
  lastHeard?: number;
  hasPosition: boolean;
}

type SortField = 'name' | 'lastHeard';
type SortDirection = 'asc' | 'desc';

function mergeNodesAndContacts(
  nodes: MeshCoreNode[],
  contacts: MeshCoreContact[],
): MergedRow[] {
  const byKey = new Map<string, MergedRow>();
  for (const n of nodes) {
    if (!n.publicKey) continue;
    byKey.set(n.publicKey, {
      publicKey: n.publicKey,
      name: n.name || 'Unknown',
      advType: n.advType,
      rssi: n.rssi,
      snr: n.snr,
      lastHeard: n.lastHeard,
      hasPosition: false,
    });
  }
  for (const c of contacts) {
    if (!c.publicKey) continue;
    const existing = byKey.get(c.publicKey);
    const hasPos = typeof c.latitude === 'number' && typeof c.longitude === 'number';
    if (existing) {
      existing.name = existing.name === 'Unknown'
        ? (c.advName || c.name || existing.name)
        : existing.name;
      existing.rssi = existing.rssi ?? c.rssi;
      existing.snr = existing.snr ?? c.snr;
      existing.lastHeard = existing.lastHeard ?? c.lastSeen;
      existing.hasPosition = existing.hasPosition || hasPos;
      existing.advType = existing.advType ?? c.advType;
    } else {
      byKey.set(c.publicKey, {
        publicKey: c.publicKey,
        name: c.advName || c.name || 'Unknown',
        advType: c.advType,
        rssi: c.rssi,
        snr: c.snr,
        lastHeard: c.lastSeen,
        hasPosition: hasPos,
      });
    }
  }
  return Array.from(byKey.values());
}

function sortRows(rows: MergedRow[], field: SortField, direction: SortDirection): MergedRow[] {
  const dir = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (field === 'name') {
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * dir;
    }
    const at = a.lastHeard ?? 0;
    const bt = b.lastHeard ?? 0;
    return (at - bt) * dir;
  });
}

export const MeshCoreNodesView: React.FC<MeshCoreNodesViewProps> = ({
  nodes,
  contacts,
  onImportContact,
}) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('lastHeard');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [mobileShowContent, setMobileShowContent] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importHex, setImportHex] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const handleImport = useCallback(async () => {
    if (!onImportContact || importing) return;
    const hex = importHex.trim().replace(/^meshcore:\/\//i, '').replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 2 || hex.length % 2 !== 0) {
      setImportError(t('meshcore.import_contact.invalid_hex', 'Invalid hex — paste the full exported contact blob.'));
      return;
    }
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.substring(i, i + 2), 16));
    }
    setImporting(true);
    setImportError(null);
    try {
      const ok = await onImportContact(bytes);
      if (ok) {
        setImportDialogOpen(false);
        setImportHex('');
      } else {
        setImportError(t('meshcore.import_contact.failed', 'Import failed — invalid advert data or device not connected.'));
      }
    } finally {
      setImporting(false);
    }
  }, [onImportContact, importing, importHex, t]);

  useEffect(() => {
    const onResize = () => {
      if (!isMobileViewport()) setMobileShowContent(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleSelectNode = useCallback((key: string) => {
    setSelected(key);
    if (isMobileViewport()) setMobileShowContent(true);
  }, []);

  const merged = useMemo(() => mergeNodesAndContacts(nodes, contacts), [nodes, contacts]);
  const rows = useMemo(
    () => sortRows(merged, sortField, sortDirection),
    [merged, sortField, sortDirection],
  );

  const mobileClass = mobileShowContent ? 'mobile-show-content' : 'mobile-show-list';
  const selectedRow = rows.find(r => r.publicKey === selected);

  return (
    <div className={`meshcore-two-pane ${mobileClass}`}>
      <div className="meshcore-list-pane">
        <div className="meshcore-list-pane-header">
          <span>{t('meshcore.nav.nodes', 'Nodes')}</span>
          <span className="pane-count">{rows.length}</span>
          {onImportContact && (
            <button
              type="button"
              className="btn-secondary"
              style={{ fontSize: '0.8em', padding: '0.15rem 0.5rem', marginLeft: '0.5rem' }}
              onClick={() => { setImportHex(''); setImportError(null); setImportDialogOpen(true); }}
            >
              {t('meshcore.import_contact.button', 'Import')}
            </button>
          )}
          <div className="sort-controls meshcore-sort-controls">
            <select
              aria-label={t('meshcore.sort_by', 'Sort by')}
              title={t('meshcore.sort_by', 'Sort by')}
              value={sortField}
              onChange={(e) => setSortField(e.target.value as SortField)}
              className="sort-dropdown"
            >
              <option value="lastHeard">{t('meshcore.sort_last_heard', 'Last heard')}</option>
              <option value="name">{t('meshcore.sort_name', 'Name')}</option>
            </select>
            <button
              type="button"
              className="sort-direction-btn"
              onClick={() => setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
              title={sortDirection === 'asc'
                ? t('meshcore.ascending', 'Ascending')
                : t('meshcore.descending', 'Descending')}
              aria-label={sortDirection === 'asc'
                ? t('meshcore.ascending', 'Ascending')
                : t('meshcore.descending', 'Descending')}
            >
              {sortDirection === 'asc' ? '↑' : '↓'}
            </button>
          </div>
        </div>
        <div className="meshcore-list-pane-body">
          {rows.length === 0 ? (
            <div className="meshcore-empty-state">
              {t('meshcore.no_nodes', 'No nodes seen yet')}
            </div>
          ) : rows.map(row => (
            <button
              key={row.publicKey}
              className={`mc-node-row ${selected === row.publicKey ? 'selected' : ''}`}
              onClick={() => handleSelectNode(row.publicKey)}
            >
              <div className="mc-node-row-name">
                <span>{row.name}</span>
                {typeof row.advType === 'number' && (
                  <span className="mc-node-row-type">
                    {t(DEVICE_TYPE_KEYS[row.advType] || 'meshcore.device_type.unknown', '')}
                  </span>
                )}
              </div>
              <div className="mc-node-row-meta">
                {typeof row.rssi === 'number' && <span>RSSI {row.rssi}</span>}
                {typeof row.snr === 'number' && <span>SNR {row.snr}</span>}
                {row.lastHeard && (
                  <span>{new Date(row.lastHeard).toLocaleTimeString()}</span>
                )}
                {row.hasPosition && <span>📍</span>}
              </div>
              <div className="mc-node-row-key">
                {row.publicKey.substring(0, 16)}…
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="meshcore-main-pane">
        {mobileShowContent && (
          <div className="meshcore-mobile-back-header">
            <button
              type="button"
              className="meshcore-mobile-back-btn"
              onClick={() => setMobileShowContent(false)}
            >
              ◀ {t('common.back', 'Back')}
            </button>
            {selectedRow && (
              <span className="meshcore-mobile-back-title">{selectedRow.name}</span>
            )}
          </div>
        )}
        <MeshCoreMap contacts={contacts} selectedPublicKey={selected} />
      </div>
      {importDialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('meshcore.import_contact.dialog_title', 'Import Contact')}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget && !importing) setImportDialogOpen(false); }}
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
              {t('meshcore.import_contact.dialog_title', 'Import Contact')}
            </h3>
            <p style={{ marginBottom: '0.75rem' }}>
              {t(
                'meshcore.import_contact.dialog_hint',
                'Paste the hex-encoded signed advert blob or a meshcore:// URL exported from another node.',
              )}
            </p>
            <textarea
              value={importHex}
              onChange={(e) => setImportHex(e.target.value)}
              disabled={importing}
              placeholder="e.g. 04a3b7c2d1..."
              rows={4}
              style={{
                width: '100%',
                padding: '0.5rem',
                marginBottom: '0.5rem',
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: '0.85em',
                boxSizing: 'border-box',
                resize: 'vertical',
              }}
              autoFocus
            />
            {importError && (
              <div style={{ color: 'var(--ctp-red)', marginBottom: '0.75rem' }} role="alert">
                {importError}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setImportDialogOpen(false)}
                disabled={importing}
              >
                {t('meshcore.import_contact.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleImport}
                disabled={importing || importHex.trim().length === 0}
              >
                {importing
                  ? t('meshcore.import_contact.importing', 'Importing…')
                  : t('meshcore.import_contact.import', 'Import')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
