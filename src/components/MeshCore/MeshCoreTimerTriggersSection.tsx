import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidCron } from 'cron-validator';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { ScopeSelectField, type ScopeMode } from './ScopeSelectField';

interface MeshCoreTimerTriggersSectionProps {
  baseUrl: string;
  sourceId: string;
}

/**
 * Mirrors the backend `MeshCoreTimerTrigger` shape exactly. Kept inline
 * because the type isn't exported to the client bundle — it's a server-
 * only interface that crosses the wire as JSON.
 */
interface MeshCoreTimerTrigger {
  id: string;
  name: string;
  enabled: boolean;
  scheduleType: 'cron' | 'interval';
  cronExpression?: string;
  intervalMinutes?: number;
  responseType: 'text' | 'advert' | 'script';
  response?: string;
  scriptPath?: string;
  scriptArgs?: string;
  destination?: 'channel' | 'dm';
  channelIndex?: number;
  contactPublicKey?: string;
  /** MeshCore scope/region for the sent message (#3833). */
  scopeMode?: ScopeMode;
  scopeName?: string;
  lastRun?: number;
  lastResult?: 'success' | 'error';
  lastError?: string;
}

interface ScriptMetadata {
  path: string;
  filename: string;
  name?: string;
  emoji?: string;
  language?: string;
}

interface MeshCoreChannelRow {
  id: number;
  name: string;
}

interface MeshCoreContactRow {
  publicKey: string;
  name: string;
}

const newTrigger = (): MeshCoreTimerTrigger => ({
  id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  name: '',
  enabled: true,
  scheduleType: 'cron',
  cronExpression: '0 */6 * * *',
  intervalMinutes: 60,
  responseType: 'text',
  response: '',
  destination: 'channel',
  channelIndex: 0,
  scopeMode: 'inherit',
  scopeName: '',
});

const triggersEqual = (a: MeshCoreTimerTrigger[], b: MeshCoreTimerTrigger[]): boolean => {
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
};

