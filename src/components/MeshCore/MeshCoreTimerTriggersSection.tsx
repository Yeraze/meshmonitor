import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { UiIcon } from '../icons';
import { ConfigSection, ConfigHeaderCount } from '../shared/config/ConfigSection';
import { ConfigEmptyState } from '../shared/config/ConfigEmptyState';
import { TriggerCard, TriggerCardAction, type TriggerChip } from '../shared/automation/TriggerCard';
import { TriggerListFilter } from '../shared/automation/TriggerListFilter';
import { TRIGGER_FILTER_THRESHOLD, matchesSearch } from '../shared/automation/triggerList';
import { meshCoreReceiveOnlyText } from './meshCoreReceiveOnlyText';
import { isTxDisabledBody } from '../../utils/txDisabled';
import { LEGACY_MESHCORE_ADVERT_MODE, resolveMeshCoreAdvertMode } from '../../types/meshcoreAdvert';
import { MeshCoreTimerTriggerEditor } from './MeshCoreTimerTriggerEditor';
import {
  type MeshCoreContactRow,
  type MeshCoreTimerErrors,
  type MeshCoreTimerTrigger,
  hasMeshCoreTimerErrors,
  isValidMeshCoreTimerCron,
  newMeshCoreTimerTrigger,
  validateMeshCoreTimer,
} from './meshcoreTimerModel';
import type { MeshCoreChannelRow, MeshCoreScriptMetadata as ScriptMetadata } from './meshcoreResponderTypes';
import styles from './MeshCoreTimerTriggersSection.module.css';

interface MeshCoreTimerTriggersSectionProps {
  baseUrl: string;
  sourceId: string;
  /** True when this MeshCore source is in strict receive-only mode (#4547
   *  Phase 2): renders the paused note and gates "Run now". */
  receiveOnly?: boolean;
}

/**
 * MeshCore Timer Triggers (#5812): one TriggerCard per trigger. Add appends a
 * new trigger opened in its card; Done and Save validate it. Triggers are
 * saved exactly as edited, so one the user did not touch is sent back as
 * loaded.
 */
