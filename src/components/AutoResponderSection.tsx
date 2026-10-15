import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { NumberInputScope } from './common/NumberInputScope';
import { useNumberInputScope } from './common/numberInputScopeContext';
import { useTranslation, Trans } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSourceQuery } from '../hooks/useSourceQuery';
import { useSaveBar } from '../hooks/useSaveBar';
import {
  AutoResponderTrigger,
  AutoResponderSectionProps,
  ScriptMetadata
} from './auto-responder/types';
import { getFileIcon, formatTriggerPatterns } from './auto-responder/utils';
import {
  type TriggerErrors,
  validateAutoResponderTrigger,
  hasErrors,
  finalizeTrigger,
  newAutoResponderTrigger,
  matchAutoResponderTrigger,
  renderSampleResponse,
  channelsLabel,
  patternText,
} from './auto-responder/triggerModel';
import TriggerEditor from './auto-responder/TriggerEditor';
import PatternHighlight from './auto-responder/PatternHighlight';
import AutoResponderDialog from './auto-responder/AutoResponderDialog';
import PatternExamples from './auto-responder/PatternExamples';
import ScriptManagement from './auto-responder/ScriptManagement';
import { UiIcon } from './icons';
import { ConfigSection, ConfigHeaderCount } from './shared/config/ConfigSection';
import { ConfigEmptyState } from './shared/config/ConfigEmptyState';
import { TriggerCard, type TriggerChip } from './shared/automation/TriggerCard';
import { TriggerListFilter } from './shared/automation/TriggerListFilter';
import { PatternTestBox, type PatternTestResult } from './shared/automation/PatternTestBox';
import { TRIGGER_FILTER_THRESHOLD, matchesSearch } from './shared/automation/triggerList';
import apiService from '../services/api';
import styles from './AutoResponderSection.module.css';

