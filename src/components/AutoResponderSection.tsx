import React, { useState, useEffect } from 'react';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

export type ResponseType = 'text' | 'http';

export interface AutoResponderTrigger {
  id: string;
  trigger: string;
  responseType: ResponseType;
  response: string; // Either text content or HTTP URL
}

interface AutoResponderSectionProps {
  enabled: boolean;
  triggers: AutoResponderTrigger[];
  baseUrl: string;
  onEnabledChange: (enabled: boolean) => void;
  onTriggersChange: (triggers: AutoResponderTrigger[]) => void;
}

const AutoResponderSection: React.FC<AutoResponderSectionProps> = ({
  enabled,
  triggers,
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
  const [testMessage, setTestMessage] = useState('w 33076');

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

    const trigger: AutoResponderTrigger = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      trigger: newTrigger.trim(),
      responseType: newResponseType,
      response: newResponse.trim(),
    };

    setLocalTriggers([...localTriggers, trigger]);
    setNewTrigger('');
    setNewResponse('');
  };

  const removeTrigger = (id: string) => {
    setLocalTriggers(localTriggers.filter(t => t.id !== id));
  };

  const extractParameters = (trigger: string): string[] => {
    const params: string[] = [];
    const regex = /{([^}]+)}/g;
    let match;
    while ((match = regex.exec(trigger)) !== null) {
      if (!params.includes(match[1])) {
        params.push(match[1]);
      }
    }
    return params;
  };

  const testTriggerMatch = (message: string): { trigger?: AutoResponderTrigger; params?: Record<string, string> } | null => {
    for (const trigger of localTriggers) {
      // Extract parameter names from trigger pattern
      const paramNames = extractParameters(trigger.trigger);

      // Build regex pattern from trigger
      // Replace {param} with capture groups
      let pattern = trigger.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Escape regex chars
      paramNames.forEach(param => {
        pattern = pattern.replace(`\\{${param}\\}`, '([\\w\\d.-]+)');
      });

      const regex = new RegExp(`^${pattern}$`, 'i');
      const match = message.match(regex);

      if (match) {
        const params: Record<string, string> = {};
        paramNames.forEach((param, index) => {
          params[param] = match[index + 1];
        });
        return { trigger, params };
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
          When enabled, automatically responds to direct messages matching trigger patterns. You can respond with static text or fetch dynamic content from HTTP URLs.
          Responses are only sent if HTTP URLs return status 200 and are truncated to 200 characters (including emoji expansions).
        </p>

        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            Add Trigger
            <span className="setting-description">
              Define a trigger pattern, response type, and response. Use braces for parameters (e.g., {'{location}'}, {'{zipcode}'})
            </span>
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', alignItems: 'flex-start' }}>
            <input
              type="text"
              value={newTrigger}
              onChange={(e) => setNewTrigger(e.target.value)}
              placeholder="e.g., w {location}"
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
            </select>
            <input
              type="text"
              value={newResponse}
              onChange={(e) => setNewResponse(e.target.value)}
              placeholder={newResponseType === 'text' ? 'e.g., Hello!' : 'e.g., https://wttr.in/{location}?format=4'}
              disabled={!localEnabled}
              className="setting-input"
              style={{ flex: '2', fontFamily: 'monospace' }}
            />
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
                <div
                  key={trigger.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.75rem',
                    marginBottom: '0.5rem',
                    background: 'var(--ctp-surface0)',
                    border: '1px solid var(--ctp-overlay0)',
                    borderRadius: '4px'
                  }}
                >
                  <div style={{ flex: '1', fontFamily: 'monospace', fontSize: '0.9rem' }}>
                    <div style={{ fontWeight: 'bold', color: 'var(--ctp-blue)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {trigger.trigger}
                      <span style={{
                        fontSize: '0.7rem',
                        padding: '0.15rem 0.4rem',
                        background: trigger.responseType === 'text' ? 'var(--ctp-green)' : 'var(--ctp-mauve)',
                        color: 'var(--ctp-base)',
                        borderRadius: '3px',
                        fontWeight: 'bold'
                      }}>
                        {trigger.responseType.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ color: 'var(--ctp-subtext0)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
                      {trigger.response}
                    </div>
                  </div>
                  <button
                    onClick={() => removeTrigger(trigger.id)}
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
              ))}
            </div>
          </div>
        )}

        {localTriggers.length > 0 && (
          <div className="setting-item" style={{ marginTop: '1.5rem' }}>
            <label htmlFor="testMessage">
              Test Trigger Matching
              <span className="setting-description">
                Enter a sample message to test which trigger would match and what response would be generated
              </span>
            </label>
            <input
              id="testMessage"
              type="text"
              value={testMessage}
              onChange={(e) => setTestMessage(e.target.value)}
              placeholder="e.g., w 33076"
              disabled={!localEnabled}
              className="setting-input"
              style={{ fontFamily: 'monospace', marginTop: '0.5rem' }}
            />
            {(() => {
              const match = testTriggerMatch(testMessage);
              if (!match) {
                return (
                  <div style={{
                    marginTop: '0.5rem',
                    padding: '0.75rem',
                    background: 'rgba(243, 139, 168, 0.1)',
                    border: '1px solid var(--ctp-red)',
                    borderRadius: '4px',
                    color: 'var(--ctp-red)',
                    fontFamily: 'monospace',
                    fontSize: '0.9rem'
                  }}>
                    No matching trigger
                  </div>
                );
              }
              const responseText = generateSampleResponse(match.trigger!, testMessage);
              return (
                <div style={{
                  marginTop: '0.5rem',
                  padding: '0.75rem',
                  background: 'rgba(166, 227, 161, 0.1)',
                  border: '1px solid var(--ctp-green)',
                  borderRadius: '4px',
                  fontFamily: 'monospace',
                  fontSize: '0.9rem'
                }}>
                  <div style={{ color: 'var(--ctp-green)', fontWeight: 'bold', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    ✓ Matches: {match.trigger?.trigger}
                    <span style={{
                      fontSize: '0.7rem',
                      padding: '0.15rem 0.4rem',
                      background: match.trigger?.responseType === 'text' ? 'var(--ctp-green)' : 'var(--ctp-mauve)',
                      color: 'var(--ctp-base)',
                      borderRadius: '3px',
                      fontWeight: 'bold'
                    }}>
                      {match.trigger?.responseType.toUpperCase()}
                    </span>
                  </div>
                  {match.params && Object.keys(match.params).length > 0 && (
                    <div style={{ color: 'var(--ctp-text)', marginBottom: '0.5rem' }}>
                      Parameters: {Object.entries(match.params).map(([k, v]) => `${k}=${v}`).join(', ')}
                    </div>
                  )}
                  <div style={{ color: 'var(--ctp-subtext0)', fontSize: '0.85rem' }}>
                    {match.trigger?.responseType === 'text' ? 'Response: ' : 'URL: '}{responseText}
                  </div>
                </div>
              );
            })()}
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
