import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../common/Modal';
import { useSource } from '../../contexts/SourceContext';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import api from '../../services/api';
import { NODE_INFO_DISPLAY_FIELDS as DISPLAY_FIELDS } from '../../utils/nodeInfoFields';
import './CopyNodeInfoModal.css';

interface CopyCandidate {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  node: {
    nodeNum: number;
    nodeId: string;
    longName: string | null;
    shortName: string | null;
    hwModel: number | null;
    role: number | null;
    macaddr: string | null;
    publicKey: string | null;
    hasPKC: boolean | null;
    firmwareVersion: string | null;
    updatedAt: number;
    lastHeard: number | null;
  };
  fieldsFilled: number;
  totalFields: number;
}

interface CopyNodeInfoModalProps {
  isOpen: boolean;
  nodeNum: number | null;
  currentNode: {
    longName?: string | null;
    shortName?: string | null;
    hwModel?: number | null;
    role?: number | null;
    macaddr?: string | null;
    publicKey?: string | null;
    hasPKC?: boolean | null;
    firmwareVersion?: string | null;
  } | null;
  onClose: () => void;
  onCopied: () => void;
}

function formatFieldValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'publicKey' && typeof value === 'string') {
    return value.length > 16 ? `${value.substring(0, 16)}...` : value;
  }
  if (key === 'hasPKC') return value ? 'Yes' : 'No';
  return String(value);
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleString();
}