export const MeshCoreTimerTriggersSection: React.FC<MeshCoreTimerTriggersSectionProps> = ({ baseUrl, sourceId }) => {
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
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<MeshCoreTimerTrigger>(newTrigger());
  const [runningId, setRunningId] = useState<string | null>(null);

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

  // Detect changes
  useEffect(() => {
    if (!loaded) return;
    setHasChanges(!triggersEqual(triggers, initial));
  }, [triggers, initial, loaded]);

  const handleSave = useCallback(async () => {
    // Validate every cron + interval combo before persisting
    for (const tr of triggers) {
      if (tr.scheduleType === 'cron' && !isValidCron(tr.cronExpression || '', { seconds: false, alias: true, allowBlankDay: true })) {
        showToast(t('meshcore.automation.timers.invalid_cron', `Invalid cron for "${tr.name || tr.id}"`), 'error');
        return;
      }
      if (tr.scheduleType === 'interval' && (!Number.isFinite(tr.intervalMinutes) || (tr.intervalMinutes ?? 0) <= 0)) {
        showToast(t('meshcore.automation.timers.invalid_interval', `Invalid interval for "${tr.name || tr.id}"`), 'error');
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
      setHasChanges(false);
      showToast(t('automation.settings_saved', 'Settings saved'), 'success');
    } catch (err) {
      console.error('Failed to save MeshCore timer triggers:', err);
      showToast(t('automation.settings_save_failed', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [triggers, baseUrl, sourceId, csrfFetch, showToast, t]);

  const handleDismiss = useCallback(() => {
    setTriggers(initial);
    setHasChanges(false);
  }, [initial]);

  useSaveBar({
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
  };

  const addTrigger = () => {
    if (!draft.name.trim()) {
      showToast(t('meshcore.automation.timers.name_required', 'Name is required'), 'error');
      return;
    }
    if (draft.scheduleType === 'cron' && !isValidCron(draft.cronExpression || '', { seconds: false, alias: true, allowBlankDay: true })) {
      showToast(t('meshcore.automation.timers.invalid_cron_draft', 'Invalid cron expression'), 'error');
      return;
    }
    setTriggers(prev => [...prev, draft]);
    setDraft(newTrigger());
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

  const channelOptions = useMemo(() => channels.map(c => ({ value: c.id, label: c.name || `Channel ${c.id}` })), [channels]);
  const contactOptions = useMemo(() => contacts.map(c => ({ value: c.publicKey, label: c.name })), [contacts]);

  return (
    <>
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '1.5rem',
        marginTop: '2rem',
        padding: '1rem 1.25rem',
        background: 'var(--ctp-surface1)',
        border: '1px solid var(--ctp-surface2)',
        borderRadius: '8px',
      }}>
        <h2 style={{ margin: 0 }}>
          {t('meshcore.automation.timers.title', 'Timer Triggers')}
        </h2>
        <span style={{ marginLeft: 'auto', fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
          {t('meshcore.automation.timers.count', '{{count}} triggers', { count: triggers.length })}
        </span>
      </div>

      <div className="settings-section">
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: 1.5, marginLeft: '1.75rem' }}>
          {t(
            'meshcore.automation.timers.description',
            'Schedule recurring actions — send a message to a channel or contact, or fire a MeshCore advert. Each trigger runs on its own cron or interval.',
          )}
        </p>

        {/* List of existing triggers */}
        {triggers.length === 0 && (
          <p style={{ marginLeft: '1.75rem', fontSize: '0.9rem', color: 'var(--ctp-subtext0)' }}>
            {t('meshcore.automation.timers.empty', 'No timer triggers configured yet.')}
          </p>
        )}

        {triggers.map(tr => (
          <div key={tr.id} className="meshcore-trigger-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <input
                type="checkbox"
                checked={tr.enabled}
                onChange={(e) => updateTrigger(tr.id, { enabled: e.target.checked })}
                disabled={!canWrite}
                style={{ width: 'auto', margin: 0 }}
                aria-label={`Enable ${tr.name}`}
              />
              <input
                type="text"
                value={tr.name}
                onChange={(e) => updateTrigger(tr.id, { name: e.target.value })}
                disabled={!canWrite}
                placeholder={t('meshcore.automation.timers.name_placeholder', 'Trigger name')}
                className="meshcore-input"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                onClick={() => runNow(tr.id)}
                disabled={!canWrite || runningId === tr.id || !tr.enabled}
                className="meshcore-btn meshcore-btn-secondary"
              >
                {runningId === tr.id ? t('meshcore.automation.timers.running', 'Running…') : t('meshcore.automation.timers.run_now', 'Run now')}
              </button>
              <button
                type="button"
                onClick={() => removeTrigger(tr.id)}
                disabled={!canWrite}
                className="meshcore-btn meshcore-btn-danger"
              >
                {t('meshcore.automation.timers.remove', 'Remove')}
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <label style={{ fontSize: '0.85rem' }}>
                {t('meshcore.automation.timers.schedule_type', 'Schedule')}
                <select
                  value={tr.scheduleType}
                  onChange={(e) => updateTrigger(tr.id, { scheduleType: e.target.value as 'cron' | 'interval' })}
                  disabled={!canWrite}
                  className="meshcore-select"
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  <option value="cron">{t('meshcore.automation.timers.cron', 'Cron')}</option>
                  <option value="interval">{t('meshcore.automation.timers.interval', 'Interval (minutes)')}</option>
                </select>
              </label>
              {tr.scheduleType === 'cron' ? (
                <label style={{ fontSize: '0.85rem' }}>
                  {t('meshcore.automation.timers.cron_expr', 'Cron expression')}
                  <input
                    type="text"
                    value={tr.cronExpression || ''}
                    onChange={(e) => updateTrigger(tr.id, { cronExpression: e.target.value })}
                    disabled={!canWrite}
                    placeholder="0 */6 * * *"
                    className="meshcore-input"
                    style={{ width: '100%', marginTop: '0.25rem', fontFamily: 'monospace' }}
                  />
                </label>
              ) : (
                <label style={{ fontSize: '0.85rem' }}>
                  {t('meshcore.automation.timers.interval_minutes', 'Interval (minutes)')}
                  <input
                    type="number"
                    min={1}
                    max={10080}
                    value={tr.intervalMinutes ?? 60}
                    onChange={(e) => updateTrigger(tr.id, { intervalMinutes: Math.max(1, parseInt(e.target.value, 10) || 60) })}
                    disabled={!canWrite}
                    className="meshcore-input"
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  />
                </label>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <label style={{ fontSize: '0.85rem' }}>
                {t('meshcore.automation.timers.response_type', 'Action')}
                <select
                  value={tr.responseType}
                  onChange={(e) => updateTrigger(tr.id, { responseType: e.target.value as 'text' | 'advert' | 'script' })}
                  disabled={!canWrite}
                  className="meshcore-select"
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  <option value="text">{t('meshcore.automation.timers.response_text', 'Send text')}</option>
                  <option value="advert">{t('meshcore.automation.timers.response_advert', 'Send advert')}</option>
                  <option value="script">{t('meshcore.automation.timers.response_script', 'Run script')}</option>
                </select>
              </label>
              {tr.responseType === 'text' && (
                <label style={{ fontSize: '0.85rem' }}>
                  {t('meshcore.automation.timers.response_message', 'Message (token expansion supported)')}
                  <textarea
                    value={tr.response || ''}
                    onChange={(e) => updateTrigger(tr.id, { response: e.target.value })}
                    disabled={!canWrite}
                    rows={2}
                    className="meshcore-input"
                    style={{ width: '100%', marginTop: '0.25rem', fontFamily: 'monospace' }}
                  />
                </label>
              )}
              {tr.responseType === 'script' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  <label style={{ fontSize: '0.85rem' }}>
                    {t('meshcore.automation.timers.script', 'Script')}
                    <select
                      value={tr.scriptPath || ''}
                      onChange={(e) => updateTrigger(tr.id, { scriptPath: e.target.value })}
                      disabled={!canWrite}
                      className="meshcore-select"
                      style={{ width: '100%', marginTop: '0.25rem' }}
                    >
                      <option value="">{scripts.length === 0 ? t('meshcore.automation.timers.no_scripts', '(no scripts available)') : t('meshcore.automation.timers.select_script', '(select script)')}</option>
                      {scripts.map(s => (
                        <option key={s.path} value={s.path}>
                          {s.emoji ? `${s.emoji} ` : ''}{s.name || s.filename} ({s.language || '?'})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ fontSize: '0.85rem' }}>
                    {t('meshcore.automation.timers.script_args', 'Script args (token expansion)')}
                    <input
                      type="text"
                      value={tr.scriptArgs || ''}
                      onChange={(e) => updateTrigger(tr.id, { scriptArgs: e.target.value })}
                      disabled={!canWrite}
                      className="meshcore-input"
                      style={{ width: '100%', marginTop: '0.25rem', fontFamily: 'monospace' }}
                    />
                  </label>
                </div>
              )}
            </div>

            {(tr.responseType === 'text' || tr.responseType === 'script') && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '0.75rem' }}>
                <label style={{ fontSize: '0.85rem' }}>
                  {t('meshcore.automation.timers.destination', 'Destination')}
                  <select
                    value={tr.destination || 'channel'}
                    onChange={(e) => updateTrigger(tr.id, { destination: e.target.value as 'channel' | 'dm' })}
                    disabled={!canWrite}
                    className="meshcore-select"
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  >
                    <option value="channel">{t('meshcore.automation.timers.dest_channel', 'Channel')}</option>
                    <option value="dm">{t('meshcore.automation.timers.dest_dm', 'Direct Message')}</option>
                  </select>
                </label>
                {tr.destination === 'channel' ? (
                  <label style={{ fontSize: '0.85rem' }}>
                    {t('meshcore.automation.timers.channel', 'Channel')}
                    <select
                      value={tr.channelIndex ?? 0}
                      onChange={(e) => updateTrigger(tr.id, { channelIndex: parseInt(e.target.value, 10) })}
                      disabled={!canWrite}
                      className="meshcore-select"
                      style={{ width: '100%', marginTop: '0.25rem' }}
                    >
                      {channelOptions.length === 0 && <option value={0}>(no channels loaded)</option>}
                      {channelOptions.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label style={{ fontSize: '0.85rem' }}>
                    {t('meshcore.automation.timers.contact', 'Contact')}
                    <select
                      value={tr.contactPublicKey || ''}
                      onChange={(e) => updateTrigger(tr.id, { contactPublicKey: e.target.value })}
                      disabled={!canWrite}
                      className="meshcore-select"
                      style={{ width: '100%', marginTop: '0.25rem' }}
                    >
                      <option value="">(select contact)</option>
                      {contactOptions.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}

            {(tr.responseType === 'text' || tr.responseType === 'script') && (
              <div style={{ marginTop: '0.5rem' }}>
                {/* MeshCore scope/region for the sent message (#3833). No trigger
                    message here, so the "respond on trigger scope" option is omitted. */}
                <ScopeSelectField
                  baseUrl={baseUrl}
                  sourceId={sourceId}
                  idPrefix={`timer-${tr.id}`}
                  value={{ scopeMode: tr.scopeMode, scopeName: tr.scopeName }}
                  onChange={(v) => updateTrigger(tr.id, { scopeMode: v.scopeMode, scopeName: v.scopeName })}
                />
              </div>
            )}

            {tr.lastRun && (
              <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--ctp-subtext0)' }}>
                {t('meshcore.automation.timers.last_run', 'Last run')}: {new Date(tr.lastRun).toLocaleString()}{' '}
                {tr.lastResult === 'error' && (
                  <span style={{ color: 'var(--ctp-red)' }}>— {tr.lastError || 'error'}</span>
                )}
                {tr.lastResult === 'success' && (
                  <span style={{ color: 'var(--ctp-green)' }}>— success</span>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Add a new trigger */}
        <div className="meshcore-add-card">
          <h3 style={{ marginTop: 0, fontSize: '1rem' }}>
            {t('meshcore.automation.timers.add', 'Add trigger')}
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.5rem' }}>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={t('meshcore.automation.timers.name_placeholder', 'Trigger name')}
              disabled={!canWrite}
              className="meshcore-input"
            />
            <input
              type="text"
              value={draft.cronExpression || ''}
              onChange={(e) => setDraft({ ...draft, cronExpression: e.target.value })}
              placeholder="0 */6 * * *"
              disabled={!canWrite}
              className="meshcore-input"
              style={{ fontFamily: 'monospace' }}
            />
          </div>
          <button
            type="button"
            onClick={addTrigger}
            disabled={!canWrite}
            className="meshcore-btn meshcore-btn-primary"
          >
            {t('meshcore.automation.timers.add_button', 'Add trigger')}
          </button>
        </div>
      </div>
    </>
  );
};

export default MeshCoreTimerTriggersSection;
