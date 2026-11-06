import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { UiIcon } from '../icons';
import { ConfigSection, ConfigHeaderCount } from '../shared/config/ConfigSection';
import { ConfigEmptyState } from '../shared/config/ConfigEmptyState';
import { TriggerCard, type TriggerChip } from '../shared/automation/TriggerCard';
import { TriggerListFilter } from '../shared/automation/TriggerListFilter';
import { PatternTestBox, type PatternTestResult } from '../shared/automation/PatternTestBox';
import { TRIGGER_FILTER_THRESHOLD, matchesSearch, newTriggerId } from '../shared/automation/triggerList';
import { MeshCoreResponderTriggerEditor } from './MeshCoreResponderTriggerEditor';
import { validateMeshCoreResponderPattern, matchMeshCoreResponderPattern, meshCoreTriggerSyntax } from './meshcoreResponderMatch';
import { substituteResponderParams } from '../../utils/responderTrigger';
import ScriptManagement from '../auto-responder/ScriptManagement';
import AutoResponderDialog from '../auto-responder/AutoResponderDialog';
import { getFileIcon } from '../auto-responder/utils';
// The shared script library (/api/scripts) is global, so the Script
// Management panel here manages the SAME scripts as the Meshtastic responder
// (#6223). Reuse that panel's canonical metadata type (required `language`).
import type { ScriptMetadata } from '../auto-responder/types';
import type {
  MeshCoreAutoResponderTrigger,
  MeshCoreChannelRow,
} from './meshcoreResponderTypes';
import { meshCoreReceiveOnlyText } from './meshCoreReceiveOnlyText';
import styles from './MeshCoreAutoResponderSection.module.css';

interface MeshCoreAutoResponderSectionProps {
  baseUrl: string;
  sourceId: string;
  /** True when this MeshCore source is in strict receive-only mode (#4547
   *  Phase 2). Plumbed here in WP1; WP4 renders the paused note. This
   *  section has no immediate-TX control, so no input gates on it. */
  receiveOnly?: boolean;
}

/** Infer a display language from a script's extension (mirrors the Meshtastic panel). */
const inferScriptLanguage = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return ext === 'py' ? 'Python' : ext === 'js' || ext === 'mjs' ? 'JavaScript' : ext === 'sh' ? 'Shell' : 'Script';
};

const newTrigger = (): MeshCoreAutoResponderTrigger => ({
  id: newTriggerId(),
  name: '',
  enabled: true,
  pattern: '',
  // New triggers use the placeholder DSL, as on Meshtastic (#5924). Saved
  // triggers with no syntax stay regex (meshCoreTriggerSyntax).
  syntax: 'pattern',
  responseType: 'text',
  response: '',
  channels: [],
  listenDMs: true,
  replyAsDM: false,
  cooldownSeconds: 60,
  preSendDelaySeconds: 0,
  scopeMode: 'inherit',
  scopeName: '',
});

