import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GeofenceTrigger,
  GeofenceShape,
  GeofenceEvent,
  GeofenceNodeFilter,
  GeofenceResponseType,
  ScriptMetadata,
} from './auto-responder/types';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { Channel, DeviceInfo } from '../types/device';
import { useSaveBar } from '../hooks/useSaveBar';
import GeofenceMapEditor from './GeofenceMapEditor';
import GeofenceNodeSelector from './GeofenceNodeSelector';

// Available tokens for geofence text message expansion
const AVAILABLE_TOKENS = [
  { token: '{GEOFENCE_NAME}', description: 'Geofence name' },
  { token: '{EVENT}', description: 'Event type (entry/exit/while_inside)' },
  { token: '{LONG_NAME}', description: 'Node long name' },
  { token: '{SHORT_NAME}', description: 'Node short name' },
  { token: '{NODE_ID}', description: 'Node ID' },
  { token: '{NODE_LAT}', description: 'Node latitude' },
  { token: '{NODE_LON}', description: 'Node longitude' },
  { token: '{DISTANCE_TO_CENTER}', description: 'Distance to geofence center (km)' },
  { token: '{VERSION}', description: 'MeshMonitor version' },
  { token: '{NODECOUNT}', description: 'Total active nodes' },
];

const getLanguageEmoji = (language: string): string => {
  switch (language.toLowerCase()) {
    case 'python': return '\uD83D\uDC0D';
    case 'javascript': return '\uD83D\uDCD8';
    case 'shell': return '\uD83D\uDCBB';
    default: return '\uD83D\uDCC4';
  }
};

const formatScriptDisplay = (script: ScriptMetadata): string => {
  const langEmoji = getLanguageEmoji(script.language);
  if (script.name) {
    const emoji = script.emoji || langEmoji;
    return `${emoji} ${script.name} | ${script.filename} | ${script.language}`;
  }
  return `${langEmoji} ${script.filename}`;
};

interface GeofenceTriggersSectionProps {
  triggers: GeofenceTrigger[];
  channels: Channel[];
  nodes: DeviceInfo[];
  baseUrl: string;
  onTriggersChange: (triggers: GeofenceTrigger[]) => void;
}