const AutoResponderSection: React.FC<AutoResponderSectionProps> = ({
  enabled,
  triggers,
  channels,
  skipIncompleteNodes,
  baseUrl,
  onEnabledChange,
  onTriggersChange,
  onSkipIncompleteNodesChange,
  canWrite = true,
  receiveOnly = false,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const sourceQuery = useSourceQuery();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localTriggers, setLocalTriggers] = useState<AutoResponderTrigger[]>(triggers);
  const [localSkipIncompleteNodes, setLocalSkipIncompleteNodes] = useState(skipIncompleteNodes);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // #5649 / #5808: every trigger editor's number fields report here (through
  // their TriggerCard's scope), so the SaveBar stays off while one is invalid.
  const numberScope = useNumberInputScope();
  // #5808: one trigger is open in its TriggerCard at a time.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [errorsById, setErrorsById] = useState<Record<string, TriggerErrors>>({});
  const [availableScripts, setAvailableScripts] = useState<ScriptMetadata[]>([]);
  const [triggerSearch, setTriggerSearch] = useState('');
  const [triggerFilter, setTriggerFilter] = useState<string>('all');
  const [selectedScripts, setSelectedScripts] = useState<Set<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [scriptToDelete, setScriptToDelete] = useState<string | null>(null);

  // Re-seed the draft only when the SAVED values change content. A parent that
  // hands down a new `triggers` array with the same content (a re-render, a
  // context refresh) must not wipe an unsaved edit, so compare a serialised
  // key rather than the array's identity. The first run matches the key the
  // state was initialised from, so mount does not re-seed.
  const savedKey = useMemo(
    () => JSON.stringify([enabled, triggers, skipIncompleteNodes]),
    [enabled, triggers, skipIncompleteNodes],
  );
  const seededKeyRef = useRef(savedKey);
  useEffect(() => {
    if (seededKeyRef.current === savedKey) return;
    seededKeyRef.current = savedKey;
    setLocalEnabled(enabled);
    setLocalTriggers(triggers);
    setLocalSkipIncompleteNodes(skipIncompleteNodes);
  }, [savedKey, enabled, triggers, skipIncompleteNodes]);

  // Check if any settings have changed
  useEffect(() => {
    const changed = localEnabled !== enabled || JSON.stringify(localTriggers) !== JSON.stringify(triggers) || localSkipIncompleteNodes !== skipIncompleteNodes;
    setHasChanges(changed);
  }, [localEnabled, localTriggers, localSkipIncompleteNodes, enabled, triggers, skipIncompleteNodes]);

  // Reset local state to props (used by SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setLocalEnabled(enabled);
    setLocalTriggers(triggers);
    setLocalSkipIncompleteNodes(skipIncompleteNodes);
    setExpandedId(null);
    setErrorsById({});
  }, [enabled, triggers, skipIncompleteNodes]);

  // A trigger counts as edited when it differs from its saved copy. Only
  // edited (or new) triggers are validated and normalised, so a save never
  // rewrites a trigger the user did not touch.
  const savedJsonById = useMemo(
    () => new Map(triggers.map((tr) => [tr.id, JSON.stringify(tr)])),
    [triggers],
  );
  const isEdited = useCallback(
    (tr: AutoResponderTrigger) => savedJsonById.get(tr.id) !== JSON.stringify(tr),
    [savedJsonById],
  );

  // Once a trigger shows errors, re-check it as the user types so they clear.
  useEffect(() => {
    setErrorsById((prev) => {
      const ids = Object.keys(prev);
      if (ids.length === 0) return prev;
      const next: Record<string, TriggerErrors> = {};
      for (const id of ids) {
        const tr = localTriggers.find((x) => x.id === id);
        if (!tr) continue;
        const errs = validateAutoResponderTrigger(tr, t);
        if (hasErrors(errs)) next[id] = errs;
      }
      return next;
    });
  }, [localTriggers, t]);

  const updateTrigger = (id: string, patch: Partial<AutoResponderTrigger>) => {
    setLocalTriggers((prev) => prev.map((tr) => (tr.id === id ? { ...tr, ...patch } : tr)));
  };

  /** Validate and normalise the open trigger, then collapse it. False when it has errors. */
  const finishEditing = (id: string | null): boolean => {
    if (!id) return true;
    const tr = localTriggers.find((x) => x.id === id);
    if (tr && isEdited(tr)) {
      const errs = validateAutoResponderTrigger(tr, t);
      if (hasErrors(errs)) {
        setErrorsById((prev) => ({ ...prev, [id]: errs }));
        setExpandedId(id);
        return false;
      }
      setLocalTriggers((prev) => prev.map((x) => (x.id === id ? finalizeTrigger(x) : x)));
    }
    setErrorsById((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setExpandedId((cur) => (cur === id ? null : cur));
    return true;
  };

  const startEditing = (id: string) => {
    if (expandedId && expandedId !== id && !finishEditing(expandedId)) return;
    setExpandedId(id);
  };

  const addTrigger = (pattern = '') => {
    if (!finishEditing(expandedId)) return;
    const tr = { ...newAutoResponderTrigger(), trigger: pattern };
    setLocalTriggers((prev) => [...prev, tr]);
    setTriggerSearch('');
    setTriggerFilter('all');
    setExpandedId(tr.id);
  };

  const removeTrigger = (id: string) => {
    setLocalTriggers((prev) => prev.filter((tr) => tr.id !== id));
    setExpandedId((cur) => (cur === id ? null : cur));
    setErrorsById((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  // A pattern example fills the open trigger, or starts a new one.
  const selectExamplePattern = (pattern: string) => {
    if (expandedId) updateTrigger(expandedId, { trigger: pattern });
    else addTrigger(pattern);
  };

  // Fetch available scripts when component mounts and after import/delete
    const fetchScripts = async () => {
      try {
        const data = await apiService.get<{ scripts?: (ScriptMetadata | string)[] }>('/api/scripts');
        // Handle both new metadata format and legacy string array format
        const scripts: ScriptMetadata[] = (data.scripts || []).map((script: ScriptMetadata | string) => {
          if (typeof script === 'string') {
            // Legacy format - convert to metadata object
            const filename = script.split('/').pop() || script;
            const ext = filename.split('.').pop()?.toLowerCase() || '';
            const language = ext === 'py' ? 'Python' : ext === 'js' || ext === 'mjs' ? 'JavaScript' : ext === 'sh' ? 'Shell' : 'Script';
            return { path: script, filename, language };
          }
          return script;
        });
        setAvailableScripts(scripts);
      } catch (error) {
        console.error('Failed to fetch available scripts:', error);
      }
    };

  useEffect(() => {
    void fetchScripts();
  }, [baseUrl]);

  // Script management handlers
  const handleImportScript = async (file: File) => {
    setIsImporting(true);
    try {
      const fileContent = await file.arrayBuffer();
      const response = await csrfFetch(`${baseUrl}/api/scripts/import`, {
        method: 'POST',
        headers: {
          'x-filename': file.name,
          'Content-Type': 'application/octet-stream'
        },
        body: fileContent
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t('auto_responder.script_import_failed'));
      }

      showToast(t('auto_responder.script_imported'), 'success');
      await fetchScripts();
      setShowImportModal(false);
    } catch (error: any) {
      showToast(error.message || t('auto_responder.script_import_failed'), 'error');
    } finally {
      setIsImporting(false);
    }
  };

  const handleExportScripts = async () => {
    const scriptsToExport = selectedScripts.size > 0 
      ? Array.from(selectedScripts)
      : availableScripts;

    if (scriptsToExport.length === 0) {
      showToast(t('auto_responder.no_scripts_to_export'), 'warning');
      return;
    }

    setIsExporting(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/scripts/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scripts: scriptsToExport })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t('auto_responder.script_export_failed'));
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'scripts-export.zip';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      showToast(t('auto_responder.scripts_exported', { count: scriptsToExport.length }), 'success');
      setShowExportModal(false);
      setSelectedScripts(new Set());
    } catch (error: any) {
      showToast(error.message || t('auto_responder.script_export_failed'), 'error');
    } finally {
      setIsExporting(false);
    }
  };

  const handleDeleteScript = async (filename: string) => {
    setIsDeleting(filename);
    try {
      const response = await csrfFetch(`${baseUrl}/api/scripts/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t('auto_responder.script_delete_failed'));
      }

      showToast(t('auto_responder.script_deleted'), 'success');
      await fetchScripts();
      setSelectedScripts(prev => {
        const next = new Set(prev);
        next.delete(filename);
        return next;
      });
      setShowDeleteModal(false);
      setScriptToDelete(null);
    } catch (error: any) {
      showToast(error.message || t('auto_responder.script_delete_failed'), 'error');
    } finally {
      setIsDeleting(null);
    }
  };

  // Shared by the ×, Cancel and Escape, so every way out resets the picker.
  const closeImportModal = () => {
    setShowImportModal(false);
    const input = document.getElementById('script-import-input') as HTMLInputElement | null;
    const filenameDisplay = document.getElementById('script-import-filename');
    if (input) input.value = '';
    if (filenameDisplay) {
      filenameDisplay.textContent = t('auto_responder.no_file_selected');
      filenameDisplay.style.color = 'var(--color-text-subtle)';
    }
  };

  const closeDeleteModal = () => {
    setShowDeleteModal(false);
    setScriptToDelete(null);
  };

  const toggleScriptSelection = (script: string) => {
    setSelectedScripts(prev => {
      const next = new Set(prev);
      if (next.has(script)) {
        next.delete(script);
      } else {
        next.add(script);
      }
      return next;
    });
  };

  const selectAllScripts = () => {
    setSelectedScripts(new Set(availableScripts.map(s => s.path)));
  };

  const deselectAllScripts = () => {
    setSelectedScripts(new Set());
  };


  const handleSaveForSaveBar = useCallback(async () => {
    // Normalise every edited or new trigger the way Done does, and refuse to
    // save while one is invalid: open it and show its errors instead.
    const prepared = localTriggers.map((tr) => (isEdited(tr) ? finalizeTrigger(tr) : tr));
    for (const tr of prepared) {
      if (!isEdited(tr)) continue;
      const errs = validateAutoResponderTrigger(tr, t);
      if (hasErrors(errs)) {
        setErrorsById((prev) => ({ ...prev, [tr.id]: errs }));
        setExpandedId(tr.id);
        showToast(errs.trigger || errs.response || errs.channels || t('auto_responder.invalid_trigger'), 'error');
        return;
      }
    }

    setIsSaving(true);
    try {
      // Sync to backend
      const response = await csrfFetch(`${baseUrl}/api/settings${sourceQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoResponderEnabled: String(localEnabled),
          autoResponderTriggers: JSON.stringify(prepared),
          autoResponderSkipIncompleteNodes: String(localSkipIncompleteNodes)
        })
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('common.permission_denied'), 'error');
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }

      // Update parent state after successful API call
      setLocalTriggers(prepared);
      setExpandedId(null);
      setErrorsById({});
      onEnabledChange(localEnabled);
      onTriggersChange(prepared);
      onSkipIncompleteNodesChange(localSkipIncompleteNodes);

      setHasChanges(false);
      showToast(t('auto_responder.settings_saved'), 'success');
    } catch (error) {
      console.error('Failed to save auto-responder settings:', error);
      showToast(t('auto_responder.settings_save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localEnabled, localTriggers, localSkipIncompleteNodes, baseUrl, csrfFetch, sourceQuery, showToast, t, onEnabledChange, onTriggersChange, onSkipIncompleteNodesChange, isEdited]);

  // Register with SaveBar
  useSaveBar({
    numberScope,
    id: 'auto-responder',
    sectionName: t('auto_responder.title'),
    hasChanges,
    isSaving,
    onSave: handleSaveForSaveBar,
    onDismiss: resetChanges
  });

  const visibleTriggers = localTriggers.filter((tr) =>
    tr.id === expandedId || (
      matchesSearch(triggerSearch, patternText(tr.trigger), tr.response)
      && (triggerFilter === 'all' || tr.responseType === triggerFilter)
    ));

  const triggerSummary = (tr: AutoResponderTrigger): React.ReactNode => {
    switch (tr.responseType) {
      case 'script':
        return <code>{tr.response}{tr.scriptArgs ? ` ${tr.scriptArgs}` : ''}</code>;
      case 'traceroute':
        return <><UiIcon name="forward" size={13} /> {tr.response}</>;
      case 'mailbox':
        return t('auto_responder.mailbox_description');
      default:
        return tr.response;
    }
  };

  const triggerChips = (tr: AutoResponderTrigger): TriggerChip[] => {
    const chips: TriggerChip[] = [
      { label: tr.responseType.toUpperCase(), tone: 'accent' },
      { label: channelsLabel(tr), tone: 'info', title: t('auto_responder.channels_label') },
    ];
    if (tr.multiline) chips.push({ label: t('auto_responder.badge_multiline') });
    if (tr.verifyResponse) chips.push({ label: t('auto_responder.badge_verify'), tone: 'caution' });
    if (tr.cooldownSeconds && tr.cooldownSeconds > 0) {
      chips.push({ label: <><UiIcon name="timer" size={12} /> {tr.cooldownSeconds}s {t('auto_responder.cooldown_badge')}</> });
    }
    return chips;
  };

  // Mirrors the server: patterns tried in order, the first matching trigger
  // replies. Channel filters are not applied (the test message has no channel).
  const matchForTest = (tr: AutoResponderTrigger, text: string): PatternTestResult => {
    const m = matchAutoResponderTrigger(tr, text);
    if (!m) return { matched: false };
    const params = Object.entries(m.params);
    const detail = (
      <>
        {t('auto_responder.pattern_label')} {m.matchedPattern}
        {params.length > 0 && ` · ${params.map(([k, v]) => `${k}="${v}"`).join(', ')}`}
      </>
    );
    if (tr.responseType === 'text' || tr.responseType === 'http') {
      return { matched: true, detail, response: renderSampleResponse(tr, m.params), multiline: !!tr.multiline };
    }
    return { matched: true, detail: <>{detail}{tr.response ? ` · ${tr.response}` : ''}</> };
  };

  return (
    <NumberInputScope scope={numberScope}>
    <ConfigSection
      title={t('auto_responder.title')}
      enabled={localEnabled}
      onEnabledChange={setLocalEnabled}
      enableLabel={t('auto_responder.enable_aria', 'Enable Auto Responder')}
      docsUrl="https://meshmonitor.org/features/automation#auto-responder"
      headerActions={
        <ConfigHeaderCount>
          {t('automation.trigger_count', '{{count}} triggers', { count: localTriggers.length })}
        </ConfigHeaderCount>
      }
      description={t('auto_responder.description')}
      canWrite={canWrite}
      receiveOnly={receiveOnly}
    >
        <div className="setting-item" style={{ marginTop: '1rem', marginBottom: '1.5rem' }}>
          <label>
            {t('auto_responder.security')}
            <span className="setting-description">
              {t('auto_responder.security_description')}
            </span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            <input
              type="checkbox"
              id="autoResponderSkipIncomplete"
              checked={localSkipIncompleteNodes}
              onChange={(e) => setLocalSkipIncompleteNodes(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
            />
            <label htmlFor="autoResponderSkipIncomplete" style={{ margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>
              {t('auto_responder.skip_incomplete_nodes')}
            </label>
          </div>
          <div style={{ marginTop: '0.5rem', marginLeft: '1.75rem', fontSize: '0.9rem', color: 'var(--color-text-subtle)' }}>
            {t('auto_responder.skip_incomplete_description')}
          </div>
        </div>

        {/* Configured triggers (#5808: one TriggerCard each; Add opens a new one) */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            {t('auto_responder.configured_triggers_heading')}
            <span className="setting-description">
              {t('auto_responder.add_trigger_description')}
            </span>
          </label>

          {localTriggers.length > TRIGGER_FILTER_THRESHOLD && (
            <TriggerListFilter
              search={triggerSearch}
              onSearchChange={setTriggerSearch}
              type={triggerFilter}
              onTypeChange={setTriggerFilter}
              searchPlaceholder={t('auto_responder.search_triggers')}
              typeOptions={[
                { value: 'all', label: t('auto_responder.filter_all') },
                { value: 'text', label: t('auto_responder.type_text') },
                { value: 'http', label: t('auto_responder.type_http') },
                { value: 'script', label: t('auto_responder.type_script') },
                { value: 'traceroute', label: t('auto_responder.type_traceroute') },
                { value: 'mailbox', label: t('auto_responder.type_mailbox') },
              ]}
            />
          )}

          {localTriggers.length > 0 && (
            <div className={styles.legend}>
              <span className={styles.legendTitle}>{t('auto_responder.legend')}</span>
              <span className={styles.legendItem}><span className={styles.swatchLiteral} />{t('auto_responder.literal')}</span>
              <span className={styles.legendItem}><span className={styles.swatchParameter} />{t('auto_responder.parameter')}</span>
            </div>
          )}

          {localTriggers.length === 0 && (
            <ConfigEmptyState className={styles.empty}>{t('auto_responder.no_triggers_yet')}</ConfigEmptyState>
          )}

          {visibleTriggers.map((tr) => {
            const errors = errorsById[tr.id] ?? {};
            return (
              <TriggerCard
                key={tr.id}
                titleMono
                title={patternText(tr.trigger).trim()
                  ? <PatternHighlight trigger={tr.trigger} />
                  : <span className={styles.untitled}>{t('auto_responder.new_trigger')}</span>}
                summary={triggerSummary(tr)}
                chips={triggerChips(tr)}
                expanded={expandedId === tr.id}
                onEdit={() => startEditing(tr.id)}
                onDone={() => finishEditing(tr.id)}
                onDelete={() => removeTrigger(tr.id)}
                disabled={!localEnabled}
                invalid={hasErrors(errors)}
                deleteTitle={t('auto_responder.remove_trigger_title')}
                deleteMessage={t('auto_responder.remove_trigger_draft_confirm')}
                deletePreview={formatTriggerPatterns(tr.trigger) || undefined}
              >
                <TriggerEditor
                  trigger={tr}
                  onChange={(patch) => updateTrigger(tr.id, patch)}
                  errors={errors}
                  availableScripts={availableScripts}
                  channels={channels}
                  baseUrl={baseUrl}
                  disabled={!localEnabled}
                />
              </TriggerCard>
            );
          })}

          {localTriggers.length > 0 && visibleTriggers.length === 0 && (
            <ConfigEmptyState className={styles.empty}>{t('auto_responder.no_triggers_match')}</ConfigEmptyState>
          )}

          <button
            type="button"
            className={styles.addButton}
            onClick={() => addTrigger()}
            disabled={!localEnabled}
          >
            <UiIcon name="plus" size={14} /> {t('auto_responder.add_trigger')}
          </button>
        </div>

        {/* Local pattern test: never sends, never calls the server */}
        {localTriggers.length > 0 && (
          <PatternTestBox
            triggers={localTriggers}
            mode="first"
            getKey={(tr) => tr.id}
            getLabel={(tr) => <>{formatTriggerPatterns(tr.trigger)} <span className={styles.typeTag}>{tr.responseType.toUpperCase()}</span></>}
            match={matchForTest}
            defaultText={'w 33076\ntemp 72\nmsg hello world\nset temperature to 72'}
            title={t('auto_responder.test_pattern_matching')}
            description={t('auto_responder.test_box_description')}
            noMatchLabel={t('auto_responder.no_matching_trigger')}
          />
        )}

        {/* Pattern Examples Section */}
        <PatternExamples onSelectPattern={selectExamplePattern} disabled={!localEnabled} />

        {/* Script Management Section */}
        <ScriptManagement
          availableScripts={availableScripts}
          selectedScripts={selectedScripts}
          isImporting={isImporting}
          isExporting={isExporting}
          isDeleting={isDeleting}
          onImportClick={() => setShowImportModal(true)}
          onExportClick={() => {
            if (selectedScripts.size === 0 && availableScripts.length === 0) {
              showToast(t('auto_responder.no_scripts_to_export'), 'warning');
              return;
            }
            setShowExportModal(true);
          }}
          onDeleteClick={(filename) => {
            setScriptToDelete(filename);
            setShowDeleteModal(true);
          }}
          onToggleSelection={toggleScriptSelection}
          onSelectAll={selectAllScripts}
          onDeselectAll={deselectAllScripts}
        />

        {/* Import Modal */}
        {showImportModal && (
          <AutoResponderDialog onClose={closeImportModal} labelledBy="auto-responder-import-title">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 id="auto-responder-import-title" style={{ margin: 0, color: 'var(--color-text)' }}>{t('auto_responder.import_script')}</h3>
                <button
                  onClick={closeImportModal}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    fontSize: '1.5rem',
                    color: 'var(--color-text-subtle)',
                    cursor: 'pointer',
                    padding: '0',
                    lineHeight: '1'
                  }}
                >
                  ×
                </button>
              </div>
              <p style={{ color: 'var(--color-text-subtle)', fontSize: '0.875rem', marginBottom: '1rem' }}>
                {t('auto_responder.import_script_description')}
              </p>
              <input
                type="file"
                accept=".js,.mjs,.py,.sh"
                id="script-import-input"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  const filenameDisplay = document.getElementById('script-import-filename');
                  if (file) {
                    if (filenameDisplay) {
                      filenameDisplay.textContent = t('auto_responder.selected_file', { name: file.name });
                      filenameDisplay.style.color = 'var(--color-success)';
                    }
                    void handleImportScript(file);
                  } else {
                    if (filenameDisplay) {
                      filenameDisplay.textContent = t('auto_responder.no_file_selected');
                      filenameDisplay.style.color = 'var(--color-text-subtle)';
                    }
                  }
                }}
                style={{ display: 'none' }}
              />
              <label
                htmlFor="script-import-input"
                style={{
                  display: 'block',
                  padding: '0.75rem 1rem',
                  background: 'var(--color-accent)',
                  color: 'var(--color-bg)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  textAlign: 'center',
                  fontSize: '0.9rem',
                  marginBottom: '1rem',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-info)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--color-accent)';
                }}
              >
                <UiIcon name="file" size={14} /> {t('auto_responder.choose_file')}
              </label>
              <div id="script-import-filename" style={{ 
                color: 'var(--color-text-subtle)', 
                fontSize: '0.85rem', 
                fontStyle: 'italic',
                marginBottom: '1rem',
                minHeight: '1.2rem'
              }}>
                {t('auto_responder.no_file_selected')}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button
                  onClick={closeImportModal}
                  style={{
                    padding: '0.5rem 1rem',
                    background: 'var(--color-surface-hover)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border-subtle)',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  {t('common.cancel')}
                </button>
              </div>
          </AutoResponderDialog>
        )}

        {/* Export Modal */}
        {showExportModal && (
          <AutoResponderDialog onClose={() => setShowExportModal(false)} labelledBy="auto-responder-export-title">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 id="auto-responder-export-title" style={{ margin: 0, color: 'var(--color-text)' }}>{t('auto_responder.export_scripts')}</h3>
                <button
                  onClick={() => setShowExportModal(false)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    fontSize: '1.5rem',
                    color: 'var(--color-text-subtle)',
                    cursor: 'pointer',
                    padding: '0',
                    lineHeight: '1'
                  }}
                >
                  ×
                </button>
              </div>
              <p style={{ color: 'var(--color-text-subtle)', fontSize: '0.875rem', marginBottom: '1rem' }}>
                {selectedScripts.size > 0
                  ? t('auto_responder.export_selected_confirm', { count: selectedScripts.size })
                  : t('auto_responder.export_all_confirm', { count: availableScripts.length })}
              </p>
              {selectedScripts.size > 0 && (
                <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'var(--color-surface)', borderRadius: '4px', maxHeight: '200px', overflowY: 'auto' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-subtle)', marginBottom: '0.5rem', fontWeight: 'bold' }}>{t('auto_responder.selected_scripts')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    {Array.from(selectedScripts).map((script) => {
                      const filename = script.replace('/data/scripts/', '');
                      return (
                        <div key={script} style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--color-text)' }}>
                          <UiIcon name={getFileIcon(filename)} size={14} /> {filename}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setShowExportModal(false)}
                  style={{
                    padding: '0.5rem 1rem',
                    background: 'var(--color-surface-hover)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border-subtle)',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleExportScripts}
                  disabled={isExporting}
                  style={{
                    padding: '0.5rem 1rem',
                    background: isExporting ? 'var(--color-surface-active)' : 'var(--color-success)',
                    color: isExporting ? 'var(--color-text-subtle)' : 'var(--color-bg)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: isExporting ? 'not-allowed' : 'pointer',
                    fontWeight: 'bold'
                  }}
                >
                  {isExporting ? t('auto_responder.exporting') : <><UiIcon name="download" size={14} /> {t('auto_responder.download_zip')}</>}
                </button>
              </div>
          </AutoResponderDialog>
        )}

        {/* Delete Modal */}
        {showDeleteModal && scriptToDelete && (
          <AutoResponderDialog onClose={closeDeleteModal} labelledBy="auto-responder-delete-title">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 id="auto-responder-delete-title" style={{ margin: 0, color: 'var(--color-text)' }}>{t('auto_responder.delete_script')}</h3>
                <button
                  onClick={closeDeleteModal}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    fontSize: '1.5rem',
                    color: 'var(--color-text-subtle)',
                    cursor: 'pointer',
                    padding: '0',
                    lineHeight: '1'
                  }}
                >
                  ×
                </button>
              </div>
              <p style={{ color: 'var(--color-text-subtle)', fontSize: '0.875rem', marginBottom: '1rem' }}>
                <Trans
                  i18nKey="auto_responder.delete_script_confirm"
                  values={{ name: scriptToDelete }}
                  components={{ strong: <strong style={{ color: 'var(--color-text)' }} /> }}
                />
              </p>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button
                  onClick={closeDeleteModal}
                  style={{
                    padding: '0.5rem 1rem',
                    background: 'var(--color-surface-hover)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border-subtle)',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => handleDeleteScript(scriptToDelete)}
                  disabled={isDeleting === scriptToDelete}
                  style={{
                    padding: '0.5rem 1rem',
                    background: isDeleting === scriptToDelete ? 'var(--color-surface-active)' : 'var(--color-error)',
                    color: isDeleting === scriptToDelete ? 'var(--color-text-subtle)' : 'var(--color-bg)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: isDeleting === scriptToDelete ? 'not-allowed' : 'pointer',
                    fontWeight: 'bold'
                  }}
                >
                  {isDeleting === scriptToDelete ? t('auto_responder.deleting') : t('common.delete')}
                </button>
              </div>
          </AutoResponderDialog>
        )}
    </ConfigSection>
    </NumberInputScope>
  );
};

export default AutoResponderSection;
