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
import { TriggerCard, type TriggerChip } from '../shared/automation/TriggerCard';
import { TriggerListFilter } from '../shared/automation/TriggerListFilter';
import { PatternTestBox, type PatternTestResult } from '../shared/automation/PatternTestBox';
import { TRIGGER_FILTER_THRESHOLD, matchesSearch, newTriggerId } from '../shared/automation/triggerList';
import { MeshCoreResponderTriggerEditor } from './MeshCoreResponderTriggerEditor';
import { validateMeshCoreResponderPattern, meshCoreResponderPatternMatches } from './meshcoreResponderMatch';
import type {
  MeshCoreAutoResponderTrigger,
  MeshCoreChannelRow,
  MeshCoreScriptMetadata as ScriptMetadata,
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

const newTrigger = (): MeshCoreAutoResponderTrigger => ({
  id: newTriggerId(),
  name: '',
  enabled: true,
  pattern: '',
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

  // Load available scripts (responseType='script' picker).
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
      const v = validateMeshCoreResponderPattern(tr.pattern);
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
      if (!validateMeshCoreResponderPattern(tr.pattern).valid || nameMissing(tr)) {
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

  const summaryOf = (tr: MeshCoreAutoResponderTrigger): React.ReactNode => (
    <>
      <code>/{tr.pattern}/</code> <UiIcon name="forward" size={12} />{' '}
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

  // Mirrors the server: every enabled trigger whose regex matches replies.
  // Channel / DM filters are not applied (the test message has neither).
  const matchForTest = (tr: MeshCoreAutoResponderTrigger, text: string): PatternTestResult => {
    if (!tr.enabled || !meshCoreResponderPatternMatches(tr.pattern, text)) return { matched: false };
    if ((tr.responseType || 'text') === 'script') {
      return { matched: true, detail: <>/{tr.pattern}/ · {tr.scriptPath}</> };
    }
    return { matched: true, detail: <>/{tr.pattern}/</>, response: tr.response };
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
          const v = validateMeshCoreResponderPattern(tr.pattern);
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
            getLabel={(tr) => tr.name || `/${tr.pattern}/`}
            match={matchForTest}
            description={t(
              'meshcore.automation.responder.test_description',
              'Type sample messages, one per line. Every enabled trigger whose pattern matches (case-insensitive, anywhere in the message) replies. Tokens such as {VERSION} are filled in when the reply is sent. Nothing is sent from here, and channel filters are not applied.',
            )}
          />
        )}
      </ConfigSection>
    </NumberInputScope>
  );
};

export default MeshCoreAutoResponderSection;
