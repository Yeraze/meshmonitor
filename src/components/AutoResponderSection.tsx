import React, { useState, useEffect } from 'react';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { Channel } from '../types/device';

export type ResponseType = 'text' | 'http' | 'script';

interface TriggerItemProps {
  trigger: AutoResponderTrigger;
  isEditing: boolean;
  localEnabled: boolean;
  availableScripts: string[];
  channels: Channel[];
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (trigger: string | string[], responseType: ResponseType, response: string, multiline: boolean, verifyResponse: boolean, channel: number | 'dm') => void;
  onRemove: () => void;
}

export interface AutoResponderTrigger {
  id: string;
  trigger: string | string[]; // Single pattern or array of patterns (e.g., "ask" or ["ask", "ask {message}"])
  responseType: ResponseType;
  response: string; // Either text content, HTTP URL, or script path
  multiline?: boolean; // Enable multiline support for text/http responses
  verifyResponse?: boolean; // Enable retry logic (3 attempts) for this trigger (DM only)
  channel?: number | 'dm'; // Channel index (0-7) or 'dm' for direct messages (default: 'dm')
}

interface AutoResponderSectionProps {
  enabled: boolean;
  triggers: AutoResponderTrigger[];
  channels: Channel[];
  baseUrl: string;
  onEnabledChange: (enabled: boolean) => void;
  onTriggersChange: (triggers: AutoResponderTrigger[]) => void;
}

