import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { UiIcon } from '../icons';
import { formatRelativeTime } from '../../utils/datetime';
import {
  useMeshCoreMessageFilters,
  useCreateMeshCoreMessageFilter,
  useUpdateMeshCoreMessageFilter,
  useDeleteMeshCoreMessageFilter,
  type MeshCoreMessageFilter,
  type MeshCoreMessageFilterInput,
} from '../../hooks/useMeshCoreFilters';
import styles from './MeshCoreFilters.module.css';

interface MeshCoreMessageFiltersSectionProps {
  sourceId: string;
}

const MAX_PATTERN = 256;

const EMPTY_DRAFT: MeshCoreMessageFilterInput = {
  mode: 'ignore',
  matchType: 'wildcard',
  pattern: '',
  caseSensitive: false,
  fields: 'both',
  enabled: true,
};

/**
 * MeshCore Settings: per-source text rules that ignore or block messages by
 * sender name and/or body (#5408). The server compiles regex rules with RE2
 * and refuses what RE2 cannot run; that error shows beside the form.
 */
export const MeshCoreMessageFiltersSection: React.FC<MeshCoreMessageFiltersSectionProps> = ({ sourceId }) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('messages', 'read');
  const canWrite = hasPermission('messages', 'write');
  const { data: rules, isLoading } = useMeshCoreMessageFilters(canRead ? sourceId : null);
  const create = useCreateMeshCoreMessageFilter(sourceId);
  const update = useUpdateMeshCoreMessageFilter(sourceId);
  const del = useDeleteMeshCoreMessageFilter(sourceId);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MeshCoreMessageFilterInput | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  if (!canRead) return null;

  const startAdd = () => {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT });
    setFormError(null);
  };

  const startEdit = (r: MeshCoreMessageFilter) => {
    setEditingId(r.id);
    setDraft({
      mode: r.mode, matchType: r.matchType, pattern: r.pattern,
      caseSensitive: r.caseSensitive, fields: r.fields, enabled: r.enabled,
    });
    setFormError(null);
  };

  const cancel = () => {
    setEditingId(null);
    setDraft(null);
    setFormError(null);
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.pattern.trim()) {
      setFormError(t('meshcore.filters.pattern_required', 'Enter a pattern.'));
      return;
    }
    setFormError(null);
    try {
      if (editingId) await update.mutateAsync({ id: editingId, patch: draft });
      else await create.mutateAsync(draft);
      cancel();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('meshcore.ignore.save_failed', 'Could not save'));
    }
  };

  const set = <K extends keyof MeshCoreMessageFilterInput>(k: K, v: MeshCoreMessageFilterInput[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));

  const matchTypeLabel = (m: MeshCoreMessageFilter['matchType']) =>
    m === 'regex'
      ? t('meshcore.filters.match_regex', 'Regex')
      : m === 'wildcard'
        ? t('meshcore.filters.match_wildcard', 'Wildcard')
        : t('meshcore.filters.match_exact', 'Exact');
  const fieldsLabel = (f: MeshCoreMessageFilter['fields']) =>
    f === 'name'
      ? t('meshcore.filters.fields_name', 'Sender name')
      : f === 'body'
        ? t('meshcore.filters.fields_body', 'Message text')
        : t('meshcore.filters.fields_both', 'Name and text');
  const busy = create.isPending || update.isPending;

  return (
    <div className="form-section">
      <h3>{t('meshcore.filters.title', 'Message filters')}</h3>
      <p className={styles.note}>
        {t(
          'meshcore.filters.desc',
          'Ignore or block messages whose sender name or text matches a pattern. Wildcard: * matches any run of characters, ? matches one, and the pattern must match the whole field. Regex matches anywhere; lookaround and backreferences are not supported. Block wins when both match.',
        )}
      </p>
      <p className={styles.note}>
        {t(
          'meshcore.ignore.spoof_note',
          'Channel messages carry only a sender name, so they are matched by the node’s advert name. Anyone can use that name, and two nodes can share one.',
        )}
      </p>

      {isLoading ? (
        <div className={styles.empty}>{t('common.loading', 'Loading…')}</div>
      ) : !rules || rules.length === 0 ? (
        <div className={styles.empty}>{t('meshcore.filters.empty', 'No message filters.')}</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('meshcore.filters.col_enabled', 'On')}</th>
                <th>{t('meshcore.filters.col_pattern', 'Pattern')}</th>
                <th>{t('meshcore.filters.col_match', 'Match')}</th>
                <th>{t('meshcore.filters.col_fields', 'Checks')}</th>
                <th>{t('meshcore.ignore.col_mode', 'Mode')}</th>
                <th>{t('meshcore.ignore.col_hits', 'Hits')}</th>
                <th>{t('meshcore.ignore.col_last_hit', 'Last hit')}</th>
                {canWrite && <th aria-label={t('meshcore.ignore.col_actions', 'Actions')} />}
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      disabled={!canWrite || update.isPending}
                      aria-label={t('meshcore.filters.toggle_enabled', 'Enable rule {{pattern}}', { pattern: r.pattern })}
                      onChange={(e) => update.mutate({ id: r.id, patch: { enabled: e.target.checked } })}
                    />
                  </td>
                  <td className={styles.mono}>
                    {r.pattern}
                    {r.caseSensitive && <span className={styles.status}> ({t('meshcore.filters.case_sensitive_short', 'Aa')})</span>}
                  </td>
                  <td>{matchTypeLabel(r.matchType)}</td>
                  <td>{fieldsLabel(r.fields)}</td>
                  <td>
                    <span className={`${styles.badge} ${r.mode === 'block' ? styles.badgeBlock : ''}`}>
                      {r.mode === 'block' ? t('meshcore.ignore.mode_block', 'Block') : t('meshcore.ignore.mode_ignore', 'Ignore')}
                    </span>
                  </td>
                  <td>{r.hitCount}</td>
                  <td>{r.lastHitAt ? formatRelativeTime(r.lastHitAt) : t('meshcore.ignore.never', 'Never')}</td>
                  {canWrite && (
                    <td>
                      <div className={styles.rowActions}>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => startEdit(r)}
                          aria-label={t('meshcore.filters.edit_rule', 'Edit rule {{pattern}}', { pattern: r.pattern })}
                        >
                          <UiIcon name="edit" size={14} />
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={del.isPending}
                          onClick={() => del.mutate(r.id)}
                          aria-label={t('meshcore.filters.delete_rule', 'Delete rule {{pattern}}', { pattern: r.pattern })}
                        >
                          <UiIcon name="delete" size={14} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canWrite && !draft && (
        <div className={styles.formActions} style={{ marginTop: '0.75rem' }}>
          <button type="button" className="btn-secondary" onClick={startAdd}>
            <UiIcon name="plus" size={14} /> {t('meshcore.filters.add', 'Add filter')}
          </button>
        </div>
      )}

      {canWrite && draft && (
        <div className={styles.form}>
          <label className={styles.patternField}>
            {t('meshcore.filters.col_pattern', 'Pattern')}
            <input
              type="text"
              className="setting-input"
              value={draft.pattern}
              maxLength={MAX_PATTERN}
              onChange={(e) => set('pattern', e.target.value)}
            />
          </label>
          <label>
            {t('meshcore.filters.col_match', 'Match')}
            <select className="setting-input" value={draft.matchType} onChange={(e) => set('matchType', e.target.value as MeshCoreMessageFilterInput['matchType'])}>
              <option value="wildcard">{matchTypeLabel('wildcard')}</option>
              <option value="exact">{matchTypeLabel('exact')}</option>
              <option value="regex">{matchTypeLabel('regex')}</option>
            </select>
          </label>
          <label>
            {t('meshcore.filters.col_fields', 'Checks')}
            <select className="setting-input" value={draft.fields} onChange={(e) => set('fields', e.target.value as MeshCoreMessageFilterInput['fields'])}>
              <option value="both">{fieldsLabel('both')}</option>
              <option value="name">{fieldsLabel('name')}</option>
              <option value="body">{fieldsLabel('body')}</option>
            </select>
          </label>
          <label>
            {t('meshcore.ignore.col_mode', 'Mode')}
            <select className="setting-input" value={draft.mode} onChange={(e) => set('mode', e.target.value as MeshCoreMessageFilterInput['mode'])}>
              <option value="ignore">{t('meshcore.ignore.mode_ignore', 'Ignore')}</option>
              <option value="block">{t('meshcore.ignore.mode_block', 'Block')}</option>
            </select>
          </label>
          <label className={styles.checkboxLabel}>
            <input type="checkbox" checked={draft.caseSensitive} onChange={(e) => set('caseSensitive', e.target.checked)} />
            {t('meshcore.filters.case_sensitive', 'Case sensitive')}
          </label>
          <label className={styles.checkboxLabel}>
            <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            {t('meshcore.filters.enabled', 'Enabled')}
          </label>
          <div className={styles.formActions}>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>
              <UiIcon name="save" size={14} /> {t('common.save', 'Save')}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={cancel}>
              {t('common.cancel', 'Cancel')}
            </button>
            {formError && <span className={styles.error} role="alert">{formError}</span>}
          </div>
        </div>
      )}
      {(update.error || del.error) && !draft ? (
        <div className={styles.error} role="alert">{((update.error || del.error) as Error).message}</div>
      ) : null}
    </div>
  );
};
