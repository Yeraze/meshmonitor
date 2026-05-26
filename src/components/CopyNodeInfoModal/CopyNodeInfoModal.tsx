import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../common/Modal';
import { useSource } from '../../contexts/SourceContext';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import api from '../../services/api';
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

const DISPLAY_FIELDS = [
  { key: 'longName', label: 'Long Name' },
  { key: 'shortName', label: 'Short Name' },
  { key: 'hwModel', label: 'Hardware Model' },
  { key: 'role', label: 'Role' },
  { key: 'macaddr', label: 'MAC Address' },
  { key: 'publicKey', label: 'Public Key' },
  { key: 'hasPKC', label: 'Has PKC' },
  { key: 'firmwareVersion', label: 'Firmware' },
] as const;

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

    api.getBaseUrl()
      .then(baseUrl =>
        fetch(
          `${baseUrl}/api/v1/nodes/${nodeNum}/copy-candidates?sourceId=${encodeURIComponent(sourceId)}`,
          { credentials: 'include' },
        ),
      )
      .then(res => {
        if (!res.ok) throw new Error('Failed to load candidates');
        return res.json();
      })
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
    return { key, label, currentVal, incomingVal, isNew };
  });

  const hasChanges = diffRows.some(r => r.isNew);

  const handleConfirm = useCallback(async () => {
    if (!nodeNum || !selectedSourceId || !sourceId) return;

    setSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const baseUrl = await api.getBaseUrl();
      const res = await csrfFetch(
        `${baseUrl}/api/v1/nodes/${nodeNum}/copy-nodeinfo`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fromSourceId: selectedSourceId,
            toSourceId: sourceId,
            pushToNodeDb,
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
  }, [nodeNum, selectedSourceId, sourceId, pushToNodeDb, csrfFetch, t, onCopied]);

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
                  <th>{t('nodes.copy_nodeinfo_field')}</th>
                  <th>{t('nodes.copy_nodeinfo_current')}</th>
                  <th>{t('nodes.copy_nodeinfo_incoming')}</th>
                </tr>
              </thead>
              <tbody>
                {diffRows.map(row => (
                  <tr key={row.key} className={row.isNew ? 'diff-new' : ''}>
                    <td className="field-name">{row.label}</td>
                    <td className="field-current">
                      {formatFieldValue(row.key, row.currentVal)}
                    </td>
                    <td className={`field-incoming${row.isNew ? ' new-value' : ''}`}>
                      {formatFieldValue(row.key, row.incomingVal)}
                    </td>
                  </tr>
                ))}
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
