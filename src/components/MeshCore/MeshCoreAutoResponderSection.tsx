import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { ScopeSelectField, type ScopeMode } from './ScopeSelectField';

interface MeshCoreAutoResponderSectionProps {
  baseUrl: string;
  sourceId: string;
}

/**
 * Mirrors the backend `MeshCoreAutoResponderTrigger` shape. Kept inline
 * for the same reason as the timer trigger: it's a server-only type
 * that crosses the wire as JSON.
 */
interface MeshCoreAutoResponderTrigger {
  id: string;
  name: string;
  enabled: boolean;
  pattern: string;
  /**
   * `text` (default) sends `response`; `script` runs `scriptPath` and
   * sends each entry of the script's wouldSendMessages output.
   */
  responseType?: 'text' | 'script';
  response: string;
  scriptPath?: string;
  scriptArgs?: string;
  channels: number[];
  listenDMs: boolean;
  replyAsDM: boolean;
  cooldownSeconds: number;
  /** Delay (s) after a match before sending the reply. 0 = immediate, max 120 (#3953). */
  preSendDelaySeconds?: number;
  /** MeshCore scope/region for the reply (#3833). */
  scopeMode?: ScopeMode;
  scopeName?: string;
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

const validateRegex = (pattern: string): { valid: boolean; error?: string } => {
  if (!pattern) return { valid: false, error: 'Pattern is required' };
  if (pattern.length > 100) return { valid: false, error: 'Pattern too long (max 100 chars)' };
  if (/(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/.test(pattern)) {
    return { valid: false, error: 'Pattern too complex (possible ReDoS)' };
  }
  try {
    new RegExp(pattern, 'i');
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid regex syntax' };
  }
};

const newTrigger = (): MeshCoreAutoResponderTrigger => ({
  id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

export const MeshCoreAutoResponderSection: React.FC<MeshCoreAutoResponderSectionProps> = ({ baseUrl, sourceId }) => {
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
  const [draft, setDraft] = useState<MeshCoreAutoResponderTrigger>(newTrigger());

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

  const handleSave = useCallback(async () => {
    // Validate every trigger's regex up front so the operator sees the
    // bad one before a round-trip.
    for (const tr of triggers) {
      const v = validateRegex(tr.pattern);
      if (!v.valid) {
        showToast(`Trigger "${tr.name || tr.id}": ${v.error}`, 'error');
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
      showToast(t('automation.settings_saved', 'Settings saved'), 'success');
    } catch (err) {
      console.error('Failed to save MeshCore auto-responder settings:', err);
      showToast(t('automation.settings_save_failed', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [enabled, triggers, baseUrl, sourceId, csrfFetch, showToast, t]);

  const handleDismiss = useCallback(() => {
    setEnabled(initialEnabled);
    setTriggers(initialTriggers);
    setHasChanges(false);
  }, [initialEnabled, initialTriggers]);

  useSaveBar({
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
  };

  const addTrigger = () => {
    const v = validateRegex(draft.pattern);
    if (!v.valid) {
      showToast(v.error || 'Invalid pattern', 'error');
      return;
    }
    if (!draft.name.trim()) {
      showToast(t('meshcore.automation.responder.name_required', 'Name is required'), 'error');
      return;
    }
    setTriggers(prev => [...prev, draft]);
    setDraft(newTrigger());
  };

  const channelMap = useMemo(() => {
    const m = new Map<number, string>();
    channels.forEach(c => m.set(c.id, c.name || `Channel ${c.id}`));
    return m;
  }, [channels]);

  const disabled = !enabled;

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
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={!canWrite}
            style={{ width: 'auto', margin: 0, cursor: canWrite ? 'pointer' : 'not-allowed' }}
          />
          {t('meshcore.automation.responder.title', 'Auto-Responder')}
        </h2>
        <span style={{ marginLeft: 'auto', fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
          {t('meshcore.automation.responder.count', '{{count}} triggers', { count: triggers.length })}
        </span>
      </div>

      <div className="settings-section" style={{ opacity: enabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: 1.5, marginLeft: '1.75rem' }}>
          {t(
            'meshcore.automation.responder.description',
            'Match incoming messages against operator-defined patterns and reply with a text response. Each trigger supports per-channel filtering, DM listening, and a per-sender cooldown.',
          )}
        </p>

        {triggers.length === 0 && (
          <p style={{ marginLeft: '1.75rem', fontSize: '0.9rem', color: 'var(--ctp-subtext0)' }}>
            {t('meshcore.automation.responder.empty', 'No triggers configured yet.')}
          </p>
        )}

        {triggers.map(tr => {
          const v = validateRegex(tr.pattern);
          return (
            <div key={tr.id} className="meshcore-trigger-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
                <input
                  type="checkbox"
                  checked={tr.enabled}
                  onChange={(e) => updateTrigger(tr.id, { enabled: e.target.checked })}
                  disabled={disabled || !canWrite}
                  style={{ width: 'auto', margin: 0 }}
                  aria-label={`Enable ${tr.name}`}
                />
                <input
                  type="text"
                  value={tr.name}
                  onChange={(e) => updateTrigger(tr.id, { name: e.target.value })}
                  disabled={disabled || !canWrite}
                  placeholder={t('meshcore.automation.responder.name_placeholder', 'Trigger name')}
                  className="meshcore-input"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => removeTrigger(tr.id)}
                  disabled={!canWrite}
                  className="meshcore-btn meshcore-btn-danger"
                >
                  {t('meshcore.automation.responder.remove', 'Remove')}
                </button>
              </div>

              <label style={{ fontSize: '0.85rem', display: 'block', marginBottom: '0.5rem' }}>
                {t('meshcore.automation.responder.pattern', 'Pattern (regex, case-insensitive)')}
                <input
                  type="text"
                  value={tr.pattern}
                  onChange={(e) => updateTrigger(tr.id, { pattern: e.target.value })}
                  disabled={disabled || !canWrite}
                  placeholder="^(test|ping)"
                  className="meshcore-input"
                  style={{ width: '100%', marginTop: '0.25rem', fontFamily: 'monospace' }}
                />
                {!v.valid && tr.pattern && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--ctp-red)', marginTop: '0.25rem' }}>
                    {v.error}
                  </div>
                )}
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '0.75rem', marginBottom: '0.5rem' }}>
                <label style={{ fontSize: '0.85rem' }}>
                  {t('meshcore.automation.responder.response_type', 'Action')}
                  <select
                    value={tr.responseType || 'text'}
                    onChange={(e) => updateTrigger(tr.id, { responseType: e.target.value as 'text' | 'script' })}
                    disabled={disabled || !canWrite}
                    className="meshcore-select"
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  >
                    <option value="text">{t('meshcore.automation.responder.response_text', 'Send text')}</option>
                    <option value="script">{t('meshcore.automation.responder.response_script', 'Run script')}</option>
                  </select>
                </label>
                {(tr.responseType || 'text') === 'text' ? (
                  <label style={{ fontSize: '0.85rem' }}>
                    {t('meshcore.automation.responder.response', 'Response (token expansion supported)')}
                    <textarea
                      value={tr.response}
                      onChange={(e) => updateTrigger(tr.id, { response: e.target.value })}
                      disabled={disabled || !canWrite}
                      rows={2}
                      className="meshcore-input"
                      style={{ width: '100%', marginTop: '0.25rem', fontFamily: 'monospace' }}
                    />
                  </label>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.85rem' }}>
                      {t('meshcore.automation.responder.script', 'Script')}
                      <select
                        value={tr.scriptPath || ''}
                        onChange={(e) => updateTrigger(tr.id, { scriptPath: e.target.value })}
                        disabled={disabled || !canWrite}
                        className="meshcore-select"
                        style={{ width: '100%', marginTop: '0.25rem' }}
                      >
                        <option value="">{scripts.length === 0 ? t('meshcore.automation.responder.no_scripts', '(no scripts available)') : t('meshcore.automation.responder.select_script', '(select script)')}</option>
                        {scripts.map(s => (
                          <option key={s.path} value={s.path}>
                            {s.emoji ? `${s.emoji} ` : ''}{s.name || s.filename} ({s.language || '?'})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ fontSize: '0.85rem' }}>
                      {t('meshcore.automation.responder.script_args', 'Script args (token expansion)')}
                      <input
                        type="text"
                        value={tr.scriptArgs || ''}
                        onChange={(e) => updateTrigger(tr.id, { scriptArgs: e.target.value })}
                        disabled={disabled || !canWrite}
                        className="meshcore-input"
                        style={{ width: '100%', marginTop: '0.25rem', fontFamily: 'monospace' }}
                      />
                    </label>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}>
                  <input
                    type="checkbox"
                    checked={tr.listenDMs}
                    onChange={(e) => updateTrigger(tr.id, { listenDMs: e.target.checked })}
                    disabled={disabled || !canWrite}
                    style={{ width: 'auto', margin: 0 }}
                  />
                  {t('meshcore.automation.responder.listen_dms', 'Listen on DMs')}
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}>
                  <input
                    type="checkbox"
                    checked={tr.replyAsDM}
                    onChange={(e) => updateTrigger(tr.id, { replyAsDM: e.target.checked })}
                    disabled={disabled || !canWrite}
                    style={{ width: 'auto', margin: 0 }}
                  />
                  {t('meshcore.automation.responder.reply_dm', 'Reply as DM')}
                </label>
                <label style={{ fontSize: '0.85rem' }}>
                  {t('meshcore.automation.responder.cooldown', 'Cooldown (s)')}{' '}
                  <input
                    type="number"
                    min={0}
                    max={3600}
                    value={tr.cooldownSeconds}
                    onChange={(e) => updateTrigger(tr.id, { cooldownSeconds: Math.max(0, Math.min(3600, parseInt(e.target.value, 10) || 0)) })}
                    disabled={disabled || !canWrite}
                    className="meshcore-input"
                    style={{ width: '80px' }}
                  />
                </label>
                <label
                  style={{ fontSize: '0.85rem' }}
                  title={t(
                    'meshcore.automation.responder.presend_delay_help',
                    'Wait this long after a match before replying, so a relaying repeater can finish its own transmission first (0 = send immediately, max 120).',
                  )}
                >
                  {t('meshcore.automation.responder.presend_delay', 'Pre-Send Delay (s)')}{' '}
                  <input
                    type="number"
                    min={0}
                    max={120}
                    value={tr.preSendDelaySeconds ?? 0}
                    onChange={(e) => updateTrigger(tr.id, { preSendDelaySeconds: Math.max(0, Math.min(120, parseInt(e.target.value, 10) || 0)) })}
                    disabled={disabled || !canWrite}
                    className="meshcore-input"
                    style={{ width: '80px' }}
                  />
                </label>
              </div>

              {/* Channels */}
              <fieldset style={{ border: '1px solid var(--ctp-surface2)', borderRadius: '4px', padding: '0.5rem' }}>
                <legend style={{ fontSize: '0.8rem', padding: '0 0.5rem' }}>
                  {t('meshcore.automation.responder.channels', 'Listen on channels')}
                </legend>
                {channels.length === 0 && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--ctp-subtext0)' }}>
                    {t('meshcore.automation.responder.no_channels', 'No channels loaded')}
                  </span>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {channels.map(ch => (
                    <label key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem' }}>
                      <input
                        type="checkbox"
                        checked={tr.channels.includes(ch.id)}
                        onChange={(e) => {
                          if (e.target.checked) updateTrigger(tr.id, { channels: [...tr.channels, ch.id] });
                          else updateTrigger(tr.id, { channels: tr.channels.filter(c => c !== ch.id) });
                        }}
                        disabled={disabled || !canWrite}
                        style={{ width: 'auto', margin: 0 }}
                      />
                      {channelMap.get(ch.id)}
                    </label>
                  ))}
                </div>
              </fieldset>

              {/* MeshCore scope/region for the reply (#3833) */}
              <ScopeSelectField
                baseUrl={baseUrl}
                sourceId={sourceId}
                allowTrigger
                idPrefix={`responder-${tr.id}`}
                value={{ scopeMode: tr.scopeMode, scopeName: tr.scopeName }}
                onChange={(v) => updateTrigger(tr.id, { scopeMode: v.scopeMode, scopeName: v.scopeName })}
              />
            </div>
          );
        })}

        {/* Add new trigger */}
        <div className="meshcore-add-card" style={{ opacity: disabled ? 0.6 : 1 }}>
          <h3 style={{ marginTop: 0, fontSize: '1rem' }}>
            {t('meshcore.automation.responder.add', 'Add trigger')}
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.5rem' }}>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={t('meshcore.automation.responder.name_placeholder', 'Trigger name')}
              disabled={disabled || !canWrite}
              className="meshcore-input"
            />
            <input
              type="text"
              value={draft.pattern}
              onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
              placeholder="^(test|ping)"
              disabled={disabled || !canWrite}
              className="meshcore-input"
              style={{ fontFamily: 'monospace' }}
            />
          </div>
          <textarea
            value={draft.response}
            onChange={(e) => setDraft({ ...draft, response: e.target.value })}
            placeholder={t('meshcore.automation.responder.response_placeholder', 'Response text (supports {VERSION}, {DURATION}, …)')}
            rows={2}
            disabled={disabled || !canWrite}
            className="meshcore-input"
            style={{ width: '100%', marginBottom: '0.5rem', fontFamily: 'monospace' }}
          />
          <button
            type="button"
            onClick={addTrigger}
            disabled={disabled || !canWrite}
            className="meshcore-btn meshcore-btn-primary"
          >
            {t('meshcore.automation.responder.add_button', 'Add trigger')}
          </button>
        </div>
      </div>
    </>
  );
};

export default MeshCoreAutoResponderSection;
