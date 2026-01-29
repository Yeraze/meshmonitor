import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidCron } from 'cron-validator';
import { TimerTrigger, TimerResponseType, ScriptMetadata } from './auto-responder/types';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { Channel } from '../types/device';
import { useSaveBar } from '../hooks/useSaveBar';

/**
 * Get language emoji for display
 */
const getLanguageEmoji = (language: string): string => {
  switch (language.toLowerCase()) {
    case 'python': return '🐍';
    case 'javascript': return '📘';
    case 'shell': return '💻';
    default: return '📄';
  }
};

/**
 * Format script for dropdown display
 * Returns: "emoji | name | filename | language" or "langEmoji filename" if no metadata
 */
const formatScriptDisplay = (script: ScriptMetadata): string => {
  const langEmoji = getLanguageEmoji(script.language);
  if (script.name) {
    const emoji = script.emoji || langEmoji;
    return `${emoji} ${script.name} | ${script.filename} | ${script.language}`;
  }
  return `${langEmoji} ${script.filename}`;
};

// Available tokens for text message expansion (same as auto-announce)
const AVAILABLE_TOKENS = [
  { token: '{VERSION}', description: 'MeshMonitor version' },
  { token: '{DURATION}', description: 'Server uptime' },
  { token: '{FEATURES}', description: 'Enabled features as emojis' },
  { token: '{NODECOUNT}', description: 'Total active nodes' },
  { token: '{DIRECTCOUNT}', description: 'Direct nodes (0 hops)' },
];

interface TimerTriggersSectionProps {
  triggers: TimerTrigger[];
  channels: Channel[];
  baseUrl: string;
  onTriggersChange: (triggers: TimerTrigger[]) => void;
}