export const CopyNodeInfoModal: React.FC<CopyNodeInfoModalProps> = ({
  isOpen,
  nodeNum,
  currentNode,
  onClose,
  onCopied,
}) => {
  const { t } = useTranslation();
  const { sourceId } = useSource();
  const csrfFetch = useCsrfFetch();

  const [candidates, setCandidates] = useState<CopyCandidate[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [pushToNodeDb, setPushToNodeDb] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || nodeNum === null || !sourceId) {
      setCandidates([]);
      setSelectedSourceId(null);
      setPushToNodeDb(false);
      setError(null);
      setSuccessMessage(null);
      return;
    }

    setLoading(true);
    setError(null);

    api.get<{ data?: CopyCandidate[] }>(
      `/api/nodes/${nodeNum}/copy-candidates?sourceId=${encodeURIComponent(sourceId)}`,
    )
      .then(data => {
        const list: CopyCandidate[] = data.data ?? [];
        setCandidates(list);
        if (list.length > 0) {
          setSelectedSourceId(list[0].sourceId);
        }
      })
      .catch(err => {
        setError(err.message);
      })
      .finally(() => setLoading(false));
  }, [isOpen, nodeNum, sourceId]);

  const selectedCandidate = candidates.find(c => c.sourceId === selectedSourceId) ?? null;

  const diffRows = DISPLAY_FIELDS.map(({ key, label }) => {
    const currentVal = currentNode ? (currentNode as any)[key] : null;
    const incomingVal = selectedCandidate ? (selectedCandidate.node as any)[key] : null;
    const isNew = (currentVal == null || currentVal === '') &&
                  incomingVal != null && incomingVal !== '';
    // #4244: a field can now be copied even when the target already holds a
    // value, so "would this change anything?" is the real gate, not "is the
    // target empty?".
    const hasIncoming = incomingVal != null && incomingVal !== '';
    const differs = hasIncoming && String(currentVal ?? '') !== String(incomingVal);
    return { key, label, currentVal, incomingVal, isNew, hasIncoming, differs };
  });

  // Only rows with an incoming value are selectable — there is nothing to copy
  // from an empty donor field.
  const selectableKeys = useMemo(
    () => diffRows.filter(r => r.hasIncoming).map(r => r.key as string),
    [diffRows],
  );

  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());

  // Default the selection to every row that would actually change something,
  // which reproduces the old fill-empty behavior plus the stale-value refreshes
  // the old code silently refused to do. Re-runs when the donor changes.
  //
  // Deliberately keyed on the donor rather than on diffRows: diffRows is a new
  // array every render, so depending on it would re-run this effect forever and
  // stomp the user's checkbox edits on each pass.
  useEffect(() => {
    setSelectedFields(new Set(diffRows.filter(r => r.differs).map(r => r.key as string)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #4244 see comment above
  }, [selectedSourceId, currentNode]);

  const toggleField = useCallback((key: string) => {
    setSelectedFields(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const allSelected = selectableKeys.length > 0 &&
    selectableKeys.every(k => selectedFields.has(k));

  const toggleAll = useCallback(() => {
    setSelectedFields(prev => {
      const everySelected = selectableKeys.length > 0 &&
        selectableKeys.every(k => prev.has(k));
      return everySelected ? new Set<string>() : new Set(selectableKeys);
    });
  }, [selectableKeys]);

  const hasChanges = selectedFields.size > 0;

  const handleConfirm = useCallback(async () => {
    if (!nodeNum || !selectedSourceId || !sourceId) return;

    setSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const baseUrl = await api.getBaseUrl();
      const res = await csrfFetch(
        `${baseUrl}/api/nodes/${nodeNum}/copy-nodeinfo`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fromSourceId: selectedSourceId,
            toSourceId: sourceId,
            pushToNodeDb,
            // #4244: explicit selection — these overwrite the target even when
            // it already holds a (possibly derived/stale) value.
            fields: Array.from(selectedFields),
          }),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || 'Copy failed');
      }

      const result = await res.json();
      const count = result.data?.copiedFields?.length ?? 0;
      let msg = t('nodes.copy_nodeinfo_success', { count });
      if (result.data?.pushedToDevice) {
        msg += ' ' + t('nodes.copy_nodeinfo_pushed');
      }
      setSuccessMessage(msg);
      onCopied();
    } catch (err: any) {
      setError(err.message || t('nodes.copy_nodeinfo_error'));
    } finally {
      setSaving(false);
    }
  }, [nodeNum, selectedSourceId, sourceId, pushToNodeDb, selectedFields, csrfFetch, t, onCopied]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('nodes.copy_nodeinfo_title')}
      className="copy-nodeinfo-modal"
      maxWidth="600px"
    >
      {loading ? (
        <div className="copy-nodeinfo-loading">{t('common.loading')}...</div>
      ) : successMessage ? (
        <div className="copy-nodeinfo-success">
          <p>{successMessage}</p>
          <div className="copy-nodeinfo-actions">
            <button className="copy-nodeinfo-btn primary" onClick={onClose}>
              {t('common.close', 'Close')}
            </button>
          </div>
        </div>
      ) : candidates.length === 0 ? (
        <div className="copy-nodeinfo-empty">
          <p>{t('nodes.copy_nodeinfo_no_candidates')}</p>
          <div className="copy-nodeinfo-actions">
            <button className="copy-nodeinfo-btn" onClick={onClose}>
              {t('common.close', 'Close')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="copy-nodeinfo-description">
            {t('nodes.copy_nodeinfo_description')}
          </p>

          <div className="copy-nodeinfo-source-select">
            <label>{t('nodes.copy_nodeinfo_source')}:</label>
            <select
              value={selectedSourceId ?? ''}
              onChange={e => setSelectedSourceId(e.target.value)}
              disabled={saving}
            >
              {candidates.map(c => (
                <option key={c.sourceId} value={c.sourceId}>
                  {c.sourceName} ({c.fieldsFilled}/{c.totalFields} fields) —{' '}
                  {formatTimestamp(c.node.updatedAt)}
                </option>
              ))}
            </select>
          </div>

          <div className="copy-nodeinfo-diff">
            <table>
              <thead>
                <tr>
                  <th className="field-select">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={selectableKeys.length === 0}
                      aria-label={t('nodes.copy_nodeinfo_select_all', 'Select all fields')}
                      title={t('nodes.copy_nodeinfo_select_all', 'Select all fields')}
                    />
                  </th>
                  <th>{t('nodes.copy_nodeinfo_field')}</th>
                  <th>{t('nodes.copy_nodeinfo_current')}</th>
                  <th>{t('nodes.copy_nodeinfo_incoming')}</th>
                </tr>
              </thead>
              <tbody>
                {diffRows.map(row => {
                  const checked = selectedFields.has(row.key as string);
                  return (
                    <tr
                      key={row.key}
                      className={[
                        row.isNew ? 'diff-new' : '',
                        // A row that overwrites existing data is visually
                        // distinct from one that merely fills a blank (#4244).
                        row.differs && !row.isNew ? 'diff-overwrite' : '',
                        checked ? 'is-selected' : '',
                      ].filter(Boolean).join(' ')}
                    >
                      <td className="field-select">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!row.hasIncoming}
                          onChange={() => toggleField(row.key as string)}
                          aria-label={row.label}
                        />
                      </td>
                      <td className="field-name">{row.label}</td>
                      <td className="field-current">
                        {formatFieldValue(row.key, row.currentVal)}
                      </td>
                      <td className={`field-incoming${row.isNew ? ' new-value' : ''}`}>
                        {formatFieldValue(row.key, row.incomingVal)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!hasChanges && (
            <p className="copy-nodeinfo-no-changes">
              {t('nodes.copy_nodeinfo_no_changes')}
            </p>
          )}

          <div className="copy-nodeinfo-push-option">
            <label>
              <input
                type="checkbox"
                checked={pushToNodeDb}
                onChange={e => setPushToNodeDb(e.target.checked)}
                disabled={saving}
              />
              {t('nodes.copy_nodeinfo_push_to_device')}
            </label>
            <span className="push-help">{t('nodes.copy_nodeinfo_push_to_device_help')}</span>
          </div>

          {error && <div className="copy-nodeinfo-error">{error}</div>}

          <div className="copy-nodeinfo-actions">
            <button
              className="copy-nodeinfo-btn"
              onClick={onClose}
              disabled={saving}
            >
              {t('common.cancel')}
            </button>
            <button
              className="copy-nodeinfo-btn primary"
              onClick={handleConfirm}
              disabled={saving || !hasChanges}
            >
              {saving ? t('common.saving', 'Saving...') : t('common.confirm', 'Confirm')}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
};

export default CopyNodeInfoModal;