const TriggerItem: React.FC<TriggerItemProps> = ({
  trigger,
  isEditing,
  localEnabled,
  availableScripts,
  channels,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRemove,
}) => {
  // Format trigger for editing (convert array to comma-separated string)
  const formatTriggerForEdit = (trigger: string | string[]): string => {
    if (Array.isArray(trigger)) {
      return trigger.join(', ');
    }
    return trigger;
  };

  // Format trigger for display
  const formatTriggerForDisplay = (trigger: string | string[]): string => {
    if (Array.isArray(trigger)) {
      return trigger.join(', ');
    }
    return trigger;
  };

  const [editTrigger, setEditTrigger] = useState(formatTriggerForEdit(trigger.trigger));
  const [editResponseType, setEditResponseType] = useState<ResponseType>(trigger.responseType);
  const [editResponse, setEditResponse] = useState(trigger.response);
  const [editMultiline, setEditMultiline] = useState(trigger.multiline || false);
  const [editVerifyResponse, setEditVerifyResponse] = useState(trigger.verifyResponse || false);
  const [editChannel, setEditChannel] = useState<number | 'dm'>(trigger.channel || 'dm');

  // Reset local edit state when editing mode changes
  useEffect(() => {
    if (isEditing) {
      setEditTrigger(formatTriggerForEdit(trigger.trigger));
      setEditResponseType(trigger.responseType);
      setEditResponse(trigger.response);
      setEditMultiline(trigger.multiline || false);
      setEditVerifyResponse(trigger.verifyResponse || false);
      setEditChannel(trigger.channel || 'dm');
    }
  }, [isEditing, trigger.trigger, trigger.responseType, trigger.response, trigger.multiline, trigger.verifyResponse, trigger.channel]);

  const handleSave = () => {
    // Automatically disable verifyResponse when channel is not DM
    const finalVerifyResponse = editChannel === 'dm' ? editVerifyResponse : false;
    // Normalize trigger: convert comma-separated string to array if needed
    let normalizedTrigger: string | string[];
    if (editTrigger.includes(',')) {
      normalizedTrigger = editTrigger.split(',').map(t => t.trim()).filter(t => t.length > 0);
      // If only one pattern after splitting, use string format for backward compatibility
      if (normalizedTrigger.length === 1) {
        normalizedTrigger = normalizedTrigger[0];
      }
    } else {
      normalizedTrigger = editTrigger.trim();
    }
    onSaveEdit(normalizedTrigger, editResponseType, editResponse, editMultiline, finalVerifyResponse, editChannel);
  };

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
        borderRadius: '4px'
      }}
    >
      {isEditing ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>Trigger:</label>
              <input
                type="text"
                value={editTrigger}
                onChange={(e) => setEditTrigger(e.target.value)}
                className="setting-input"
                style={{ flex: '1', fontFamily: 'monospace' }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>Type:</label>
              <select
                value={editResponseType}
                onChange={(e) => setEditResponseType(e.target.value as ResponseType)}
                className="setting-input"
                style={{ flex: '1' }}
              >
                <option value="text">Text Response</option>
                <option value="http">HTTP Request</option>
                <option value="script">Script Execution</option>
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
              <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold', paddingTop: '0.5rem' }}>Response:</label>
              {editResponseType === 'text' ? (
                <textarea
                  value={editResponse}
                  onChange={(e) => setEditResponse(e.target.value)}
                  className="setting-input"
                  style={{ flex: '1', fontFamily: 'monospace', minHeight: '60px', resize: 'vertical' }}
                  rows={3}
                />
              ) : editResponseType === 'script' ? (
                <select
                  value={editResponse}
                  onChange={(e) => setEditResponse(e.target.value)}
                  className="setting-input"
                  style={{ flex: '1', fontFamily: 'monospace' }}
                >
                  <option value="">
                    {availableScripts.length === 0 ? 'No scripts found in /data/scripts/' : 'Select a script...'}
                  </option>
                  {availableScripts.map((script) => (
                    <option key={script} value={script}>
                      {script}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={editResponse}
                  onChange={(e) => setEditResponse(e.target.value)}
                  className="setting-input"
                  style={{ flex: '1', fontFamily: 'monospace' }}
                />
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
              <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>Channel:</label>
              <select
                value={editChannel}
                onChange={(e) => {
                  const value = e.target.value === 'dm' ? 'dm' : parseInt(e.target.value);
                  setEditChannel(value);
                  // Auto-disable verifyResponse when switching to a channel
                  if (value !== 'dm') {
                    setEditVerifyResponse(false);
                  }
                }}
                className="setting-input"
                style={{ flex: '1' }}
              >
                <option value="dm">Direct Messages</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    Channel {channel.id}: {channel.name}
                  </option>
                ))}
              </select>
            </div>
            {editResponseType !== 'script' && (
              <div style={{ paddingLeft: '0.5rem', marginTop: '0.25rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', cursor: 'pointer', color: 'var(--ctp-subtext0)' }}>
                  <input
                    type="checkbox"
                    checked={editMultiline}
                    onChange={(e) => setEditMultiline(e.target.checked)}
                    style={{ marginRight: '0.5rem', cursor: 'pointer', verticalAlign: 'middle' }}
                  />
                  <span style={{ verticalAlign: 'middle' }}>Enable Multiline (split long responses into multiple messages)</span>
                </label>
              </div>
            )}
            <div style={{ paddingLeft: '0.5rem', marginTop: '0.25rem' }}>
              <label style={{ display: 'block', fontSize: '0.85rem', cursor: editChannel === 'dm' ? 'pointer' : 'not-allowed', color: 'var(--ctp-subtext0)', opacity: editChannel === 'dm' ? 1 : 0.5 }}>
                <input
                  type="checkbox"
                  checked={editVerifyResponse}
                  onChange={(e) => setEditVerifyResponse(e.target.checked)}
                  disabled={editChannel !== 'dm'}
                  style={{ marginRight: '0.5rem', cursor: editChannel === 'dm' ? 'pointer' : 'not-allowed', verticalAlign: 'middle' }}
                />
                <span style={{ verticalAlign: 'middle' }}>Verify Response (enable 3-retry delivery confirmation - DM only)</span>
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button
              onClick={handleSave}
              style={{
                padding: '0.25rem 0.75rem',
                fontSize: '12px',
                background: 'var(--ctp-green)',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer'
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
                cursor: 'pointer'
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ flex: '1', fontFamily: 'monospace', fontSize: '0.9rem' }}>
            <div style={{ fontWeight: 'bold', color: 'var(--ctp-blue)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {formatTriggerForDisplay(trigger.trigger)}
              <span style={{
                fontSize: '0.7rem',
                padding: '0.15rem 0.4rem',
                background: trigger.responseType === 'text' ? 'var(--ctp-green)' : trigger.responseType === 'script' ? 'var(--ctp-yellow)' : 'var(--ctp-mauve)',
                color: 'var(--ctp-base)',
                borderRadius: '3px',
                fontWeight: 'bold'
              }}>
                {trigger.responseType.toUpperCase()}
              </span>
              {trigger.multiline && (
                <span style={{
                  fontSize: '0.7rem',
                  padding: '0.15rem 0.4rem',
                  background: 'var(--ctp-teal)',
                  color: 'var(--ctp-base)',
                  borderRadius: '3px',
                  fontWeight: 'bold'
                }}>
                  MULTILINE
                </span>
              )}
              {trigger.verifyResponse && (
                <span style={{
                  fontSize: '0.7rem',
                  padding: '0.15rem 0.4rem',
                  background: 'var(--ctp-peach)',
                  color: 'var(--ctp-base)',
                  borderRadius: '3px',
                  fontWeight: 'bold'
                }}>
                  VERIFY
                </span>
              )}
              <span style={{
                fontSize: '0.7rem',
                padding: '0.15rem 0.4rem',
                background: (trigger.channel === 'dm' || !trigger.channel) ? 'var(--ctp-sky)' : 'var(--ctp-lavender)',
                color: 'var(--ctp-base)',
                borderRadius: '3px',
                fontWeight: 'bold'
              }}>
                {(trigger.channel === 'dm' || !trigger.channel)
                  ? 'DM'
                  : `CH ${trigger.channel}: ${channels.find(c => c.id === trigger.channel)?.name || 'Unknown'}`}
              </span>
            </div>
            <div style={{ color: 'var(--ctp-subtext0)', fontSize: '0.85rem', marginTop: '0.25rem', whiteSpace: 'pre-wrap' }}>
              {trigger.response}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={onStartEdit}
              disabled={!localEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-blue)',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: localEnabled ? 'pointer' : 'not-allowed',
                opacity: localEnabled ? 1 : 0.5
              }}
            >
              Edit
            </button>
            <button
              onClick={onRemove}
              disabled={!localEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-red)',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: localEnabled ? 'pointer' : 'not-allowed',
                opacity: localEnabled ? 1 : 0.5
              }}
            >
              Remove
            </button>
          </div>
        </>
      )}
    </div>
  );
};