export const MeshCoreTimerTriggersSection: React.FC<MeshCoreTimerTriggersSectionProps> = ({ baseUrl, sourceId, receiveOnly = false }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('automation', 'write');

  const [triggers, setTriggers] = useState<MeshCoreTimerTrigger[]>([]);
  const [initial, setInitial] = useState<MeshCoreTimerTrigger[]>([]);
  const [channels, setChannels] = useState<MeshCoreChannelRow[]>([]);
  const [contacts, setContacts] = useState<MeshCoreContactRow[]>([]);
  const [scripts, setScripts] = useState<ScriptMetadata[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  // #5812: one trigger open in its TriggerCard at a time. A bad cron shows
  // live; a missing name or a bad interval shows once Done or Save has been
  // tried (`attemptedIds`), so a new trigger does not open in red.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [attemptedIds, setAttemptedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  // Load triggers
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(`${baseUrl}/api/sources/${sourceId}/meshcore/automation/timers`);
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled || !json.success) return;
        const list: MeshCoreTimerTrigger[] = Array.isArray(json.data?.triggers) ? json.data.triggers : [];
        setTriggers(list);
        setInitial(list);
        setLoaded(true);
      } catch {
        // keep defaults
      }
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

  // Load available scripts (for responseType='script' picker). Shared
  // with Meshtastic — /api/scripts is protocol-neutral.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(`${baseUrl}/api/scripts`);
        if (!res.ok) return;
        const raw = await res.json();
        if (cancelled) return;
        const list: ScriptMetadata[] = Array.isArray(raw?.scripts)
          ? raw.scripts.filter((s: any) => typeof s?.path === 'string')
          : [];
        setScripts(list);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, csrfFetch]);

  // Load contacts (for DM destination)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(`${baseUrl}/api/sources/${sourceId}/meshcore/contacts`);
        if (!res.ok) return;
        const raw = await res.json();
        if (cancelled) return;
        const rows: MeshCoreContactRow[] = Array.isArray(raw?.data)
          ? raw.data
              .filter((c: any) => typeof c?.publicKey === 'string')
              .map((c: any) => ({
                publicKey: c.publicKey as string,
                name: String(c.advName ?? c.name ?? c.publicKey.substring(0, 16)),
              }))
          : [];
        setContacts(rows);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, csrfFetch]);

  const hasChanges = loaded && JSON.stringify(triggers) !== JSON.stringify(initial);

  // Saved copies by id: a trigger not in here is new, and one that differs
  // from its copy is dirty. "Run now" fires the SAVED trigger on the server,
  // so it is offered only for a saved, unchanged trigger.
  const savedJsonById = useMemo(
    () => new Map(initial.map((tr) => [tr.id, JSON.stringify(tr)])),
    [initial],
  );
  const isNew = useCallback((tr: MeshCoreTimerTrigger) => !savedJsonById.has(tr.id), [savedJsonById]);
  const isDirty = (tr: MeshCoreTimerTrigger) => savedJsonById.get(tr.id) !== JSON.stringify(tr);

  const errorsFor = useCallback(
    (tr: MeshCoreTimerTrigger) => validateMeshCoreTimer(tr, isNew(tr), t),
    [isNew, t],
  );

  const handleSave = useCallback(async () => {
    // Validate every cron + interval combo (and a new trigger's name) before
    // persisting; open the bad one so the error shows in place.
    for (const tr of triggers) {
      const errs = errorsFor(tr);
      if (hasMeshCoreTimerErrors(errs)) {
        setAttemptedIds((prev) => new Set(prev).add(tr.id));
        setExpandedId(tr.id);
        const label = tr.name || tr.id;
        showToast(
          errs.cronExpression
            ? t('meshcore.automation.timers.invalid_cron', `Invalid cron for "${label}"`)
            : errs.intervalMinutes
              ? t('meshcore.automation.timers.invalid_interval', `Invalid interval for "${label}"`)
              : (errs.name ?? ''),
          'error',
        );
        return;
      }
    }
    setIsSaving(true);
    try {
      const res = await csrfFetch(
        `${baseUrl}/api/sources/${sourceId}/meshcore/automation/timers`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ triggers }),
        },
      );
      if (!res.ok) {
        if (res.status === 403) {
          showToast(t('automation.insufficient_permissions', 'Insufficient permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${res.status}`);
      }
      setInitial(triggers);
      setExpandedId(null);
      setAttemptedIds(new Set());
      showToast(t('automation.settings_saved', 'Settings saved'), 'success');
    } catch (err) {
      console.error('Failed to save MeshCore timer triggers:', err);
      showToast(t('automation.settings_save_failed', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [triggers, baseUrl, sourceId, csrfFetch, showToast, t, errorsFor]);

  const handleDismiss = useCallback(() => {
    setTriggers(initial);
    setExpandedId(null);
    setAttemptedIds(new Set());
  }, [initial]);

  const numberScope = useNumberInputScope();
  useSaveBar({
    numberScope,
    id: 'meshcore-timer-triggers',
    sectionName: t('meshcore.automation.timers.title', 'Timer Triggers'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const updateTrigger = (id: string, patch: Partial<MeshCoreTimerTrigger>) => {
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
    if (tr && hasMeshCoreTimerErrors(errorsFor(tr))) {
      setAttemptedIds((prev) => new Set(prev).add(id));
      setExpandedId(id);
      return false;
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
    const tr = newMeshCoreTimerTrigger();
    setTriggers(prev => [...prev, tr]);
    setSearch('');
    setTypeFilter('all');
    setExpandedId(tr.id);
  };

  const runNow = useCallback(async (id: string) => {
    setRunningId(id);
    try {
      const res = await csrfFetch(
        `${baseUrl}/api/sources/${sourceId}/meshcore/automation/timers/${encodeURIComponent(id)}/run`,
        { method: 'POST' },
      );
      const json = await res.json();
      if (res.ok && json.success) {
        showToast(t('meshcore.automation.timers.ran', 'Trigger fired'), 'success');
      } else if (isTxDisabledBody(res.status, json)) {
        showToast(
          t('meshcore.receive_only.blocked_toast', 'Receive-only mode is on for this MeshCore source — nothing was sent.'),
          'warning',
        );
      } else {
        showToast(json?.data?.reason || json?.error || t('meshcore.automation.timers.run_failed', 'Run failed'), 'error');
      }
    } catch (err) {
      console.error('Failed to run timer trigger:', err);
      showToast(t('meshcore.automation.timers.run_failed', 'Run failed'), 'error');
    } finally {
      setRunningId(null);
    }
  }, [baseUrl, sourceId, csrfFetch, showToast, t]);

  const channelMap = useMemo(() => {
    const m = new Map<number, string>();
    channels.forEach(c => m.set(c.id, c.name || `Channel ${c.id}`));
    return m;
  }, [channels]);
  const contactMap = useMemo(() => new Map(contacts.map(c => [c.publicKey, c.name])), [contacts]);

  const scheduleText = (tr: MeshCoreTimerTrigger): React.ReactNode => (
    tr.scheduleType === 'interval'
      ? t('meshcore.automation.timers.every_minutes', 'every {{count}} min', { count: tr.intervalMinutes ?? 60 })
      : <code>{tr.cronExpression || ''}</code>
  );

  const actionLabel = (tr: MeshCoreTimerTrigger): string => {
    switch (tr.responseType) {
      case 'advert': return t('meshcore.automation.timers.response_advert', 'Send advert');
      case 'script': return t('meshcore.automation.timers.response_script', 'Run script');
      default: return t('meshcore.automation.timers.response_text', 'Send text');
    }
  };

  const summaryOf = (tr: MeshCoreTimerTrigger): React.ReactNode => {
    let action: React.ReactNode;
    if (tr.responseType === 'advert') {
      action = resolveMeshCoreAdvertMode(tr.advertMode, LEGACY_MESHCORE_ADVERT_MODE) === 'flood'
        ? t('meshcore.advert.mode_flood', 'Flood (whole mesh, costly)')
        : t('meshcore.advert.mode_zero_hop', 'Zero-hop (nearby nodes only)');
    } else if (tr.responseType === 'script') {
      action = <code>{tr.scriptPath || t('meshcore.automation.timers.select_script', '(select script)')}{tr.scriptArgs ? ` ${tr.scriptArgs}` : ''}</code>;
    } else {
      action = tr.response;
    }
    return <>{scheduleText(tr)} <UiIcon name="forward" size={12} /> {action}</>;
  };

  const chipsOf = (tr: MeshCoreTimerTrigger): TriggerChip[] => {
    const chips: TriggerChip[] = [{ label: actionLabel(tr), tone: 'accent' }];
    if (tr.responseType === 'text' || tr.responseType === 'script') {
      if (tr.destination === 'dm') {
        chips.push({
          label: <><UiIcon name="directMessages" size={12} /> {tr.contactPublicKey ? (contactMap.get(tr.contactPublicKey) ?? tr.contactPublicKey.substring(0, 12)) : t('meshcore.automation.timers.dest_dm', 'Direct Message')}</>,
          tone: 'info',
          title: t('meshcore.automation.timers.destination', 'Destination'),
        });
      } else {
        const idx = tr.channelIndex ?? 0;
        chips.push({ label: channelMap.get(idx) ?? `Channel ${idx}`, tone: 'info', title: t('meshcore.automation.timers.destination', 'Destination') });
      }
      if (tr.scopeMode && tr.scopeMode !== 'inherit') {
        chips.push({ label: tr.scopeMode === 'named' ? `#${tr.scopeName ?? ''}` : tr.scopeMode, tone: 'caution' });
      }
    }
    if (tr.lastRun) {
      chips.push({
        label: <><UiIcon name="time" size={12} /> {t('meshcore.automation.timers.last_run', 'Last run')}: {new Date(tr.lastRun).toLocaleString()}{tr.lastResult ? ` — ${tr.lastResult === 'error' ? (tr.lastError || 'error') : 'success'}` : ''}</>,
        tone: tr.lastResult === 'error' ? 'caution' : 'neutral',
        title: tr.lastError,
      });
    }
    return chips;
  };

  const visible = triggers.filter((tr) =>
    tr.id === expandedId || (
      matchesSearch(search, tr.name, tr.cronExpression, tr.response, tr.scriptPath, tr.scriptArgs)
      && (typeFilter === 'all' || tr.responseType === typeFilter)
    ));

  const untitled = t('meshcore.automation.timers.untitled', 'New trigger');
  const receiveOnlyTooltip = t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.');
  const saveFirstTooltip = t('meshcore.automation.timers.save_before_run', 'Save your changes before running this trigger.');

  return (
    <NumberInputScope scope={numberScope}>
      <ConfigSection
        title={t('meshcore.automation.timers.title', 'Timer Triggers')}
        docsUrl="https://meshmonitor.org/features/meshcore#timer-triggers"
        canWrite={canWrite}
        receiveOnly={receiveOnly}
        receiveOnlyNote={meshCoreReceiveOnlyText(t)}
        headerActions={
          <ConfigHeaderCount>
            {t('automation.trigger_count', '{{count}} triggers', { count: triggers.length })}
          </ConfigHeaderCount>
        }
        description={t(
          'meshcore.automation.timers.description',
          'Schedule recurring actions — send a message to a channel or contact, or fire a MeshCore advert. Each trigger runs on its own cron or interval.',
        )}
      >
        {triggers.length > TRIGGER_FILTER_THRESHOLD && (
          <TriggerListFilter
            search={search}
            onSearchChange={setSearch}
            type={typeFilter}
            onTypeChange={setTypeFilter}
            typeOptions={[
              { value: 'all', label: t('meshcore.automation.timers.filter_all', 'All actions') },
              { value: 'text', label: t('meshcore.automation.timers.response_text', 'Send text') },
              { value: 'advert', label: t('meshcore.automation.timers.response_advert', 'Send advert') },
              { value: 'script', label: t('meshcore.automation.timers.response_script', 'Run script') },
            ]}
          />
        )}

        {triggers.length === 0 && (
          <ConfigEmptyState className={styles.empty}>
            {t('meshcore.automation.timers.empty', 'No timer triggers configured yet.')}
          </ConfigEmptyState>
        )}

        {visible.map(tr => {
          const all = errorsFor(tr);
          const attempted = attemptedIds.has(tr.id);
          const errors: MeshCoreTimerErrors = {
            name: attempted ? all.name : undefined,
            // A typed cron that does not parse shows live, as a bad regex does.
            cronExpression: attempted || (tr.cronExpression && !isValidMeshCoreTimerCron(tr.cronExpression)) ? all.cronExpression : undefined,
            intervalMinutes: attempted ? all.intervalMinutes : undefined,
          };
          const unsaved = isNew(tr) || isDirty(tr);
          const runDisabled = !canWrite || runningId === tr.id || !tr.enabled || receiveOnly || unsaved;
          return (
            <TriggerCard
              key={tr.id}
              title={tr.name.trim() || <span className={styles.untitled}>{untitled}</span>}
              summary={summaryOf(tr)}
              chips={chipsOf(tr)}
              enabled={tr.enabled}
              onEnabledChange={(on) => updateTrigger(tr.id, { enabled: on })}
              enableLabel={t('meshcore.automation.timers.enable_trigger', 'Enable {{name}}', { name: tr.name.trim() || untitled })}
              expanded={expandedId === tr.id}
              onEdit={() => startEditing(tr.id)}
              onDone={() => finishEditing(tr.id)}
              onDelete={() => removeTrigger(tr.id)}
              invalid={hasMeshCoreTimerErrors(errors)}
              deletePreview={tr.name || undefined}
              actions={(
                <TriggerCardAction
                  onClick={() => runNow(tr.id)}
                  disabled={runDisabled}
                  title={receiveOnly ? receiveOnlyTooltip : unsaved ? saveFirstTooltip : undefined}
                >
                  <UiIcon name="play" size={14} />{' '}
                  {runningId === tr.id ? t('meshcore.automation.timers.running', 'Running…') : t('meshcore.automation.timers.run_now', 'Run now')}
                </TriggerCardAction>
              )}
            >
              <MeshCoreTimerTriggerEditor
                trigger={tr}
                onChange={(patch) => updateTrigger(tr.id, patch)}
                errors={errors}
                channels={channels}
                contacts={contacts}
                scripts={scripts}
                baseUrl={baseUrl}
                sourceId={sourceId}
              />
            </TriggerCard>
          );
        })}

        {triggers.length > 0 && visible.length === 0 && (
          <ConfigEmptyState className={styles.empty}>
            {t('meshcore.automation.timers.no_match', 'No triggers match your search.')}
          </ConfigEmptyState>
        )}

        <button
          type="button"
          onClick={addTrigger}
          disabled={!canWrite}
          className="meshcore-btn meshcore-btn-primary"
        >
          <UiIcon name="plus" size={14} /> {t('meshcore.automation.timers.add_button', 'Add trigger')}
        </button>
      </ConfigSection>
    </NumberInputScope>
  );
};

export default MeshCoreTimerTriggersSection;
