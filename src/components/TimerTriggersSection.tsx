import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { TimerTrigger, ScriptMetadata } from './auto-responder/types';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSourceQuery } from '../hooks/useSourceQuery';
import { Channel } from '../types/device';
import { useSaveBar } from '../hooks/useSaveBar';
import ScriptTestModal from './ScriptTestModal';
import { UiIcon } from './icons';
import { ConfigSection, ConfigHeaderCount } from './shared/config/ConfigSection';
import { ConfigEmptyState } from './shared/config/ConfigEmptyState';
import { TriggerCard, TriggerCardAction, type TriggerChip } from './shared/automation/TriggerCard';
import { TriggerListFilter } from './shared/automation/TriggerListFilter';
import { TRIGGER_FILTER_THRESHOLD, matchesSearch } from './shared/automation/triggerList';
import TimerTriggerEditor from './timer-triggers/TimerTriggerEditor';
import {
  type TimerTriggerErrors,
  validateTimerTrigger,
  hasTimerErrors,
  firstTimerError,
  finalizeTimerTrigger,
  newTimerTrigger,
  timerResponseType,
} from './timer-triggers/timerTriggerModel';
import apiService from '../services/api';
import styles from './TimerTriggersSection.module.css';

interface TimerTriggersSectionProps {
  triggers: TimerTrigger[];
  channels: Channel[];
  baseUrl: string;
  onTriggersChange: (triggers: TimerTrigger[]) => void;
  /** False disables every control (no automation write permission). Default true. */
  canWrite?: boolean;
  /** True when the source cannot transmit; shows the paused note. */
  receiveOnly?: boolean;
}

/**
 * Meshtastic Timer Triggers (#5812): one TriggerCard per timer. Add appends a
 * new timer opened in its card; Done and Save validate edited or new timers
 * only, so a timer the user did not touch is saved exactly as loaded.
 */