const GeofenceTriggersSection: React.FC<GeofenceTriggersSectionProps> = ({
  triggers,
  channels,
  nodes,
  baseUrl,
  onTriggersChange,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();

  const [localTriggers, setLocalTriggers] = useState<GeofenceTrigger[]>(triggers);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [availableScripts, setAvailableScripts] = useState<ScriptMetadata[]>([]);

  // New trigger form state
  const [newName, setNewName] = useState('');
  const [newShapeType, setNewShapeType] = useState<'circle' | 'polygon'>('circle');
  const [newShape, setNewShape] = useState<GeofenceShape | null>(null);
  const [newEvent, setNewEvent] = useState<GeofenceEvent>('entry');
  const [newWhileInsideInterval, setNewWhileInsideInterval] = useState<number>(5);
  const [newNodeFilter, setNewNodeFilter] = useState<GeofenceNodeFilter>({ type: 'all' });
  const [newResponseType, setNewResponseType] = useState<GeofenceResponseType>('text');
  const [newScriptPath, setNewScriptPath] = useState('');
  const [newResponse, setNewResponse] = useState('');
  const [newChannel, setNewChannel] = useState<number | 'dm'>('dm');

  // Edit mode state
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null);

  useEffect(() => {
    setLocalTriggers(triggers);
  }, [triggers]);

  useEffect(() => {
    const changed = JSON.stringify(localTriggers) !== JSON.stringify(triggers);
    setHasChanges(changed);
  }, [localTriggers, triggers]);

  // Fetch available scripts
  useEffect(() => {
    const fetchScripts = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/scripts`);
        if (response.ok) {
          const data = await response.json();
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
        }
      } catch (error) {
        console.error('Failed to fetch available scripts:', error);
      }
    };
    fetchScripts();
  }, [baseUrl]);

  const handleSaveForSaveBar = useCallback(async () => {
    setIsSaving(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          geofenceTriggers: JSON.stringify(localTriggers),
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save settings');
      }

      onTriggersChange(localTriggers);
      showToast(t('automation.geofence_triggers.saved', 'Geofence triggers saved'), 'success');
    } catch (error) {
      showToast(t('automation.geofence_triggers.save_failed', 'Failed to save geofence triggers'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localTriggers, baseUrl, csrfFetch, showToast, t, onTriggersChange]);

  const resetChanges = useCallback(() => {
    setLocalTriggers(triggers);
  }, [triggers]);

  useSaveBar({
    id: 'geofence-triggers',
    sectionName: t('automation.geofence_triggers.title', 'Geofence Triggers'),
    hasChanges,
    isSaving,
    onSave: handleSaveForSaveBar,
    onDismiss: resetChanges,
  });

  const handleAddOrUpdateTrigger = () => {
    if (!newName.trim()) {
      showToast(t('automation.geofence_triggers.name_required', 'Name is required'), 'error');
      return;
    }
    if (!newShape) {
      showToast(t('automation.geofence_triggers.shape_required', 'Please define a geofence shape on the map'), 'error');
      return;
    }
    if (newResponseType === 'script' && !newScriptPath) {
      showToast(t('automation.geofence_triggers.script_required', 'Script is required'), 'error');
      return;
    }
    if (newResponseType === 'text' && !newResponse.trim()) {
      showToast(t('automation.geofence_triggers.message_required', 'Message is required'), 'error');
      return;
    }

    if (editingTriggerId) {
      // Update existing trigger
      setLocalTriggers(localTriggers.map(t => {
        if (t.id === editingTriggerId) {
          return {
            ...t,
            name: newName.trim(),
            shape: newShape,
            event: newEvent,
            whileInsideIntervalMinutes: newEvent === 'while_inside' ? newWhileInsideInterval : undefined,
            nodeFilter: newNodeFilter,
            responseType: newResponseType,
            response: newResponseType === 'text' ? newResponse.trim() : undefined,
            scriptPath: newResponseType === 'script' ? newScriptPath : undefined,
            channel: newChannel,
          };
        }
        return t;
      }));
      showToast(t('automation.geofence_triggers.updated', 'Geofence trigger updated'), 'success');
      setEditingTriggerId(null);
    } else {
      // Add new trigger
      const newTrigger: GeofenceTrigger = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: newName.trim(),
        enabled: true,
        shape: newShape,
        event: newEvent,
        whileInsideIntervalMinutes: newEvent === 'while_inside' ? newWhileInsideInterval : undefined,
        nodeFilter: newNodeFilter,
        responseType: newResponseType,
        response: newResponseType === 'text' ? newResponse.trim() : undefined,
        scriptPath: newResponseType === 'script' ? newScriptPath : undefined,
        channel: newChannel,
      };
      setLocalTriggers([...localTriggers, newTrigger]);
      showToast(t('automation.geofence_triggers.added', 'Geofence trigger added'), 'success');
    }

    // Reset form
    setNewName('');
    setNewShape(null);
    setNewShapeType('circle');
    setNewEvent('entry');
    setNewWhileInsideInterval(5);
    setNewNodeFilter({ type: 'all' });
    setNewResponseType('text');
    setNewScriptPath('');
    setNewResponse('');
    setNewChannel('dm');
  };

  const handleRemoveTrigger = (id: string) => {
    setLocalTriggers(localTriggers.filter(t => t.id !== id));
  };

  const handleToggleEnabled = (id: string) => {
    setLocalTriggers(localTriggers.map(t =>
      t.id === id ? { ...t, enabled: !t.enabled } : t
    ));
  };

  const handleStartEdit = (trigger: GeofenceTrigger) => {
    setEditingTriggerId(trigger.id);
    setNewName(trigger.name);
    setNewShapeType(trigger.shape.type);
    setNewShape(trigger.shape);
    setNewEvent(trigger.event);
    setNewWhileInsideInterval(trigger.whileInsideIntervalMinutes ?? 5);
    setNewNodeFilter(trigger.nodeFilter);
    setNewResponseType(trigger.responseType);
    setNewScriptPath(trigger.scriptPath ?? '');
    setNewResponse(trigger.response ?? '');
    setNewChannel(trigger.channel);
  };

  const handleCancelEdit = () => {
    setEditingTriggerId(null);
    setNewName('');
    setNewShape(null);
    setNewShapeType('circle');
    setNewEvent('entry');
    setNewWhileInsideInterval(5);
    setNewNodeFilter({ type: 'all' });
    setNewResponseType('text');
    setNewScriptPath('');
    setNewResponse('');
    setNewChannel('dm');
  };

  const formatLastRun = (timestamp?: number) => {
    if (!timestamp) return t('automation.geofence_triggers.never_run', 'Never');
    return new Date(timestamp).toLocaleString();
  };

  const eventLabel = (event: GeofenceEvent) => {
    switch (event) {
      case 'entry': return t('automation.geofence_triggers.event_entry', 'Entry');
      case 'exit': return t('automation.geofence_triggers.event_exit', 'Exit');
      case 'while_inside': return t('automation.geofence_triggers.event_while_inside', 'While Inside');
    }
  };

  const shapeLabel = (shape: GeofenceShape) => {
    if (shape.type === 'circle') {
      return `Circle (${shape.radiusKm.toFixed(1)} km)`;
    }
    return `Polygon (${shape.vertices.length} vertices)`;
  };

  const nodePositions = nodes
    .filter(n => (n.position?.latitude != null && n.position?.longitude != null))
    .map(n => ({
      nodeNum: n.nodeNum,
      lat: n.position!.latitude,
      lng: n.position!.longitude,
      longName: n.user?.longName,
    }));

  const selectorNodes = nodes.map(n => ({
    nodeNum: n.nodeNum,
    longName: n.user?.longName,
    shortName: n.user?.shortName,
    nodeId: n.user?.id,
  }));

  return (
    <>
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '1.5rem',
        padding: '1rem 1.25rem',
        background: 'var(--ctp-surface1)',
        border: '1px solid var(--ctp-surface2)',
        borderRadius: '8px',
      }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {t('automation.geofence_triggers.section_title', 'Geofence Triggers')}
        </h2>
      </div>

      <div className="settings-section">
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('automation.geofence_triggers.description', 'Trigger actions when nodes enter, exit, or remain inside geographic areas')}
        </p>

        {/* Add/Edit Geofence Trigger Form */}
        <div style={{
          padding: '1rem',
          background: editingTriggerId ? 'var(--ctp-surface1)' : 'var(--ctp-surface0)',
          borderRadius: '8px',
          marginBottom: '1rem',
          border: editingTriggerId ? '2px solid var(--ctp-blue)' : 'none',
        }}>
          <h4 style={{ margin: '0 0 1rem 0', fontSize: '0.95rem', color: 'var(--ctp-text)' }}>
            {editingTriggerId
              ? t('automation.geofence_triggers.edit_trigger', 'Edit Geofence Trigger')
              : t('automation.geofence_triggers.add_new', 'Add New Geofence Trigger')}
          </h4>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {/* Name */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
                {t('automation.geofence_triggers.name', 'Name:')}
              </label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="setting-input"
                style={{ flex: 1 }}
                placeholder={t('automation.geofence_triggers.name_placeholder', 'e.g., Base Camp Entry Alert')}
              />
            </div>

            {/* Shape Type */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
                {t('automation.geofence_triggers.shape_type', 'Shape:')}
              </label>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="newShapeType"
                    value="circle"
                    checked={newShapeType === 'circle'}
                    onChange={() => { setNewShapeType('circle'); setNewShape(null); }}
                  />
                  {t('automation.geofence_triggers.shape_circle', 'Circle')}
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="newShapeType"
                    value="polygon"
                    checked={newShapeType === 'polygon'}
                    onChange={() => { setNewShapeType('polygon'); setNewShape(null); }}
                  />
                  {t('automation.geofence_triggers.shape_polygon', 'Polygon')}
                </label>
              </div>
            </div>

            {/* Map Editor */}
            <GeofenceMapEditor
              shape={newShape}
              onShapeChange={setNewShape}
              shapeType={newShapeType}
              nodePositions={nodePositions}
            />

            {/* Event */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
                {t('automation.geofence_triggers.event', 'Event:')}
              </label>
              <select
                value={newEvent}
                onChange={(e) => setNewEvent(e.target.value as GeofenceEvent)}
                className="setting-input"
                style={{ flex: 1 }}
              >
                <option value="entry">{t('automation.geofence_triggers.event_entry', 'Entry')}</option>
                <option value="exit">{t('automation.geofence_triggers.event_exit', 'Exit')}</option>
                <option value="while_inside">{t('automation.geofence_triggers.event_while_inside', 'While Inside')}</option>
              </select>
            </div>

            {/* While Inside Interval */}
            {newEvent === 'while_inside' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
                  {t('automation.geofence_triggers.while_inside_interval', 'Interval (minutes):')}
                </label>
                <input
                  type="number"
                  value={newWhileInsideInterval}
                  onChange={(e) => setNewWhileInsideInterval(Math.max(1, parseInt(e.target.value) || 1))}
                  className="setting-input"
                  style={{ width: '100px' }}
                  min={1}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)' }}>
                  {t('automation.geofence_triggers.while_inside_interval_help', 'How often to fire while nodes remain inside')}
                </span>
              </div>
            )}

            {/* Node Filter */}
            <GeofenceNodeSelector
              nodeFilter={newNodeFilter}
              onFilterChange={setNewNodeFilter}
              nodes={selectorNodes}
            />

            {/* Response Type */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
                {t('automation.geofence_triggers.response_type', 'Type:')}
              </label>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="newGeofenceResponseType"
                    value="text"
                    checked={newResponseType === 'text'}
                    onChange={() => setNewResponseType('text')}
                  />
                  {t('automation.geofence_triggers.type_text', 'Text Message')}
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="newGeofenceResponseType"
                    value="script"
                    checked={newResponseType === 'script'}
                    onChange={() => setNewResponseType('script')}
                  />
                  {t('automation.geofence_triggers.type_script', 'Script')}
                </label>
              </div>
            </div>

            {/* Script Selector */}
            {newResponseType === 'script' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
                  {t('automation.geofence_triggers.script', 'Script:')}
                </label>
                <select
                  value={newScriptPath}
                  onChange={(e) => setNewScriptPath(e.target.value)}
                  className="setting-input"
                  style={{ flex: 1 }}
                >
                  <option value="">
                    {availableScripts.length === 0
                      ? t('automation.geofence_triggers.no_scripts', 'No scripts found in /data/scripts/')
                      : t('automation.geofence_triggers.select_script', 'Select a script...')}
                  </option>
                  {availableScripts.map((script) => (
                    <option key={script.path} value={script.path}>
                      {formatScriptDisplay(script)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Text Message */}
            {newResponseType === 'text' && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                <label style={{ minWidth: '120px', fontSize: '0.9rem', paddingTop: '0.5rem' }}>
                  {t('automation.geofence_triggers.message', 'Message:')}
                </label>
                <div style={{ flex: 1 }}>
                  <textarea
                    value={newResponse}
                    onChange={(e) => setNewResponse(e.target.value)}
                    className="setting-input"
                    style={{ width: '100%', minHeight: '60px', resize: 'vertical' }}
                    placeholder={t('automation.geofence_triggers.message_placeholder', 'e.g., {LONG_NAME} entered {GEOFENCE_NAME}')}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: '0.25rem' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)', flex: 1 }}>
                      {t('automation.geofence_triggers.tokens_help', 'Available tokens:')}
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

            {/* Channel */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
                {t('automation.geofence_triggers.channel', 'Channel:')}
              </label>
              <select
                value={newChannel}
                onChange={(e) => {
                  const val = e.target.value;
                  setNewChannel(val === 'dm' ? 'dm' : Number(val));
                }}
                className="setting-input"
                style={{ flex: 1 }}
              >
                <option value="dm">{t('auto_responder.direct_messages', 'Direct Message')}</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    Channel {channel.id}: {channel.name}
                  </option>
                ))}
              </select>
              <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)' }}>
                {t('automation.geofence_triggers.channel_help', 'Output will be sent to this channel')}
              </div>
            </div>

            {/* Add/Save Button */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              {editingTriggerId && (
                <button
                  onClick={handleCancelEdit}
                  className="settings-button"
                  style={{
                    background: 'var(--ctp-surface1)',
                    color: 'var(--ctp-text)',
                    border: '1px solid var(--ctp-overlay0)',
                  }}
                >
                  {t('common.cancel', 'Cancel')}
                </button>
              )}
              <button
                onClick={handleAddOrUpdateTrigger}
                disabled={!newName.trim() || !newShape || (newResponseType === 'script' ? !newScriptPath : !newResponse.trim())}
                className="settings-button settings-button-primary"
                style={{
                  opacity: (!newName.trim() || !newShape || (newResponseType === 'script' ? !newScriptPath : !newResponse.trim())) ? 0.5 : 1,
                  cursor: (!newName.trim() || !newShape || (newResponseType === 'script' ? !newScriptPath : !newResponse.trim())) ? 'not-allowed' : 'pointer',
                }}
              >
                {editingTriggerId
                  ? t('automation.geofence_triggers.save', 'Save Changes')
                  : t('automation.geofence_triggers.add', 'Add Geofence Trigger')}
              </button>
            </div>
          </div>
        </div>

        {/* Existing Triggers List */}
        {localTriggers.length > 0 && (
          <div style={{ marginBottom: '1rem' }}>
            <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.95rem', color: 'var(--ctp-text)' }}>
              {t('automation.geofence_triggers.existing', 'Existing Geofence Triggers')} ({localTriggers.length})
            </h4>

            {localTriggers.map((trigger) => (
              <GeofenceTriggerItem
                key={trigger.id}
                trigger={trigger}
                channels={channels}
                onEdit={() => handleStartEdit(trigger)}
                onRemove={() => handleRemoveTrigger(trigger.id)}
                onToggleEnabled={() => handleToggleEnabled(trigger.id)}
                formatLastRun={formatLastRun}
                eventLabel={eventLabel}
                shapeLabel={shapeLabel}
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
            {t('automation.geofence_triggers.no_triggers', 'No geofence triggers configured. Add one above to trigger actions based on node location.')}
          </div>
        )}
      </div>
    </>
  );
};

// Individual Geofence Trigger Item Component
interface GeofenceTriggerItemProps {
  trigger: GeofenceTrigger;
  channels: Channel[];
  onEdit: () => void;
  onRemove: () => void;
  onToggleEnabled: () => void;
  formatLastRun: (timestamp?: number) => string;
  eventLabel: (event: GeofenceEvent) => string;
  shapeLabel: (shape: GeofenceShape) => string;
}

const GeofenceTriggerItem: React.FC<GeofenceTriggerItemProps> = ({
  trigger,
  channels,
  onEdit,
  onRemove,
  onToggleEnabled,
  formatLastRun,
  eventLabel,
  shapeLabel,
}) => {
  const [showRemoveModal, setShowRemoveModal] = useState(false);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.75rem',
        marginBottom: '0.5rem',
        background: 'var(--ctp-surface0)',
        border: '1px solid var(--ctp-overlay0)',
        borderRadius: '4px',
        opacity: trigger.enabled ? 1 : 0.6,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{trigger.name}</div>
        <div style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
          {shapeLabel(trigger.shape)} | {eventLabel(trigger.event)}
          {trigger.event === 'while_inside' && trigger.whileInsideIntervalMinutes && (
            <> (every {trigger.whileInsideIntervalMinutes}min)</>
          )}
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--ctp-subtext0)', marginTop: '0.25rem' }}>
          {trigger.responseType === 'script' ? (
            <>Script: {trigger.scriptPath?.split('/').pop()}</>
          ) : (
            <>Text: {trigger.response && trigger.response.length > 40 ? trigger.response.substring(0, 40) + '...' : trigger.response}</>
          )}
          {' \u2192 '}{trigger.channel === 'dm' ? 'DM' : `Ch ${trigger.channel}: ${channels.find(c => c.id === trigger.channel)?.name || `Channel ${trigger.channel}`}`}
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--ctp-subtext0)', marginTop: '0.15rem' }}>
          Nodes: {trigger.nodeFilter.type === 'all' ? 'All' : `${trigger.nodeFilter.nodeNums.length} selected`}
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
          onClick={onEdit}
          style={{
            padding: '0.25rem 0.5rem',
            fontSize: '12px',
            background: 'var(--ctp-blue)',
            color: 'var(--ctp-base)',
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
            <h3 style={{ margin: '0 0 1rem 0', color: 'var(--ctp-text)' }}>Remove Geofence Trigger</h3>
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

export default GeofenceTriggersSection;