const TimerTriggersSection: React.FC<TimerTriggersSectionProps> = ({
  triggers,
  channels,
  baseUrl,
  onTriggersChange,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();

  const [localTriggers, setLocalTriggers] = useState<TimerTrigger[]>(triggers);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [availableScripts, setAvailableScripts] = useState<ScriptMetadata[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  // New trigger form state
  const [newName, setNewName] = useState('');
  const [newNameManuallyEdited, setNewNameManuallyEdited] = useState(false);
  const [newCronExpression, setNewCronExpression] = useState('0 */6 * * *');
  const [newResponseType, setNewResponseType] = useState<TimerResponseType>('script');
  const [newScriptPath, setNewScriptPath] = useState('');
  const [newScriptArgs, setNewScriptArgs] = useState('');
  const [newResponse, setNewResponse] = useState('');
  const [newChannel, setNewChannel] = useState<number>(0);
  const [cronError, setCronError] = useState<string | null>(null);

  // Update local state when props change
  useEffect(() => {
    setLocalTriggers(triggers);
  }, [triggers]);

  // Check if any settings have changed
  useEffect(() => {
    const changed = JSON.stringify(localTriggers) !== JSON.stringify(triggers);
    setHasChanges(changed);
  }, [localTriggers, triggers]);

  // Fetch available scripts with metadata
  useEffect(() => {
    const fetchScripts = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/scripts`);
        if (response.ok) {
          const data = await response.json();
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
        }
      } catch (error) {
        console.error('Failed to fetch available scripts:', error);
      }
    };
    fetchScripts();
  }, [baseUrl]);

  // Handle script selection with autofill
  const handleScriptSelect = useCallback((scriptPath: string) => {
    setNewScriptPath(scriptPath);

    // Autofill timer name if not manually edited
    if (!newNameManuallyEdited && scriptPath) {
      const script = availableScripts.find(s => s.path === scriptPath);
      if (script?.name) {
        setNewName(script.name);
      }
    }
  }, [availableScripts, newNameManuallyEdited]);

  // Handle manual name edit
  const handleNameChange = useCallback((value: string) => {
    setNewName(value);
    if (value.trim()) {
      setNewNameManuallyEdited(true);
    }
  }, []);

  // Validate cron expression
  useEffect(() => {
    if (newCronExpression) {
      if (!isValidCron(newCronExpression, { seconds: false, alias: true, allowBlankDay: true })) {
        setCronError(t('automation.timer_triggers.invalid_cron', 'Invalid cron expression'));
      } else {
        setCronError(null);
      }
    } else {
      setCronError(null);
    }
  }, [newCronExpression, t]);

  const handleSaveForSaveBar = useCallback(async () => {
    setIsSaving(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timerTriggers: JSON.stringify(localTriggers),
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save settings');
      }

      onTriggersChange(localTriggers);
      showToast(t('automation.timer_triggers.saved', 'Timer triggers saved'), 'success');
    } catch (error) {
      showToast(t('automation.timer_triggers.save_failed', 'Failed to save timer triggers'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localTriggers, baseUrl, csrfFetch, showToast, t, onTriggersChange]);

  // Reset local state to props (used by SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setLocalTriggers(triggers);
  }, [triggers]);

  // Register with SaveBar
  useSaveBar({
    id: 'timer-triggers',
    sectionName: t('automation.timer_triggers.title', 'Timer Triggers'),
    hasChanges,
    isSaving,
    onSave: handleSaveForSaveBar,
    onDismiss: resetChanges
  });

  const handleAddTrigger = () => {
    if (!newName.trim()) {
      showToast(t('automation.timer_triggers.name_required', 'Name is required'), 'error');
      return;
    }
    if (!newCronExpression.trim() || cronError) {
      showToast(t('automation.timer_triggers.valid_cron_required', 'Valid cron expression is required'), 'error');
      return;
    }
    // Validate based on response type
    if (newResponseType === 'script' && !newScriptPath) {
      showToast(t('automation.timer_triggers.script_required', 'Script is required'), 'error');
      return;
    }
    if (newResponseType === 'text' && !newResponse.trim()) {
      showToast(t('automation.timer_triggers.message_required', 'Message is required'), 'error');
      return;
    }

    const newTrigger: TimerTrigger = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: newName.trim(),
      cronExpression: newCronExpression.trim(),
      responseType: newResponseType,
      scriptPath: newResponseType === 'script' ? newScriptPath : undefined,
      scriptArgs: newResponseType === 'script' && newScriptArgs.trim() ? newScriptArgs.trim() : undefined,
      response: newResponseType === 'text' ? newResponse.trim() : undefined,
      channel: newChannel,
      enabled: true,
    };

    setLocalTriggers([...localTriggers, newTrigger]);
    setNewName('');
    setNewNameManuallyEdited(false);
    setNewCronExpression('0 */6 * * *');
    setNewResponseType('script');
    setNewScriptPath('');
    setNewScriptArgs('');
    setNewResponse('');
    setNewChannel(0);
    showToast(t('automation.timer_triggers.added', 'Timer trigger added'), 'success');
  };

  const handleRemoveTrigger = (id: string) => {
    setLocalTriggers(localTriggers.filter(t => t.id !== id));
  };

  const handleToggleEnabled = (id: string) => {
    setLocalTriggers(localTriggers.map(t =>
      t.id === id ? { ...t, enabled: !t.enabled } : t
    ));
  };

  const handleUpdateTrigger = (id: string, updates: Partial<TimerTrigger>) => {
    setLocalTriggers(localTriggers.map(t =>
      t.id === id ? { ...t, ...updates } : t
    ));
  };

  const formatLastRun = (timestamp?: number) => {
    if (!timestamp) return t('automation.timer_triggers.never_run', 'Never');
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  return (
    <>
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '1.5rem',
        padding: '1rem 1.25rem',
        background: 'var(--ctp-surface1)',
        border: '1px solid var(--ctp-surface2)',
        borderRadius: '8px'
      }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {t('automation.timer_triggers.section_title', 'Timed Events')}
          <a
            href="https://meshmonitor.org/features/automation#timer-triggers"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none',
              marginLeft: '0.5rem'
            }}
            title={t('automation.timer_triggers.view_docs', 'View documentation')}
          >
            ?
          </a>
        </h2>
      </div>

      <div className="settings-section">
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('automation.timer_triggers.description', 'Schedule scripts to run automatically using cron expressions')}
        </p>
        {/* Add New Timer Form */}
        <div style={{
          padding: '1rem',
          background: 'var(--ctp-surface0)',
          borderRadius: '8px',
          marginBottom: '1rem',
        }}>
          <h4 style={{ margin: '0 0 1rem 0', fontSize: '0.95rem', color: 'var(--ctp-text)' }}>
            {t('automation.timer_triggers.add_new', 'Add New Timer')}
          </h4>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
                {t('automation.timer_triggers.name', 'Name:')}
              </label>
              <input
                type="text"
                value={newName}
                onChange={(e) => handleNameChange(e.target.value)}
                className="setting-input"
                style={{ flex: 1 }}
                placeholder={t('automation.timer_triggers.name_placeholder', 'e.g., Daily Report')}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
                {t('automation.timer_triggers.schedule', 'Schedule:')}
              </label>
              <div style={{ flex: 1 }}>
                <input
                  type="text"
                  value={newCronExpression}
                  onChange={(e) => setNewCronExpression(e.target.value)}
                  className="setting-input"
                  style={{
                    width: '100%',
                    fontFamily: 'monospace',
                    borderColor: cronError ? 'var(--ctp-red)' : undefined,
                  }}
                  placeholder="0 */6 * * *"
                />
                {cronError && (
                  <div style={{ color: 'var(--ctp-red)', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {cronError}
                  </div>
                )}
                <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)', marginTop: '0.25rem' }}>
                  {t('automation.timer_triggers.cron_help', 'Format: minute hour day month weekday')}
                  {' '}
                  <a
                    href="https://crontab.guru/"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--ctp-blue)' }}
                  >
                    crontab.guru
                  </a>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
                {t('automation.timer_triggers.response_type', 'Type:')}
              </label>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="newResponseType"
                    value="script"
                    checked={newResponseType === 'script'}
                    onChange={() => setNewResponseType('script')}
                  />
                  {t('automation.timer_triggers.type_script', 'Script')}
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="newResponseType"
                    value="text"
                    checked={newResponseType === 'text'}
                    onChange={() => setNewResponseType('text')}
                  />
                  {t('automation.timer_triggers.type_text', 'Text Message')}
                </label>
              </div>
            </div>

            {newResponseType === 'script' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
                  {t('automation.timer_triggers.script', 'Script:')}
                </label>
                <select
                  value={newScriptPath}
                  onChange={(e) => handleScriptSelect(e.target.value)}
                  className="setting-input"
                  style={{ flex: 1 }}
                >
                  <option value="">
                    {availableScripts.length === 0
                      ? t('automation.timer_triggers.no_scripts', 'No scripts found in /data/scripts/')
                      : t('automation.timer_triggers.select_script', 'Select a script...')}
                  </option>
                  {availableScripts.map((script) => (
                    <option key={script.path} value={script.path}>
                      {formatScriptDisplay(script)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {newResponseType === 'script' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
                  {t('automation.timer_triggers.script_args', 'Arguments:')}
                </label>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <input
                    type="text"
                    value={newScriptArgs}
                    onChange={(e) => setNewScriptArgs(e.target.value)}
                    className="setting-input"
                    style={{ width: '100%', fontFamily: 'monospace' }}
                    placeholder="--ip {IP} --count {NODECOUNT}"
                  />
                  <span style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)' }}>
                    {t('automation.timer_triggers.script_args_help', 'Optional CLI arguments. Tokens: {IP}, {PORT}, {VERSION}, {NODECOUNT}, etc.')}
                  </span>
                </div>
              </div>
            )}

            {newResponseType === 'text' && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                <label style={{ minWidth: '120px', fontSize: '0.9rem', paddingTop: '0.5rem' }}>
                  {t('automation.timer_triggers.message', 'Message:')}
                </label>
                <div style={{ flex: 1 }}>
                  <textarea
                    value={newResponse}
                    onChange={(e) => setNewResponse(e.target.value)}
                    className="setting-input"
                    style={{ width: '100%', minHeight: '60px', resize: 'vertical' }}
                    placeholder={t('automation.timer_triggers.message_placeholder', 'e.g., MeshMonitor {VERSION} - {NODECOUNT} nodes online')}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: '0.25rem' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)', flex: 1 }}>
                      {t('automation.timer_triggers.tokens_help', 'Available tokens:')}
                      {' '}
                      {AVAILABLE_TOKENS.map((tok, i) => (
                        <span key={tok.token}>
                          <code style={{ background: 'var(--ctp-surface1)', padding: '0 0.25rem', borderRadius: '2px' }}>{tok.token}</code>
                          {i < AVAILABLE_TOKENS.length - 1 && ', '}
                        </span>
                      ))}
                    </div>
                    <div style={{
                      fontSize: '0.75rem',
                      fontWeight: 'bold',
                      color: newResponse.length > 200 ? 'var(--ctp-red)' : newResponse.length > 150 ? 'var(--ctp-yellow)' : 'var(--ctp-subtext0)',
                      marginLeft: '0.5rem',
                      whiteSpace: 'nowrap',
                    }}>
                      {newResponse.length}/200
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
                {t('automation.timer_triggers.channel', 'Channel:')}
              </label>
              <select
                value={newChannel}
                onChange={(e) => setNewChannel(Number(e.target.value))}
                className="setting-input"
                style={{ flex: 1 }}
              >
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    Channel {channel.id}: {channel.name}
                  </option>
                ))}
              </select>
              <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)' }}>
                {t('automation.timer_triggers.channel_help_generic', 'Output will be sent to this channel')}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={handleAddTrigger}
                disabled={!newName.trim() || (newResponseType === 'script' ? !newScriptPath : !newResponse.trim()) || !!cronError}
                className="settings-button settings-button-primary"
                style={{
                  opacity: (!newName.trim() || (newResponseType === 'script' ? !newScriptPath : !newResponse.trim()) || !!cronError) ? 0.5 : 1,
                  cursor: (!newName.trim() || (newResponseType === 'script' ? !newScriptPath : !newResponse.trim()) || !!cronError) ? 'not-allowed' : 'pointer',
                }}
              >
                {t('automation.timer_triggers.add', 'Add Timer')}
              </button>
            </div>
          </div>
        </div>

        {/* Existing Timers List */}
        {localTriggers.length > 0 && (
          <div style={{ marginBottom: '1rem' }}>
            <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.95rem', color: 'var(--ctp-text)' }}>
              {t('automation.timer_triggers.existing', 'Existing Timers')} ({localTriggers.length})
            </h4>

            {localTriggers.map((trigger) => (
              <TimerTriggerItem
                key={trigger.id}
                trigger={trigger}
                isEditing={editingId === trigger.id}
                availableScripts={availableScripts}
                channels={channels}
                onStartEdit={() => setEditingId(trigger.id)}
                onCancelEdit={() => setEditingId(null)}
                onSaveEdit={(updates) => {
                  handleUpdateTrigger(trigger.id, updates);
                  setEditingId(null);
                }}
                onRemove={() => handleRemoveTrigger(trigger.id)}
                onToggleEnabled={() => handleToggleEnabled(trigger.id)}
                formatLastRun={formatLastRun}
                t={t}
              />
            ))}
          </div>
        )}

        {localTriggers.length === 0 && (
          <div style={{
            padding: '2rem',
            textAlign: 'center',
            color: 'var(--ctp-subtext0)',
            background: 'var(--ctp-surface0)',
            borderRadius: '8px',
          }}>
            {t('automation.timer_triggers.no_timers', 'No timer triggers configured. Add one above to schedule automatic script execution.')}
          </div>
        )}
      </div>
    </>
  );
};

// Individual Timer Trigger Item Component
interface TimerTriggerItemProps {
  trigger: TimerTrigger;
  isEditing: boolean;
  availableScripts: ScriptMetadata[];
  channels: Channel[];
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (updates: Partial<TimerTrigger>) => void;
  onRemove: () => void;
  onToggleEnabled: () => void;
  formatLastRun: (timestamp?: number) => string;
  t: ReturnType<typeof useTranslation>['t'];
}

const TimerTriggerItem: React.FC<TimerTriggerItemProps> = ({
  trigger,
  isEditing,
  availableScripts,
  channels,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRemove,
  onToggleEnabled,
  formatLastRun,
  t,
}) => {
  const [editName, setEditName] = useState(trigger.name);
  const [editCronExpression, setEditCronExpression] = useState(trigger.cronExpression);
  const [editResponseType, setEditResponseType] = useState<TimerResponseType>(trigger.responseType || 'script');
  const [editScriptPath, setEditScriptPath] = useState(trigger.scriptPath || '');
  const [editScriptArgs, setEditScriptArgs] = useState(trigger.scriptArgs || '');
  const [editResponse, setEditResponse] = useState(trigger.response || '');
  const [editChannel, setEditChannel] = useState(trigger.channel ?? 0);
  const [editCronError, setEditCronError] = useState<string | null>(null);
  const [showRemoveModal, setShowRemoveModal] = useState(false);

  useEffect(() => {
    if (isEditing) {
      setEditName(trigger.name);
      setEditCronExpression(trigger.cronExpression);
      setEditResponseType(trigger.responseType || 'script');
      setEditScriptPath(trigger.scriptPath || '');
      setEditScriptArgs(trigger.scriptArgs || '');
      setEditResponse(trigger.response || '');
      setEditChannel(trigger.channel ?? 0);
    }
  }, [isEditing, trigger]);

  useEffect(() => {
    if (editCronExpression) {
      if (!isValidCron(editCronExpression, { seconds: false, alias: true, allowBlankDay: true })) {
        setEditCronError(t('automation.timer_triggers.invalid_cron', 'Invalid cron expression'));
      } else {
        setEditCronError(null);
      }
    }
  }, [editCronExpression, t]);

  const handleSave = () => {
    const isValid = editName.trim() && !editCronError &&
      (editResponseType === 'script' ? editScriptPath : editResponse.trim());
    if (!isValid) return;
    onSaveEdit({
      name: editName.trim(),
      cronExpression: editCronExpression.trim(),
      responseType: editResponseType,
      scriptPath: editResponseType === 'script' ? editScriptPath : undefined,
      scriptArgs: editResponseType === 'script' && editScriptArgs.trim() ? editScriptArgs.trim() : undefined,
      response: editResponseType === 'text' ? editResponse.trim() : undefined,
      channel: editChannel,
    });
  };

  const responseType = trigger.responseType || 'script';
  const filename = trigger.scriptPath ? (trigger.scriptPath.split('/').pop() || trigger.scriptPath) : '';

  // Find script metadata for display
  const scriptMeta = trigger.scriptPath ? availableScripts.find(s => s.path === trigger.scriptPath) : undefined;
  const scriptEmoji = scriptMeta?.emoji || getLanguageEmoji(scriptMeta?.language || '');
  const scriptDisplayName = scriptMeta?.name || filename;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isEditing ? 'column' : 'row',
        alignItems: isEditing ? 'stretch' : 'center',
        gap: '0.5rem',
        padding: '0.75rem',
        marginBottom: '0.5rem',
        background: isEditing ? 'var(--ctp-surface1)' : 'var(--ctp-surface0)',
        border: isEditing ? '2px solid var(--ctp-blue)' : '1px solid var(--ctp-overlay0)',
        borderRadius: '4px',
        opacity: trigger.enabled ? 1 : 0.6,
      }}
    >
      {isEditing ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>Name:</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="setting-input"
                style={{ flex: 1 }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>Schedule:</label>
              <div style={{ flex: 1 }}>
                <input
                  type="text"
                  value={editCronExpression}
                  onChange={(e) => setEditCronExpression(e.target.value)}
                  className="setting-input"
                  style={{
                    width: '100%',
                    fontFamily: 'monospace',
                    borderColor: editCronError ? 'var(--ctp-red)' : undefined,
                  }}
                />
                {editCronError && (
                  <div style={{ color: 'var(--ctp-red)', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {editCronError}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>Type:</label>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name={`editResponseType-${trigger.id}`}
                    value="script"
                    checked={editResponseType === 'script'}
                    onChange={() => setEditResponseType('script')}
                  />
                  Script
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name={`editResponseType-${trigger.id}`}
                    value="text"
                    checked={editResponseType === 'text'}
                    onChange={() => setEditResponseType('text')}
                  />
                  Text Message
                </label>
              </div>
            </div>
            {editResponseType === 'script' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>Script:</label>
                <select
                  value={editScriptPath}
                  onChange={(e) => setEditScriptPath(e.target.value)}
                  className="setting-input"
                  style={{ flex: 1 }}
                >
                  {availableScripts.map((script) => (
                    <option key={script.path} value={script.path}>
                      {formatScriptDisplay(script)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {editResponseType === 'script' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>{t('automation.timer_triggers.script_args', 'Arguments:')}</label>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <input
                    type="text"
                    value={editScriptArgs}
                    onChange={(e) => setEditScriptArgs(e.target.value)}
                    className="setting-input"
                    style={{ width: '100%', fontFamily: 'monospace' }}
                    placeholder="--ip {IP} --count {NODECOUNT}"
                  />
                  <span style={{ fontSize: '0.7rem', color: 'var(--ctp-subtext0)' }}>
                    {t('automation.timer_triggers.script_args_help', 'Optional CLI arguments. Tokens: {IP}, {PORT}, {VERSION}, {NODECOUNT}, etc.')}
                  </span>
                </div>
              </div>
            )}
            {editResponseType === 'text' && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold', paddingTop: '0.5rem' }}>Message:</label>
                <div style={{ flex: 1 }}>
                  <textarea
                    value={editResponse}
                    onChange={(e) => setEditResponse(e.target.value)}
                    className="setting-input"
                    style={{ width: '100%', minHeight: '60px', resize: 'vertical' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.25rem' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--ctp-subtext0)' }}>
                      Tokens: {AVAILABLE_TOKENS.map(tok => tok.token).join(', ')}
                    </div>
                    <div style={{
                      fontSize: '0.7rem',
                      fontWeight: 'bold',
                      color: editResponse.length > 200 ? 'var(--ctp-red)' : editResponse.length > 150 ? 'var(--ctp-yellow)' : 'var(--ctp-subtext0)',
                    }}>
                      {editResponse.length}/200
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>Channel:</label>
              <select
                value={editChannel}
                onChange={(e) => setEditChannel(Number(e.target.value))}
                className="setting-input"
                style={{ flex: 1 }}
              >
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    Channel {channel.id}: {channel.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
            <button
              onClick={handleSave}
              disabled={!editName.trim() || (editResponseType === 'script' ? !editScriptPath : !editResponse.trim()) || !!editCronError}
              style={{
                padding: '0.25rem 0.75rem',
                fontSize: '12px',
                background: 'var(--ctp-green)',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: (!editName.trim() || (editResponseType === 'script' ? !editScriptPath : !editResponse.trim()) || !!editCronError) ? 'not-allowed' : 'pointer',
                opacity: (!editName.trim() || (editResponseType === 'script' ? !editScriptPath : !editResponse.trim()) || !!editCronError) ? 0.5 : 1,
              }}
            >
              Save
            </button>
            <button
              onClick={onCancelEdit}
              style={{
                padding: '0.25rem 0.75rem',
                fontSize: '12px',
                background: 'var(--ctp-surface2)',
                color: 'var(--ctp-text)',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{trigger.name}</div>
            <div style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)', fontFamily: 'monospace' }}>
              {trigger.cronExpression}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--ctp-subtext0)', marginTop: '0.25rem' }}>
              {responseType === 'script' ? (
                <>{scriptEmoji} {scriptDisplayName}</>
              ) : (
                <>💬 {trigger.response && trigger.response.length > 40 ? trigger.response.substring(0, 40) + '...' : trigger.response}</>
              )}
              {' → Ch '}{trigger.channel ?? 0}: {channels.find(c => c.id === (trigger.channel ?? 0))?.name || `Channel ${trigger.channel ?? 0}`}
            </div>
            {trigger.lastRun && (
              <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)', marginTop: '0.25rem' }}>
                Last run: {formatLastRun(trigger.lastRun)}
                {trigger.lastResult && (
                  <span style={{
                    marginLeft: '0.5rem',
                    color: trigger.lastResult === 'success' ? 'var(--ctp-green)' : 'var(--ctp-red)',
                  }}>
                    ({trigger.lastResult})
                  </span>
                )}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{
              fontSize: '0.7rem',
              padding: '0.15rem 0.4rem',
              background: trigger.enabled ? 'var(--ctp-green)' : 'var(--ctp-surface2)',
              color: trigger.enabled ? 'var(--ctp-base)' : 'var(--ctp-subtext0)',
              borderRadius: '3px',
              fontWeight: 'bold',
            }}>
              {trigger.enabled ? 'ENABLED' : 'DISABLED'}
            </span>
            <button
              onClick={onToggleEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: trigger.enabled ? 'var(--ctp-yellow)' : 'var(--ctp-green)',
                color: 'var(--ctp-base)',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              {trigger.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={onStartEdit}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-blue)',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Edit
            </button>
            <button
              onClick={() => setShowRemoveModal(true)}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-red)',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Remove
            </button>
          </div>
        </>
      )}

      {/* Remove Confirmation Modal */}
      {showRemoveModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000,
        }}>
          <div style={{
            background: 'var(--ctp-base)',
            borderRadius: '8px',
            padding: '1.5rem',
            maxWidth: '400px',
            width: '90%',
            border: '1px solid var(--ctp-overlay0)',
          }}>
            <h3 style={{ margin: '0 0 1rem 0', color: 'var(--ctp-text)' }}>Remove Timer</h3>
            <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1rem' }}>
              Are you sure you want to remove "{trigger.name}"?
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowRemoveModal(false)}
                style={{
                  padding: '0.5rem 1rem',
                  background: 'var(--ctp-surface1)',
                  color: 'var(--ctp-text)',
                  border: '1px solid var(--ctp-overlay0)',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onRemove();
                  setShowRemoveModal(false);
                }}
                style={{
                  padding: '0.5rem 1rem',
                  background: 'var(--ctp-red)',
                  color: 'var(--ctp-base)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TimerTriggersSection;