export const MeshCoreAutoResponderSection: React.FC<MeshCoreAutoResponderSectionProps> = ({ baseUrl, sourceId, receiveOnly = false }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('automation', 'write');

  const [enabled, setEnabled] = useState(false);
  const [initialEnabled, setInitialEnabled] = useState(false);
  const [triggers, setTriggers] = useState<MeshCoreAutoResponderTrigger[]>([]);
  const [initialTriggers, setInitialTriggers] = useState<MeshCoreAutoResponderTrigger[]>([]);
  const [channels, setChannels] = useState<MeshCoreChannelRow[]>([]);
  const [scripts, setScripts] = useState<ScriptMetadata[]>([]);
  // Script Management panel state (#6223), mirroring the Meshtastic responder.
  const [selectedScripts, setSelectedScripts] = useState<Set<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [scriptToDelete, setScriptToDelete] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // #5808: one trigger open in its TriggerCard at a time. Regex errors show
  // live, as before; a missing name or empty pattern shows once Done or Save
  // has been tried (`attemptedIds`), so a new trigger does not open in red.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [attemptedIds, setAttemptedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  // Load triggers
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(`${baseUrl}/api/sources/${sourceId}/meshcore/automation/responder`);
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled || !json.success || !json.data) return;
        const list: MeshCoreAutoResponderTrigger[] = Array.isArray(json.data.triggers) ? json.data.triggers : [];
        setEnabled(!!json.data.enabled);
        setInitialEnabled(!!json.data.enabled);
        setTriggers(list);
        setInitialTriggers(list);
        setLoaded(true);
      } catch { /* keep defaults */ }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, csrfFetch]);

  // Load channels
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(`${baseUrl}/api/channels/all?sourceId=${encodeURIComponent(sourceId)}`);
        if (!res.ok) return;
        const raw = await res.json();
        if (cancelled) return;
        const rows: MeshCoreChannelRow[] = Array.isArray(raw)
          ? raw
              .filter((c: any) => typeof c?.id === 'number')
              .map((c: any) => ({ id: c.id as number, name: String(c.name ?? '') }))
              .sort((a, b) => a.id - b.id)
          : [];
        setChannels(rows);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, csrfFetch]);

  // Load available scripts. Feeds both the responseType='script' picker and
  // the Script Management panel; re-run after an import/delete to refresh both.
  const loadScripts = useCallback(async () => {
    try {
      const res = await csrfFetch(`${baseUrl}/api/scripts`);
      if (!res.ok) return;
      const raw = await res.json();
      const rawScripts: any[] = Array.isArray(raw?.scripts) ? raw.scripts : [];
      const list: ScriptMetadata[] = rawScripts
        .filter((s) => typeof s?.path === 'string')
        .map((s) => {
          const filename: string = s.filename ?? String(s.path).split('/').pop() ?? String(s.path);
          return {
            path: String(s.path),
            filename,
            name: s.name,
            emoji: s.emoji,
            language: s.language || inferScriptLanguage(filename),
          };
        });
      setScripts(list);
    } catch { /* ignore */ }
  }, [baseUrl, csrfFetch]);

  useEffect(() => { void loadScripts(); }, [loadScripts]);

  // Detect changes
  useEffect(() => {
    if (!loaded) return;
    const triggersChanged = JSON.stringify(triggers) !== JSON.stringify(initialTriggers);
    setHasChanges(enabled !== initialEnabled || triggersChanged);
  }, [enabled, initialEnabled, triggers, initialTriggers, loaded]);

  // A new trigger needs a name (the old Add card's rule); a saved one keeps
  // whatever name it has, as before. Every regex is checked.
  const savedIds = useMemo(() => new Set(initialTriggers.map((tr) => tr.id)), [initialTriggers]);
  const nameMissing = useCallback(
    (tr: MeshCoreAutoResponderTrigger) => !savedIds.has(tr.id) && !tr.name.trim(),
    [savedIds],
  );

  const handleSave = useCallback(async () => {
    // Validate every trigger up front so the operator sees the bad one
    // before a round-trip; open it so the error shows in place.
    for (const tr of triggers) {
      const v = validateMeshCoreResponderPattern(tr.pattern, meshCoreTriggerSyntax(tr));
      const noName = nameMissing(tr);
      if (!v.valid || noName) {
        setAttemptedIds((prev) => new Set(prev).add(tr.id));
        setExpandedId(tr.id);
        showToast(
          `Trigger "${tr.name || tr.id}": ${v.error ?? t('meshcore.automation.responder.name_required', 'Name is required')}`,
          'error',
        );
        return;
      }
    }
    setIsSaving(true);
    try {
      const res = await csrfFetch(
        `${baseUrl}/api/sources/${sourceId}/meshcore/automation/responder`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled, triggers }),
        },
      );
      if (!res.ok) {
        if (res.status === 403) {
          showToast(t('automation.insufficient_permissions', 'Insufficient permissions'), 'error');
          return;
        }
        const errText = await res.text().catch(() => '');
        throw new Error(`Server returned ${res.status}: ${errText}`);
      }
      setInitialEnabled(enabled);
      setInitialTriggers(triggers);
      setHasChanges(false);
      setExpandedId(null);
      setAttemptedIds(new Set());
      showToast(t('automation.settings_saved', 'Settings saved'), 'success');
    } catch (err) {
      console.error('Failed to save MeshCore auto-responder settings:', err);
      showToast(t('automation.settings_save_failed', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [enabled, triggers, baseUrl, sourceId, csrfFetch, showToast, t, nameMissing]);

  const handleDismiss = useCallback(() => {
    setEnabled(initialEnabled);
    setTriggers(initialTriggers);
    setHasChanges(false);
    setExpandedId(null);
    setAttemptedIds(new Set());
  }, [initialEnabled, initialTriggers]);

  const numberScope = useNumberInputScope();
  useSaveBar({
    numberScope,
    id: 'meshcore-auto-responder',
    sectionName: t('meshcore.automation.responder.title', 'Auto-Responder'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const updateTrigger = (id: string, patch: Partial<MeshCoreAutoResponderTrigger>) => {
    setTriggers(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  };
  const removeTrigger = (id: string) => {
    setTriggers(prev => prev.filter(t => t.id !== id));
    setExpandedId((cur) => (cur === id ? null : cur));
  };

  /** Collapse the open trigger if it is valid. False keeps it open with its errors. */
  const finishEditing = (id: string | null): boolean => {
    if (!id) return true;
    const tr = triggers.find((x) => x.id === id);
    if (tr) {
      if (!validateMeshCoreResponderPattern(tr.pattern, meshCoreTriggerSyntax(tr)).valid || nameMissing(tr)) {
        setAttemptedIds((prev) => new Set(prev).add(id));
        setExpandedId(id);
        return false;
      }
    }
    setAttemptedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setExpandedId((cur) => (cur === id ? null : cur));
    return true;
  };

  const startEditing = (id: string) => {
    if (expandedId && expandedId !== id && !finishEditing(expandedId)) return;
    setExpandedId(id);
  };

  const addTrigger = () => {
    if (!finishEditing(expandedId)) return;
    const tr = newTrigger();
    setTriggers(prev => [...prev, tr]);
    setSearch('');
    setTypeFilter('all');
    setExpandedId(tr.id);
  };

  // Script Management handlers (#6223). The /api/scripts library is global, so
  // these manage the SAME scripts as the Meshtastic responder panel. After any
  // import/delete, loadScripts() refreshes both the picker and the panel list.
  const handleImportScript = async (file: File) => {
    setIsImporting(true);
    try {
      const fileContent = await file.arrayBuffer();
      const response = await csrfFetch(`${baseUrl}/api/scripts/import`, {
        method: 'POST',
        headers: {
          'x-filename': file.name,
          'Content-Type': 'application/octet-stream',
        },
        body: fileContent,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || t('auto_responder.script_import_failed'));
      }
      showToast(t('auto_responder.script_imported'), 'success');
      await loadScripts();
      setShowImportModal(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      showToast(message || t('auto_responder.script_import_failed'), 'error');
    } finally {
      setIsImporting(false);
    }
  };

  const handleExportScripts = async () => {
    const scriptsToExport = selectedScripts.size > 0
      ? Array.from(selectedScripts)
      : scripts.map(s => s.path);

    if (scriptsToExport.length === 0) {
      showToast(t('auto_responder.no_scripts_to_export'), 'warning');
      return;
    }

    setIsExporting(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/scripts/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scripts: scriptsToExport }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
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
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      showToast(message || t('auto_responder.script_export_failed'), 'error');
    } finally {
      setIsExporting(false);
    }
  };

  const handleDeleteScript = async (filename: string) => {
    setIsDeleting(filename);
    try {
      const response = await csrfFetch(`${baseUrl}/api/scripts/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || t('auto_responder.script_delete_failed'));
      }
      showToast(t('auto_responder.script_deleted'), 'success');
      await loadScripts();
      setSelectedScripts(prev => {
        const next = new Set(prev);
        next.delete(filename);
        return next;
      });
      setShowDeleteModal(false);
      setScriptToDelete(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      showToast(message || t('auto_responder.script_delete_failed'), 'error');
    } finally {
      setIsDeleting(null);
    }
  };

  // Shared by the ×, Cancel and Escape, so every way out resets the picker.
  const closeImportModal = () => {
    setShowImportModal(false);
    const input = document.getElementById('meshcore-script-import-input') as HTMLInputElement | null;
    const filenameDisplay = document.getElementById('meshcore-script-import-filename');
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
      if (next.has(script)) next.delete(script);
      else next.add(script);
      return next;
    });
  };

  const selectAllScripts = () => setSelectedScripts(new Set(scripts.map(s => s.path)));
  const deselectAllScripts = () => setSelectedScripts(new Set());

  const channelMap = useMemo(() => {
    const m = new Map<number, string>();
    channels.forEach(c => m.set(c.id, c.name || `Channel ${c.id}`));
    return m;
  }, [channels]);

  const disabled = !enabled;

  const visible = triggers.filter((tr) =>
    tr.id === expandedId || (
      matchesSearch(search, tr.name, tr.pattern, tr.response, tr.scriptPath)
      && (typeFilter === 'all' || (tr.responseType || 'text') === typeFilter)
    ));

  // A regex shows as /…/; a DSL pattern shows as written.
  const patternLabel = (tr: MeshCoreAutoResponderTrigger): string =>
    meshCoreTriggerSyntax(tr) === 'regex' ? `/${tr.pattern}/` : tr.pattern;

  const summaryOf = (tr: MeshCoreAutoResponderTrigger): React.ReactNode => (
    <>
      <code>{patternLabel(tr)}</code> <UiIcon name="forward" size={12} />{' '}
      {(tr.responseType || 'text') === 'script'
        ? <code>{tr.scriptPath || t('meshcore.automation.responder.select_script', '(select script)')}{tr.scriptArgs ? ` ${tr.scriptArgs}` : ''}</code>
        : tr.response}
    </>
  );

  const chipsOf = (tr: MeshCoreAutoResponderTrigger): TriggerChip[] => {
    const chips: TriggerChip[] = [];
    if ((tr.responseType || 'text') === 'script') {
      chips.push({ label: t('meshcore.automation.responder.response_script', 'Run script'), tone: 'accent' });
    }
    if (tr.listenDMs) chips.push({ label: t('meshcore.automation.responder.chip_dm', 'DMs'), tone: 'info' });
    tr.channels.forEach((id) => chips.push({ label: channelMap.get(id) ?? `Channel ${id}`, tone: 'info' }));
    if (tr.replyAsDM) chips.push({ label: t('meshcore.automation.responder.reply_dm', 'Reply as DM') });
    if (tr.cooldownSeconds > 0) {
      chips.push({ label: <><UiIcon name="timer" size={12} /> {tr.cooldownSeconds}s</>, title: t('meshcore.automation.responder.cooldown', 'Cooldown (s)') });
    }
    if ((tr.preSendDelaySeconds ?? 0) > 0) {
      chips.push({ label: t('meshcore.automation.responder.chip_delay', '+{{seconds}}s delay', { seconds: tr.preSendDelaySeconds }) });
    }
    if (tr.scopeMode && tr.scopeMode !== 'inherit') {
      chips.push({ label: tr.scopeMode === 'named' ? `#${tr.scopeName ?? ''}` : tr.scopeMode, tone: 'caution' });
    }
    return chips;
  };

  // Mirrors the server: every enabled trigger whose pattern matches, in its
  // own syntax, replies. Channel / DM filters are not applied (the test
  // message has neither).
  const matchForTest = (tr: MeshCoreAutoResponderTrigger, text: string): PatternTestResult => {
    if (!tr.enabled) return { matched: false };
    const m = matchMeshCoreResponderPattern(tr.pattern, text, meshCoreTriggerSyntax(tr));
    if (!m.matched) return { matched: false };
    const params = Object.entries(m.params);
    const detail = (
      <>
        {patternLabel(tr)}
        {params.length > 0 && ` · ${params.map(([k, v]) => `${k}="${v}"`).join(', ')}`}
      </>
    );
    if ((tr.responseType || 'text') === 'script') {
      return { matched: true, detail: <>{detail} · {tr.scriptPath}</> };
    }
    return { matched: true, detail, response: substituteResponderParams(tr.response, m.params) };
  };

  return (
    <NumberInputScope scope={numberScope}>
      <ConfigSection
        title={t('meshcore.automation.responder.title', 'Auto-Responder')}
        enabled={enabled}
        onEnabledChange={setEnabled}
        enableLabel={t('meshcore.automation.responder.title', 'Auto-Responder')}
        docsUrl="https://meshmonitor.org/features/meshcore#auto-responder"
        canWrite={canWrite}
        receiveOnly={receiveOnly}
        receiveOnlyNote={meshCoreReceiveOnlyText(t)}
        headerActions={
          <ConfigHeaderCount>
            {t('automation.trigger_count', '{{count}} triggers', { count: triggers.length })}
          </ConfigHeaderCount>
        }
        description={t(
          'meshcore.automation.responder.description',
          'Match incoming messages against operator-defined patterns and reply with a text response. Each trigger supports per-channel filtering, DM listening, and a per-sender cooldown.',
        )}
      >
        {triggers.length > TRIGGER_FILTER_THRESHOLD && (
          <TriggerListFilter
            search={search}
            onSearchChange={setSearch}
            type={typeFilter}
            onTypeChange={setTypeFilter}
            typeOptions={[
              { value: 'all', label: t('meshcore.automation.responder.filter_all', 'All actions') },
              { value: 'text', label: t('meshcore.automation.responder.response_text', 'Send text') },
              { value: 'script', label: t('meshcore.automation.responder.response_script', 'Run script') },
            ]}
          />
        )}

        {triggers.length === 0 && (
          <ConfigEmptyState className={styles.empty}>
            {t('meshcore.automation.responder.empty', 'No triggers configured yet.')}
          </ConfigEmptyState>
        )}

        {visible.map(tr => {
          const v = validateMeshCoreResponderPattern(tr.pattern, meshCoreTriggerSyntax(tr));
          const attempted = attemptedIds.has(tr.id);
          const patternError = !v.valid && (tr.pattern || attempted) ? v.error : undefined;
          const nameError = attempted && nameMissing(tr)
            ? t('meshcore.automation.responder.name_required', 'Name is required')
            : undefined;
          return (
            <TriggerCard
              key={tr.id}
              title={tr.name.trim() || <span className={styles.untitled}>{t('meshcore.automation.responder.untitled', 'New trigger')}</span>}
              summary={summaryOf(tr)}
              chips={chipsOf(tr)}
              enabled={tr.enabled}
              onEnabledChange={(on) => updateTrigger(tr.id, { enabled: on })}
              enableLabel={t('meshcore.automation.responder.enable_trigger', 'Enable {{name}}', { name: tr.name.trim() || t('meshcore.automation.responder.untitled', 'New trigger') })}
              expanded={expandedId === tr.id}
              onEdit={() => startEditing(tr.id)}
              onDone={() => finishEditing(tr.id)}
              onDelete={() => removeTrigger(tr.id)}
              disabled={disabled}
              invalid={!!patternError || !!nameError}
              deletePreview={tr.name || tr.pattern || undefined}
            >
              <MeshCoreResponderTriggerEditor
                trigger={tr}
                onChange={(patch) => updateTrigger(tr.id, patch)}
                patternError={patternError}
                nameError={nameError}
                channels={channels}
                scripts={scripts}
                baseUrl={baseUrl}
                sourceId={sourceId}
                disabled={disabled}
              />
            </TriggerCard>
          );
        })}

        {triggers.length > 0 && visible.length === 0 && (
          <ConfigEmptyState className={styles.empty}>
            {t('meshcore.automation.responder.no_match', 'No triggers match your search.')}
          </ConfigEmptyState>
        )}

        <button
          type="button"
          onClick={addTrigger}
          disabled={disabled}
          className="meshcore-btn meshcore-btn-primary"
        >
          <UiIcon name="plus" size={14} /> {t('meshcore.automation.responder.add_button', 'Add trigger')}
        </button>

        {/* Local pattern test: never sends, never calls the server */}
        {triggers.length > 0 && (
          <PatternTestBox
            triggers={triggers}
            mode="all"
            getKey={(tr) => tr.id}
            getLabel={(tr) => tr.name || patternLabel(tr)}
            match={matchForTest}
            description={t(
              'meshcore.automation.responder.test_description',
              'Type sample messages, one per line. Every enabled trigger whose pattern matches, in its own syntax, replies. Captured {name} values are filled in here; tokens such as {VERSION} are filled in when the reply is sent. Nothing is sent from here, and channel filters are not applied.',
            )}
          />
        )}

        {/* Script Management (#6223): manages the shared, global /api/scripts
            library — the same scripts the Meshtastic responder panel manages. */}
        <ScriptManagement
          availableScripts={scripts}
          selectedScripts={selectedScripts}
          isImporting={isImporting}
          isExporting={isExporting}
          isDeleting={isDeleting}
          onImportClick={() => setShowImportModal(true)}
          onExportClick={() => {
            if (selectedScripts.size === 0 && scripts.length === 0) {
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
          <AutoResponderDialog onClose={closeImportModal} labelledBy="meshcore-script-import-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 id="meshcore-script-import-title" style={{ margin: 0, color: 'var(--color-text)' }}>{t('auto_responder.import_script')}</h3>
              <button
                onClick={closeImportModal}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '1.5rem',
                  color: 'var(--color-text-subtle)',
                  cursor: 'pointer',
                  padding: '0',
                  lineHeight: '1',
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
              id="meshcore-script-import-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                const filenameDisplay = document.getElementById('meshcore-script-import-filename');
                if (file) {
                  if (filenameDisplay) {
                    filenameDisplay.textContent = t('auto_responder.selected_file', { name: file.name });
                    filenameDisplay.style.color = 'var(--color-success)';
                  }
                  void handleImportScript(file);
                } else if (filenameDisplay) {
                  filenameDisplay.textContent = t('auto_responder.no_file_selected');
                  filenameDisplay.style.color = 'var(--color-text-subtle)';
                }
              }}
              style={{ display: 'none' }}
            />
            <label
              htmlFor="meshcore-script-import-input"
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
              }}
            >
              <UiIcon name="file" size={14} /> {t('auto_responder.choose_file')}
            </label>
            <div id="meshcore-script-import-filename" style={{
              color: 'var(--color-text-subtle)',
              fontSize: '0.85rem',
              fontStyle: 'italic',
              marginBottom: '1rem',
              minHeight: '1.2rem',
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
                  cursor: 'pointer',
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </AutoResponderDialog>
        )}

        {/* Export Modal */}
        {showExportModal && (
          <AutoResponderDialog onClose={() => setShowExportModal(false)} labelledBy="meshcore-script-export-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 id="meshcore-script-export-title" style={{ margin: 0, color: 'var(--color-text)' }}>{t('auto_responder.export_scripts')}</h3>
              <button
                onClick={() => setShowExportModal(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '1.5rem',
                  color: 'var(--color-text-subtle)',
                  cursor: 'pointer',
                  padding: '0',
                  lineHeight: '1',
                }}
              >
                ×
              </button>
            </div>
            <p style={{ color: 'var(--color-text-subtle)', fontSize: '0.875rem', marginBottom: '1rem' }}>
              {selectedScripts.size > 0
                ? t('auto_responder.export_selected_confirm', { count: selectedScripts.size })
                : t('auto_responder.export_all_confirm', { count: scripts.length })}
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
                  cursor: 'pointer',
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
                  fontWeight: 'bold',
                }}
              >
                {isExporting ? t('auto_responder.exporting') : <><UiIcon name="download" size={14} /> {t('auto_responder.download_zip')}</>}
              </button>
            </div>
          </AutoResponderDialog>
        )}

        {/* Delete Modal */}
        {showDeleteModal && scriptToDelete && (
          <AutoResponderDialog onClose={closeDeleteModal} labelledBy="meshcore-script-delete-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 id="meshcore-script-delete-title" style={{ margin: 0, color: 'var(--color-text)' }}>{t('auto_responder.delete_script')}</h3>
              <button
                onClick={closeDeleteModal}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '1.5rem',
                  color: 'var(--color-text-subtle)',
                  cursor: 'pointer',
                  padding: '0',
                  lineHeight: '1',
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
                  cursor: 'pointer',
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
                  fontWeight: 'bold',
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

export default MeshCoreAutoResponderSection;