const AutoResponderSection: React.FC<AutoResponderSectionProps> = ({
  enabled,
  triggers,
  channels,
  baseUrl,
  onEnabledChange,
  onTriggersChange,
}) => {
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localTriggers, setLocalTriggers] = useState<AutoResponderTrigger[]>(triggers);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [newTrigger, setNewTrigger] = useState('');
  const [newResponseType, setNewResponseType] = useState<ResponseType>('text');
  const [newResponse, setNewResponse] = useState('');
  const [newMultiline, setNewMultiline] = useState(false);
  const [newVerifyResponse, setNewVerifyResponse] = useState(false);
  const [newChannel, setNewChannel] = useState<number | 'dm'>('dm');
  const [testMessages, setTestMessages] = useState('w 33076\ntemp 72\nmsg hello world\nset temperature to 72');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [availableScripts, setAvailableScripts] = useState<string[]>([]);
  const [showExamples, setShowExamples] = useState(false);

  // Update local state when props change
  useEffect(() => {
    setLocalEnabled(enabled);
    setLocalTriggers(triggers);
  }, [enabled, triggers]);

  // Check if any settings have changed
  useEffect(() => {
    const changed = localEnabled !== enabled || JSON.stringify(localTriggers) !== JSON.stringify(triggers);
    setHasChanges(changed);
  }, [localEnabled, localTriggers, enabled, triggers]);

  // Fetch available scripts when component mounts
  useEffect(() => {
    const fetchScripts = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/scripts`);
        if (response.ok) {
          const data = await response.json();
          setAvailableScripts(data.scripts || []);
        }
      } catch (error) {
        console.error('Failed to fetch available scripts:', error);
      }
    };
    fetchScripts();
  }, [baseUrl]);

  const validateTrigger = (trigger: string): { valid: boolean; error?: string } => {
    if (!trigger.trim()) {
      return { valid: false, error: 'Trigger cannot be empty' };
    }
    if (trigger.length > 50) {
      return { valid: false, error: 'Trigger too long (max 50 characters)' };
    }
    return { valid: true };
  };

  const validateResponse = (response: string, type: ResponseType): { valid: boolean; error?: string } => {
    if (!response.trim()) {
      return { valid: false, error: 'Response cannot be empty' };
    }

    if (type === 'http') {
      try {
        // Test URL parsing (replace parameters with dummy values for validation)
        const urlObj = new URL(response.replace(/{[^}]+}/g, 'test'));
        if (!['http:', 'https:'].includes(urlObj.protocol)) {
          return { valid: false, error: 'URL must use http:// or https://' };
        }
      } catch (_error) {
        return { valid: false, error: 'Invalid URL format' };
      }
    } else if (type === 'script') {
      // Script path validation
      if (!response.startsWith('/data/scripts/')) {
        return { valid: false, error: 'Script path must start with /data/scripts/' };
      }
      const ext = response.split('.').pop()?.toLowerCase();
      if (!ext || !['js', 'mjs', 'py', 'sh'].includes(ext)) {
        return { valid: false, error: 'Script must have .js, .mjs, .py, or .sh extension' };
      }
      if (response.includes('..')) {
        return { valid: false, error: 'Script path cannot contain ..' };
      }
    } else {
      // Text response
      if (response.length > 200) {
        return { valid: false, error: 'Text response too long (max 200 characters)' };
      }
    }

    return { valid: true };
  };

  const addTrigger = () => {
    const triggerValidation = validateTrigger(newTrigger);
    if (!triggerValidation.valid) {
      showToast(triggerValidation.error || 'Invalid trigger', 'error');
      return;
    }

    const responseValidation = validateResponse(newResponse, newResponseType);
    if (!responseValidation.valid) {
      showToast(responseValidation.error || 'Invalid response', 'error');
      return;
    }

    // Normalize trigger: convert comma-separated string to array if needed
    let normalizedTrigger: string | string[];
    if (newTrigger.includes(',')) {
      normalizedTrigger = newTrigger.split(',').map(t => t.trim()).filter(t => t.length > 0);
      // If only one pattern after splitting, use string format for backward compatibility
      if (normalizedTrigger.length === 1) {
        normalizedTrigger = normalizedTrigger[0];
      }
    } else {
      normalizedTrigger = newTrigger.trim();
    }

    const trigger: AutoResponderTrigger = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      trigger: normalizedTrigger,
      responseType: newResponseType,
      response: newResponse.trim(),
      multiline: newResponseType !== 'script' ? newMultiline : undefined,
      verifyResponse: newChannel === 'dm' ? newVerifyResponse : false, // Only allow verify for DM
      channel: newChannel,
    };

    setLocalTriggers([...localTriggers, trigger]);
    setNewTrigger('');
    setNewResponse('');
    setNewMultiline(false);
    setNewVerifyResponse(false);
    setNewChannel('dm');
  };

  const removeTrigger = (id: string) => {
    setLocalTriggers(localTriggers.filter(t => t.id !== id));
    if (editingId === id) {
      setEditingId(null);
    }
  };

  const startEditing = (id: string) => {
    setEditingId(id);
  };

  const cancelEditing = () => {
    setEditingId(null);
  };

  const saveEdit = (id: string, trigger: string | string[], responseType: ResponseType, response: string, multiline: boolean, verifyResponse: boolean, channel: number | 'dm') => {
    // Normalize trigger for validation (convert to string if array)
    const triggerStr = Array.isArray(trigger) ? trigger.join(', ') : trigger;
    const triggerValidation = validateTrigger(triggerStr);
    if (!triggerValidation.valid) {
      showToast(triggerValidation.error || 'Invalid trigger', 'error');
      return;
    }

    const responseValidation = validateResponse(response, responseType);
    if (!responseValidation.valid) {
      showToast(responseValidation.error || 'Invalid response', 'error');
      return;
    }

    // Normalize trigger: if it's a comma-separated string, convert to array
    let normalizedTrigger: string | string[];
    if (typeof trigger === 'string' && trigger.includes(',')) {
      normalizedTrigger = trigger.split(',').map(t => t.trim()).filter(t => t.length > 0);
      // If only one pattern after splitting, use string format for backward compatibility
      if (normalizedTrigger.length === 1) {
        normalizedTrigger = normalizedTrigger[0];
      }
    } else {
      normalizedTrigger = typeof trigger === 'string' ? trigger.trim() : trigger;
    }

    setLocalTriggers(localTriggers.map(t =>
      t.id === id
        ? { ...t, trigger: normalizedTrigger, responseType, response: response.trim(), multiline: responseType !== 'script' ? multiline : undefined, verifyResponse, channel }
        : t
    ));
    setEditingId(null);
  };

  // Helper function to normalize trigger patterns (handle comma-separated strings)
  const normalizeTriggerPattern = (trigger: string | string[]): string[] => {
    if (Array.isArray(trigger)) {
      return trigger;
    }
    // Check if it's a comma-separated string (e.g., "ask, ask {message}")
    if (trigger.includes(',')) {
      return trigger.split(',').map(t => t.trim()).filter(t => t.length > 0);
    }
    return [trigger];
  };


  const extractParameters = (trigger: string): Array<{ name: string; pattern?: string }> => {
    const params: Array<{ name: string; pattern?: string }> = [];
    let i = 0;

    while (i < trigger.length) {
      if (trigger[i] === '{') {
        const startPos = i + 1;
        let depth = 1;
        let colonPos = -1;
        let endPos = -1;

        // Find the matching closing brace, accounting for nested braces in regex patterns
        for (let j = startPos; j < trigger.length && depth > 0; j++) {
          if (trigger[j] === '{') {
            depth++;
          } else if (trigger[j] === '}') {
            depth--;
            if (depth === 0) {
              endPos = j;
            }
          } else if (trigger[j] === ':' && depth === 1 && colonPos === -1) {
            colonPos = j;
          }
        }

        if (endPos !== -1) {
          const paramName = colonPos !== -1
            ? trigger.substring(startPos, colonPos)
            : trigger.substring(startPos, endPos);
          const paramPattern = colonPos !== -1
            ? trigger.substring(colonPos + 1, endPos)
            : undefined;

          if (!params.find(p => p.name === paramName)) {
            params.push({ name: paramName, pattern: paramPattern });
          }

          i = endPos + 1;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    return params;
  };

  // Helper function to match a single pattern against a message
  const matchSinglePattern = (patternStr: string, message: string): { matches: boolean; params?: Record<string, string> } => {
    const params = extractParameters(patternStr);

    // Build regex pattern from trigger by processing it character by character
    let pattern = '';
    const replacements: Array<{ start: number; end: number; replacement: string }> = [];
    let i = 0;

    while (i < patternStr.length) {
      if (patternStr[i] === '{') {
        const startPos = i;
        let depth = 1;
        let endPos = -1;

        // Find the matching closing brace
        for (let j = i + 1; j < patternStr.length && depth > 0; j++) {
          if (patternStr[j] === '{') {
            depth++;
          } else if (patternStr[j] === '}') {
            depth--;
            if (depth === 0) {
              endPos = j;
            }
          }
        }

        if (endPos !== -1) {
          const paramIndex = replacements.length;
          if (paramIndex < params.length) {
            const paramRegex = params[paramIndex].pattern || '[^\\s]+';
            replacements.push({
              start: startPos,
              end: endPos + 1,
              replacement: `(${paramRegex})`
            });
          }
          i = endPos + 1;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    // Build the final pattern by replacing placeholders
    for (let i = 0; i < patternStr.length; i++) {
      const replacement = replacements.find(r => r.start === i);
      if (replacement) {
        pattern += replacement.replacement;
        i = replacement.end - 1; // -1 because loop will increment
      } else {
        // Escape special regex characters in literal parts
        const char = patternStr[i];
        if (/[.*+?^${}()|[\]\\]/.test(char)) {
          pattern += '\\' + char;
        } else {
          pattern += char;
        }
      }
    }

    const regex = new RegExp(`^${pattern}$`, 'i');
    const match = message.match(regex);

    if (match) {
      const extractedParams: Record<string, string> = {};
      params.forEach((param, index) => {
        extractedParams[param.name] = match[index + 1];
      });
      return { matches: true, params: extractedParams };
    }

    return { matches: false };
  };

  const testTriggerMatch = (message: string): { trigger?: AutoResponderTrigger; params?: Record<string, string> } | null => {
    for (const trigger of localTriggers) {
      const patterns = normalizeTriggerPattern(trigger.trigger);
      
      // Try each pattern until one matches
      for (const patternStr of patterns) {
        const matchResult = matchSinglePattern(patternStr, message);
        if (matchResult.matches) {
          return { trigger, params: matchResult.params };
        }
      }
    }
    return null;
  };

  const generateSampleResponse = (trigger: AutoResponderTrigger, message: string): string => {
    const match = testTriggerMatch(message);
    if (!match || match.trigger?.id !== trigger.id) {
      return trigger.response;
    }

    let response = trigger.response;
    Object.entries(match.params || {}).forEach(([key, value]) => {
      response = response.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    });
    return response;
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Sync to backend
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoResponderEnabled: String(localEnabled),
          autoResponderTriggers: JSON.stringify(localTriggers)
        })
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast('Insufficient permissions to save settings', 'error');
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }

      // Update parent state after successful API call
      onEnabledChange(localEnabled);
      onTriggersChange(localTriggers);

      setHasChanges(false);
      showToast('Settings saved successfully!', 'success');
    } catch (error) {
      console.error('Failed to save auto-responder settings:', error);
      showToast('Failed to save settings. Please try again.', 'error');
    } finally {
      setIsSaving(false);
    }
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
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
            style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
          />
          Auto Responder
          <a
            href="https://meshmonitor.org/features/automation#auto-responder"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none',
              marginLeft: '0.5rem'
            }}
            title="View Auto Responder Documentation"
          >
            ❓
          </a>
        </h2>
        <button
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className="btn-primary"
          style={{
            padding: '0.5rem 1.5rem',
            fontSize: '14px',
            opacity: hasChanges ? 1 : 0.5,
            cursor: hasChanges ? 'pointer' : 'not-allowed'
          }}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          When enabled, automatically responds to direct messages matching trigger patterns. You can respond with static text, fetch dynamic content from HTTP URLs, or execute custom scripts.
          Scripts must be placed in /data/scripts and can be Node.js (.js, .mjs), Python (.py), or Shell (.sh). Responses are truncated to 200 characters (including emoji expansions).
        </p>

        {/* Regex Examples Section */}
        <div style={{
          marginBottom: '1.5rem',
          marginLeft: '1.75rem',
          marginRight: '1.75rem',
          background: 'var(--ctp-surface0)',
          border: '1px solid var(--ctp-overlay0)',
          borderRadius: '6px',
          overflow: 'hidden'
        }}>
          <button
            onClick={() => setShowExamples(!showExamples)}
            style={{
              width: '100%',
              padding: '0.75rem 1rem',
              background: 'var(--ctp-surface1)',
              border: 'none',
              borderBottom: showExamples ? '1px solid var(--ctp-overlay0)' : 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '0.9rem',
              fontWeight: 'bold',
              color: 'var(--ctp-blue)'
            }}
          >
            <span>💡 Regex Pattern Examples</span>
            <span style={{ fontSize: '1.2rem' }}>{showExamples ? '▼' : '▶'}</span>
          </button>
          {showExamples && (
            <div style={{ padding: '1rem', fontSize: '0.85rem', fontFamily: 'monospace' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                  <div style={{ fontWeight: 'bold', color: 'var(--ctp-mauve)', marginBottom: '0.5rem' }}>Numeric Patterns</div>
                  <div style={{ lineHeight: '1.8' }}>
                    <div><code style={{ background: 'var(--ctp-surface2)', padding: '2px 6px', borderRadius: '3px' }}>{'w {zip:\\d{5}}'}</code> - 5-digit zip code</div>
                    <div><code style={{ background: 'var(--ctp-surface2)', padding: '2px 6px', borderRadius: '3px' }}>{'temp {value:\\d+}'}</code> - Integer only</div>
                    <div><code style={{ background: 'var(--ctp-surface2)', padding: '2px 6px', borderRadius: '3px' }}>{'set {num:-?\\d+}'}</code> - Positive/negative int</div>
                    <div><code style={{ background: 'var(--ctp-surface2)', padding: '2px 6px', borderRadius: '3px' }}>{'price {amount:\\d+\\.\\d{2}}'}</code> - Dollar amount</div>
                  </div>
                </div>
                <div>
                  <div style={{ fontWeight: 'bold', color: 'var(--ctp-mauve)', marginBottom: '0.5rem' }}>Text Patterns</div>
                  <div style={{ lineHeight: '1.8' }}>
                    <div><code style={{ background: 'var(--ctp-surface2)', padding: '2px 6px', borderRadius: '3px' }}>{'msg {text:[\\w\\s]+}'}</code> - Multiple words</div>
                    <div><code style={{ background: 'var(--ctp-surface2)', padding: '2px 6px', borderRadius: '3px' }}>{'say {text:.+}'}</code> - Any text (greedy)</div>
                    <div><code style={{ background: 'var(--ctp-surface2)', padding: '2px 6px', borderRadius: '3px' }}>{'node {id:[a-zA-Z0-9]+}'}</code> - Alphanumeric</div>
                    <div><code style={{ background: 'var(--ctp-surface2)', padding: '2px 6px', borderRadius: '3px' }}>{'color {hex:[0-9a-fA-F]{6}}'}</code> - Hex color</div>
                  </div>
                </div>
                <div>
                  <div style={{ fontWeight: 'bold', color: 'var(--ctp-mauve)', marginBottom: '0.5rem' }}>Coordinates & Locations</div>
                  <div style={{ lineHeight: '1.8' }}>
                    <div><code style={{ background: 'var(--ctp-surface2)', padding: '2px 6px', borderRadius: '3px' }}>{'loc {lat:-?\\d+\\.?\\d*},{lon:-?\\d+\\.?\\d*}'}</code> - Lat/lon</div>
                    <div><code style={{ background: 'var(--ctp-surface2)', padding: '2px 6px', borderRadius: '3px' }}>{'grid {square:[A-R]{2}\\d{2}[a-x]{2}}'}</code> - Maidenhead</div>
                  </div>
                </div>
                <div>
                  <div style={{ fontWeight: 'bold', color: 'var(--ctp-mauve)', marginBottom: '0.5rem' }}>Date & Time</div>
                  <div style={{ lineHeight: '1.8' }}>
                    <div><code style={{ background: 'var(--ctp-surface2)', padding: '2px 6px', borderRadius: '3px' }}>{'at {time:\\d{1,2}:\\d{2}}'}</code> - HH:MM time</div>
                    <div><code style={{ background: 'var(--ctp-surface2)', padding: '2px 6px', borderRadius: '3px' }}>{'date {val:\\d{4}-\\d{2}-\\d{2}}'}</code> - YYYY-MM-DD</div>
                  </div>
                </div>
              </div>
              <div style={{
                marginTop: '1rem',
                paddingTop: '1rem',
                borderTop: '1px solid var(--ctp-overlay0)',
                color: 'var(--ctp-subtext0)',
                fontSize: '0.8rem',
                lineHeight: '1.6'
              }}>
                <strong>💡 Tips:</strong><br/>
                • Use <code style={{ background: 'var(--ctp-surface2)', padding: '2px 4px', borderRadius: '2px' }}>[^\\s]+</code> (default) for single words<br/>
                • Use <code style={{ background: 'var(--ctp-surface2)', padding: '2px 4px', borderRadius: '2px' }}>[\\w\\s]+</code> for multiple words<br/>
                • Use <code style={{ background: 'var(--ctp-surface2)', padding: '2px 4px', borderRadius: '2px' }}>.+</code> to match everything (including punctuation)<br/>
                • Remember to escape special regex chars: <code style={{ background: 'var(--ctp-surface2)', padding: '2px 4px', borderRadius: '2px' }}>\ . + * ? ^ $ {'{ }'} [ ] ( ) |</code>
              </div>
            </div>
          )}
        </div>

        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            Add Trigger
            <span className="setting-description">
              Define a trigger pattern, response type, and response. Use braces for parameters (e.g., {'{location}'}, {'{zipcode}'}).
              Optionally specify custom regex patterns: {'{param:regex}'} (e.g., {'{zip:\\d{5}}'}, {'{temp:\\d+}'}).
              For multiple patterns, separate with commas: "ask, ask {'{'} message{'}'}" matches both "ask" and "ask {'{'} message{'}'}"
            </span>
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', alignItems: 'flex-start' }}>
            <input
              type="text"
              value={newTrigger}
              onChange={(e) => setNewTrigger(e.target.value)}
              placeholder="e.g., ask, ask {message} or w {location} or w {zip:\d{5}}"
              disabled={!localEnabled}
              className="setting-input"
              style={{ flex: '1', fontFamily: 'monospace' }}
            />
            <select
              value={newResponseType}
              onChange={(e) => setNewResponseType(e.target.value as ResponseType)}
              disabled={!localEnabled}
              className="setting-input"
              style={{ width: '100px' }}
            >
              <option value="text">Text</option>
              <option value="http">HTTP</option>
              <option value="script">Script</option>
            </select>
            {newResponseType === 'text' ? (
              <textarea
                value={newResponse}
                onChange={(e) => setNewResponse(e.target.value)}
                placeholder="e.g., Hello!\nLine 2\nLine 3"
                disabled={!localEnabled}
                className="setting-input"
                style={{ flex: '2', fontFamily: 'monospace', minHeight: '60px', resize: 'vertical' }}
                rows={3}
              />
            ) : newResponseType === 'script' ? (
              <select
                value={newResponse}
                onChange={(e) => setNewResponse(e.target.value)}
                disabled={!localEnabled || availableScripts.length === 0}
                className="setting-input"
                style={{ flex: '2', fontFamily: 'monospace' }}
              >
                <option value="">
                  {availableScripts.length === 0 ? 'No scripts found in /data/scripts/' : 'Select a script...'}
                </option>
                {availableScripts.map((script) => (
                  <option key={script} value={script}>
                    {script}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={newResponse}
                onChange={(e) => setNewResponse(e.target.value)}
                placeholder="e.g., https://wttr.in/{location}?format=4"
                disabled={!localEnabled}
                className="setting-input"
                style={{ flex: '2', fontFamily: 'monospace' }}
              />
            )}
            <button
              onClick={addTrigger}
              disabled={!localEnabled || !newTrigger.trim() || !newResponse.trim()}
              className="btn-primary"
              style={{
                padding: '0.5rem 1rem',
                fontSize: '14px',
                opacity: (localEnabled && newTrigger.trim() && newResponse.trim()) ? 1 : 0.5,
                cursor: (localEnabled && newTrigger.trim() && newResponse.trim()) ? 'pointer' : 'not-allowed'
              }}
            >
              Add
            </button>
          </div>
          <div style={{ marginTop: '0.5rem', paddingLeft: '0.5rem' }}>
            <label style={{ fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem', display: 'block' }}>
              Channel:
            </label>
            <select
              value={newChannel}
              onChange={(e) => {
                const value = e.target.value === 'dm' ? 'dm' : parseInt(e.target.value);
                setNewChannel(value);
                // Auto-disable verifyResponse when switching to a channel
                if (value !== 'dm') {
                  setNewVerifyResponse(false);
                }
              }}
              disabled={!localEnabled}
              className="setting-input"
              style={{ width: '100%', maxWidth: '400px' }}
            >
              <option value="dm">Direct Messages</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  Channel {channel.id}: {channel.name}
                </option>
              ))}
            </select>
          </div>
          {newResponseType !== 'script' && (
            <div style={{ marginTop: '0.5rem', paddingLeft: '0.5rem' }}>
              <label style={{ display: 'block', fontSize: '0.85rem', cursor: localEnabled ? 'pointer' : 'not-allowed', color: 'var(--ctp-subtext0)' }}>
                <input
                  type="checkbox"
                  checked={newMultiline}
                  onChange={(e) => setNewMultiline(e.target.checked)}
                  disabled={!localEnabled}
                  style={{ marginRight: '0.5rem', cursor: localEnabled ? 'pointer' : 'not-allowed', verticalAlign: 'middle' }}
                />
                <span style={{ verticalAlign: 'middle' }}>Enable Multiline (split long responses into multiple messages)</span>
              </label>
            </div>
          )}
          <div style={{ marginTop: '0.5rem', paddingLeft: '0.5rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', cursor: (localEnabled && newChannel === 'dm') ? 'pointer' : 'not-allowed', color: 'var(--ctp-subtext0)', opacity: newChannel === 'dm' ? 1 : 0.5 }}>
              <input
                type="checkbox"
                checked={newVerifyResponse}
                onChange={(e) => setNewVerifyResponse(e.target.checked)}
                disabled={!localEnabled || newChannel !== 'dm'}
                style={{ marginRight: '0.5rem', cursor: localEnabled ? 'pointer' : 'not-allowed', verticalAlign: 'middle' }}
              />
              <span style={{ verticalAlign: 'middle' }}>Verify Response (enable 3-retry delivery confirmation)</span>
            </label>
          </div>
        </div>

        {localTriggers.length > 0 && (
          <div className="setting-item" style={{ marginTop: '1.5rem' }}>
            <label>
              Configured Triggers
              <span className="setting-description">
                Current trigger patterns and their responses
              </span>
            </label>
            <div style={{ marginTop: '0.5rem' }}>
              {localTriggers.map((trigger) => (
                <TriggerItem
                  key={trigger.id}
                  trigger={trigger}
                  isEditing={editingId === trigger.id}
                  localEnabled={localEnabled}
                  availableScripts={availableScripts}
                  channels={channels}
                  onStartEdit={() => startEditing(trigger.id)}
                  onCancelEdit={cancelEditing}
                  onSaveEdit={(t, rt, r, m, v, c) => saveEdit(trigger.id, t, rt, r, m, v, c)}
                  onRemove={() => removeTrigger(trigger.id)}
                />
              ))}
            </div>
          </div>
        )}

        {localTriggers.length > 0 && (
          <div className="setting-item" style={{ marginTop: '1.5rem' }}>
            <label htmlFor="testMessages">
              Test Trigger Matching
              <span className="setting-description">
                Enter sample messages (one per line) to test which triggers match.
                Green = matches trigger, Red = no match
              </span>
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '0.5rem' }}>
              <div>
                <textarea
                  id="testMessages"
                  value={testMessages}
                  onChange={(e) => setTestMessages(e.target.value)}
                  placeholder="Enter test messages, one per line..."
                  disabled={!localEnabled}
                  className="setting-input"
                  rows={6}
                  style={{
                    fontFamily: 'monospace',
                    resize: 'vertical',
                    minHeight: '140px',
                    width: '100%'
                  }}
                />
              </div>
              <div>
                {testMessages.split('\n').filter(line => line.trim()).map((message, index) => {
                  const match = testTriggerMatch(message);
                  return (
                    <div
                      key={index}
                      style={{
                        padding: '0.5rem',
                        marginBottom: '0.25rem',
                        backgroundColor: match ? 'rgba(166, 227, 161, 0.1)' : 'rgba(243, 139, 168, 0.1)',
                        border: `1px solid ${match ? 'var(--ctp-green)' : 'var(--ctp-red)'}`,
                        borderRadius: '4px',
                        fontFamily: 'monospace',
                        fontSize: '0.85rem',
                        lineHeight: '1.4'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.25rem' }}>
                        <span
                          style={{
                            display: 'inline-block',
                            width: '12px',
                            height: '12px',
                            borderRadius: '50%',
                            backgroundColor: match ? 'var(--ctp-green)' : 'var(--ctp-red)',
                            marginRight: '0.5rem',
                            flexShrink: 0
                          }}
                        />
                        <span style={{ color: 'var(--ctp-text)', fontWeight: 'bold', wordBreak: 'break-word' }}>
                          {message}
                        </span>
                      </div>
                      {match ? (
                        <div style={{ marginLeft: '1.25rem', fontSize: '0.8rem' }}>
                          <div style={{ color: 'var(--ctp-blue)', marginBottom: '0.15rem' }}>
                            ▸ {match.trigger?.trigger}
                            <span style={{
                              fontSize: '0.65rem',
                              padding: '0.1rem 0.3rem',
                              background: match.trigger?.responseType === 'text' ? 'var(--ctp-green)' : match.trigger?.responseType === 'script' ? 'var(--ctp-yellow)' : 'var(--ctp-mauve)',
                              color: 'var(--ctp-base)',
                              borderRadius: '2px',
                              fontWeight: 'bold',
                              marginLeft: '0.5rem'
                            }}>
                              {match.trigger?.responseType.toUpperCase()}
                            </span>
                          </div>
                          {match.params && Object.keys(match.params).length > 0 && (
                            <div style={{ color: 'var(--ctp-subtext0)', marginBottom: '0.15rem' }}>
                              📋 {Object.entries(match.params).map(([k, v]) => `${k}="${v}"`).join(', ')}
                            </div>
                          )}
                          <div style={{ color: 'var(--ctp-subtext1)' }}>
                            💬 {generateSampleResponse(match.trigger!, message)}
                          </div>
                        </div>
                      ) : (
                        <div style={{ marginLeft: '1.25rem', color: 'var(--ctp-subtext0)', fontSize: '0.75rem' }}>
                          No matching trigger
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {localTriggers.length === 0 && (
          <div style={{
            marginTop: '1.5rem',
            padding: '1rem',
            background: 'var(--ctp-surface0)',
            border: '1px solid var(--ctp-overlay0)',
            borderRadius: '4px',
            color: 'var(--ctp-subtext0)',
            textAlign: 'center',
            fontStyle: 'italic'
          }}>
            No triggers configured. Add your first trigger above to get started.
          </div>
        )}
      </div>
    </>
  );
};

export default AutoResponderSection;