const TimerTriggersSection: React.FC<TimerTriggersSectionProps> = ({
  triggers,
  channels,
  baseUrl,
  onTriggersChange,
  canWrite = true,
  receiveOnly = false,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const sourceQuery = useSourceQuery();
  const { showToast } = useToast();

  // `saved` is the last persisted list: the prop, or what we just saved, so
  // the SaveBar clears on success without waiting for the parent.
  const [saved, setSaved] = useState<TimerTrigger[]>(triggers);
  const [localTriggers, setLocalTriggers] = useState<TimerTrigger[]>(triggers);
  const [isSaving, setIsSaving] = useState(false);
  const [availableScripts, setAvailableScripts] = useState<ScriptMetadata[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [errorsById, setErrorsById] = useState<Record<string, TimerTriggerErrors>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  // Re-seed only when the saved prop changes content, so a parent re-render
  // with an equal array does not wipe an unsaved edit.
  const propKey = useMemo(() => JSON.stringify(triggers), [triggers]);
  const seededKeyRef = useRef(propKey);
  useEffect(() => {
    if (seededKeyRef.current === propKey) return;
    seededKeyRef.current = propKey;
    setSaved(triggers);
    setLocalTriggers(triggers);
    setExpandedId(null);
    setErrorsById({});
  }, [propKey, triggers]);

  const hasChanges = useMemo(
    () => JSON.stringify(localTriggers) !== JSON.stringify(saved),
    [localTriggers, saved],
  );

  // A timer counts as edited when it differs from its saved copy in anything
  // but the enable flag. Only edited (or new) timers are validated and
  // normalised; flipping the card toggle alone saves the timer as it was.
  const savedById = useMemo(() => new Map(saved.map((tr) => [tr.id, tr])), [saved]);
  const isEdited = useCallback((tr: TimerTrigger) => {
    const orig = savedById.get(tr.id);
    if (!orig) return true;
    return JSON.stringify({ ...tr, enabled: orig.enabled }) !== JSON.stringify(orig);
  }, [savedById]);

  // Fetch available scripts with metadata
  useEffect(() => {
    const fetchScripts = async () => {
      try {
        const data = await apiService.get<{ scripts?: (ScriptMetadata | string)[] }>('/api/scripts');
        // Handle both new metadata format and legacy string array format
        const scripts: ScriptMetadata[] = (data.scripts || []).map((script: ScriptMetadata | string) => {
          if (typeof script === 'string') {
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
    void fetchScripts();
  }, [baseUrl]);

  // Once a timer shows errors, re-check it as the user types so they clear.
  useEffect(() => {
    setErrorsById((prev) => {
      const ids = Object.keys(prev);
      if (ids.length === 0) return prev;
      const next: Record<string, TimerTriggerErrors> = {};
      for (const id of ids) {
        const tr = localTriggers.find((x) => x.id === id);
        if (!tr) continue;
        const errs = validateTimerTrigger(tr, t);
        if (hasTimerErrors(errs)) next[id] = errs;
      }
      return next;
    });
  }, [localTriggers, t]);

  const updateTrigger = (id: string, patch: Partial<TimerTrigger>) => {
    setLocalTriggers((prev) => prev.map((tr) => (tr.id === id ? { ...tr, ...patch } : tr)));
  };

  const clearErrors = (id: string) => {
    setErrorsById((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  /** Validate and normalise the open timer, then collapse it. False when it has errors. */
  const finishEditing = (id: string | null): boolean => {
    if (!id) return true;
    const tr = localTriggers.find((x) => x.id === id);
    if (tr && isEdited(tr)) {
      const errs = validateTimerTrigger(tr, t);
      if (hasTimerErrors(errs)) {
        setErrorsById((prev) => ({ ...prev, [id]: errs }));
        setExpandedId(id);
        return false;
      }
      setLocalTriggers((prev) => prev.map((x) => (x.id === id ? finalizeTimerTrigger(x) : x)));
    }
    clearErrors(id);
    setExpandedId((cur) => (cur === id ? null : cur));
    return true;
  };

  const startEditing = (id: string) => {
    if (expandedId && expandedId !== id && !finishEditing(expandedId)) return;
    setExpandedId(id);
  };

  const addTrigger = () => {
    if (!finishEditing(expandedId)) return;
    const tr = newTimerTrigger();
    setLocalTriggers((prev) => [...prev, tr]);
    setSearch('');
    setTypeFilter('all');
    setExpandedId(tr.id);
  };

  const removeTrigger = (id: string) => {
    setLocalTriggers((prev) => prev.filter((tr) => tr.id !== id));
    setExpandedId((cur) => (cur === id ? null : cur));
    clearErrors(id);
  };

  const handleSaveForSaveBar = useCallback(async () => {
    // Normalise every edited or new timer the way Done does, and refuse to
    // save while one is invalid: open it and show its errors instead.
    const prepared = localTriggers.map((tr) => (isEdited(tr) ? finalizeTimerTrigger(tr) : tr));
    for (const tr of prepared) {
      if (!isEdited(tr)) continue;
      const errs = validateTimerTrigger(tr, t);
      if (hasTimerErrors(errs)) {
        setErrorsById((prev) => ({ ...prev, [tr.id]: errs }));
        setExpandedId(tr.id);
        showToast(firstTimerError(errs) ?? t('automation.timer_triggers.save_failed', 'Failed to save timer triggers'), 'error');
        return;
      }
    }

    setIsSaving(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings${sourceQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timerTriggers: JSON.stringify(prepared),
        }),
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('common.permission_denied', 'Permission denied'), 'error');
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }

      setLocalTriggers(prepared);
      setSaved(prepared);
      setExpandedId(null);
      setErrorsById({});
      onTriggersChange(prepared);
      showToast(t('automation.timer_triggers.saved', 'Timer triggers saved'), 'success');
    } catch (error) {
      console.error('Failed to save timer triggers:', error);
      showToast(t('automation.timer_triggers.save_failed', 'Failed to save timer triggers'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localTriggers, isEdited, baseUrl, csrfFetch, sourceQuery, showToast, t, onTriggersChange]);

  // Reset local state to the saved list (SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setLocalTriggers(saved);
    setExpandedId(null);
    setErrorsById({});
  }, [saved]);

  useSaveBar({
    id: 'timer-triggers',
    sectionName: t('automation.timer_triggers.title', 'Timer Triggers'),
    hasChanges,
    isSaving,
    onSave: handleSaveForSaveBar,
    onDismiss: resetChanges,
  });

  const channelLabel = (tr: TimerTrigger): string => {
    if (tr.channel === 'none') return t('automation.timer_triggers.chip_no_output', 'No mesh output');
    const id = tr.channel ?? 0;
    const name = channels.find((c) => c.id === id)?.name;
    return name ? `Ch ${id}: ${name}` : `Channel ${id}`;
  };

  const summaryOf = (tr: TimerTrigger): React.ReactNode => {
    let action: React.ReactNode;
    if (timerResponseType(tr) === 'script') {
      const meta = tr.scriptPath ? availableScripts.find((s) => s.path === tr.scriptPath) : undefined;
      const filename = tr.scriptPath ? (tr.scriptPath.split('/').pop() || tr.scriptPath) : '';
      action = (
        <>
          {meta?.emoji || <UiIcon name="fileCode" size={13} />} {meta?.name || filename}
          {tr.scriptArgs ? <> <code>{tr.scriptArgs}</code></> : null}
        </>
      );
    } else {
      action = <><UiIcon name="messages" size={13} /> {tr.response}</>;
    }
    return <><code>{tr.cronExpression}</code> <UiIcon name="forward" size={12} /> {action}</>;
  };

  const chipsOf = (tr: TimerTrigger): TriggerChip[] => {
    const chips: TriggerChip[] = [
      {
        label: timerResponseType(tr) === 'script'
          ? t('automation.timer_triggers.type_script', 'Script')
          : t('automation.timer_triggers.type_text', 'Text Message'),
        tone: 'accent',
      },
      { label: channelLabel(tr), tone: 'info', title: t('automation.timer_triggers.channel', 'Channel:') },
    ];
    if (tr.lastRun) {
      chips.push({
        label: <><UiIcon name="time" size={12} /> {new Date(tr.lastRun).toLocaleString()}{tr.lastResult ? ` (${tr.lastResult})` : ''}</>,
        tone: tr.lastResult === 'error' ? 'caution' : 'neutral',
        title: tr.lastError || t('automation.timer_triggers.last_run', 'Last run'),
      });
    }
    return chips;
  };

  const visible = localTriggers.filter((tr) =>
    tr.id === expandedId || (
      matchesSearch(search, tr.name, tr.cronExpression, tr.response, tr.scriptPath, tr.scriptArgs)
      && (typeFilter === 'all' || timerResponseType(tr) === typeFilter)
    ));

  const testing = testingId ? localTriggers.find((tr) => tr.id === testingId) : undefined;
  const untitled = t('automation.timer_triggers.untitled', 'New timer');

  return (
    <ConfigSection
      title={t('automation.timer_triggers.section_title', 'Timed Events')}
      docsUrl="https://meshmonitor.org/features/automation#timer-triggers"
      headerActions={
        <ConfigHeaderCount>
          {t('automation.trigger_count', '{{count}} triggers', { count: localTriggers.length })}
        </ConfigHeaderCount>
      }
      description={t('automation.timer_triggers.description', 'Schedule scripts to run automatically using cron expressions')}
      canWrite={canWrite}
      receiveOnly={receiveOnly}
    >
      {localTriggers.length > TRIGGER_FILTER_THRESHOLD && (
        <TriggerListFilter
          search={search}
          onSearchChange={setSearch}
          type={typeFilter}
          onTypeChange={setTypeFilter}
          searchPlaceholder={t('automation.timer_triggers.search', 'Search timers…')}
          typeOptions={[
            { value: 'all', label: t('automation.timer_triggers.filter_all', 'All types') },
            { value: 'script', label: t('automation.timer_triggers.type_script', 'Script') },
            { value: 'text', label: t('automation.timer_triggers.type_text', 'Text Message') },
          ]}
        />
      )}

      {localTriggers.length === 0 && (
        <ConfigEmptyState className={styles.empty}>
          {t('automation.timer_triggers.no_timers_yet', 'No timer triggers configured. Add one to schedule a script or a text message.')}
        </ConfigEmptyState>
      )}

      {visible.map((tr) => {
        const errors = errorsById[tr.id] ?? {};
        const isScript = timerResponseType(tr) === 'script';
        return (
          <TriggerCard
            key={tr.id}
            title={tr.name.trim() || <span className={styles.untitled}>{untitled}</span>}
            summary={summaryOf(tr)}
            chips={chipsOf(tr)}
            enabled={tr.enabled}
            onEnabledChange={(on) => updateTrigger(tr.id, { enabled: on })}
            enableLabel={t('automation.timer_triggers.enable_trigger', 'Enable {{name}}', { name: tr.name.trim() || untitled })}
            expanded={expandedId === tr.id}
            onEdit={() => startEditing(tr.id)}
            onDone={() => finishEditing(tr.id)}
            onDelete={() => removeTrigger(tr.id)}
            invalid={hasTimerErrors(errors)}
            deleteTitle={t('automation.timer_triggers.remove_title', 'Remove timer?')}
            deletePreview={tr.name || tr.cronExpression || undefined}
            actions={isScript ? (
              <TriggerCardAction
                onClick={() => setTestingId(tr.id)}
                disabled={!tr.scriptPath}
                title={t('script_test.run_test', 'Run Test')}
              >
                <UiIcon name="test" size={14} /> {t('common.test', 'Test')}
              </TriggerCardAction>
            ) : undefined}
          >
            <TimerTriggerEditor
              trigger={tr}
              onChange={(patch) => updateTrigger(tr.id, patch)}
              errors={errors}
              availableScripts={availableScripts}
              channels={channels}
            />
          </TriggerCard>
        );
      })}

      {localTriggers.length > 0 && visible.length === 0 && (
        <ConfigEmptyState className={styles.empty}>
          {t('automation.timer_triggers.no_match', 'No timers match your search.')}
        </ConfigEmptyState>
      )}

      <button type="button" className={styles.addButton} onClick={addTrigger}>
        <UiIcon name="plus" size={14} /> {t('automation.timer_triggers.add', 'Add Timer')}
      </button>

      {/* Script test: opens only on an explicit Test click, as before. */}
      {testing && timerResponseType(testing) === 'script' && (
        <ScriptTestModal
          isOpen
          onClose={() => setTestingId(null)}
          triggerType="timer"
          scriptPath={testing.scriptPath || ''}
          scriptArgs={testing.scriptArgs}
          timerName={testing.name}
          timerId={testing.id}
          baseUrl={baseUrl}
        />
      )}
    </ConfigSection>
  );
};

export default TimerTriggersSection;
