import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSaveBar } from '../hooks/useSaveBar';
import {
  AutoResponderTrigger,
  AutoResponderSectionProps,
  ResponseType,
  ScriptMetadata
} from './auto-responder/types';
import { 
  getFileIcon, 
  splitTriggerPatterns, 
  formatTriggerPatterns,
  extractParameters,
  buildRegexPattern,
  getMatchPositions,
  testSinglePattern,
  getExampleValueForParam
} from './auto-responder/utils';
import TriggerItem from './auto-responder/TriggerItem';
import PatternExamples from './auto-responder/PatternExamples';
import ScriptManagement from './auto-responder/ScriptManagement';

const AutoResponderSection: React.FC<AutoResponderSectionProps> = ({
  enabled,
  triggers,
  channels,
  skipIncompleteNodes,
  baseUrl,
  onEnabledChange,
  onTriggersChange,
  onSkipIncompleteNodesChange,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localTriggers, setLocalTriggers] = useState<AutoResponderTrigger[]>(triggers);
  const [localSkipIncompleteNodes, setLocalSkipIncompleteNodes] = useState(skipIncompleteNodes);
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
  const [availableScripts, setAvailableScripts] = useState<ScriptMetadata[]>([]);
  const [newTriggerValidation, setNewTriggerValidation] = useState<{ valid: boolean; error?: string }>({ valid: true });
  const [currentTestLine, setCurrentTestLine] = useState<string>('');
  const [quickTestResult, setQuickTestResult] = useState<{ loading: boolean; result: string | null; error?: string } | null>(null);
  const [showMatchDetails, setShowMatchDetails] = useState<Record<number, boolean>>({});
  const [showDebugInfo, setShowDebugInfo] = useState<Record<number, boolean>>({});
  const [triggerSearch, setTriggerSearch] = useState('');
  const [triggerFilter, setTriggerFilter] = useState<'all' | 'text' | 'http' | 'script'>('all');
  const [liveTestResults, setLiveTestResults] = useState<Record<number, { loading: boolean; result: string | null; error?: string }>>({});
  const [newTriggerTestInput, setNewTriggerTestInput] = useState('');
  const [newTriggerLiveTestResult, setNewTriggerLiveTestResult] = useState<{ loading: boolean; result: string | null; error?: string } | null>(null);
  const [selectedScripts, setSelectedScripts] = useState<Set<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [scriptToDelete, setScriptToDelete] = useState<string | null>(null);

  // Update local state when props change
  useEffect(() => {
    setLocalEnabled(enabled);
    setLocalTriggers(triggers);
    setLocalSkipIncompleteNodes(skipIncompleteNodes);
  }, [enabled, triggers, skipIncompleteNodes]);

  // Check if any settings have changed
  useEffect(() => {
    const changed = localEnabled !== enabled || JSON.stringify(localTriggers) !== JSON.stringify(triggers) || localSkipIncompleteNodes !== skipIncompleteNodes;
    setHasChanges(changed);
  }, [localEnabled, localTriggers, localSkipIncompleteNodes, enabled, triggers, skipIncompleteNodes]);

  // Reset local state to props (used by SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setLocalEnabled(enabled);
    setLocalTriggers(triggers);
    setLocalSkipIncompleteNodes(skipIncompleteNodes);
  }, [enabled, triggers, skipIncompleteNodes]);

  // Validate new trigger in realtime
  useEffect(() => {
    if (newTrigger.trim()) {
      const validation = validateTrigger(newTrigger);
      setNewTriggerValidation(validation);
    } else {
      setNewTriggerValidation({ valid: true });
    }
  }, [newTrigger]);

  // Fetch available scripts when component mounts and after import/delete
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

  useEffect(() => {
    fetchScripts();
  }, [baseUrl]);

  // Script management handlers
  const handleImportScript = async (file: File) => {
    setIsImporting(true);
    try {
      const fileContent = await file.arrayBuffer();
      const response = await csrfFetch(`${baseUrl}/api/scripts/import`, {
        method: 'POST',
        headers: {
          'x-filename': file.name,
          'Content-Type': 'application/octet-stream'
        },
        body: fileContent
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to import script');
      }

      showToast(t('auto_responder.script_imported'), 'success');
      await fetchScripts();
      setShowImportModal(false);
    } catch (error: any) {
      showToast(error.message || t('auto_responder.script_import_failed'), 'error');
    } finally {
      setIsImporting(false);
    }
  };

  const handleExportScripts = async () => {
    const scriptsToExport = selectedScripts.size > 0 
      ? Array.from(selectedScripts)
      : availableScripts;

    if (scriptsToExport.length === 0) {
      showToast(t('auto_responder.no_scripts_to_export'), 'warning');
      return;
    }

    setIsExporting(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/scripts/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scripts: scriptsToExport })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to export scripts');
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
    } catch (error: any) {
      showToast(error.message || t('auto_responder.script_export_failed'), 'error');
    } finally {
      setIsExporting(false);
    }
  };

  const handleDeleteScript = async (filename: string) => {
    setIsDeleting(filename);
    try {
      const response = await csrfFetch(`${baseUrl}/api/scripts/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete script');
      }

      showToast(t('auto_responder.script_deleted'), 'success');
      await fetchScripts();
      setSelectedScripts(prev => {
        const next = new Set(prev);
        next.delete(filename);
        return next;
      });
      setShowDeleteModal(false);
      setScriptToDelete(null);
    } catch (error: any) {
      showToast(error.message || t('auto_responder.script_delete_failed'), 'error');
    } finally {
      setIsDeleting(null);
    }
  };

  const toggleScriptSelection = (script: string) => {
    setSelectedScripts(prev => {
      const next = new Set(prev);
      if (next.has(script)) {
        next.delete(script);
      } else {
        next.add(script);
      }
      return next;
    });
  };

  const selectAllScripts = () => {
    setSelectedScripts(new Set(availableScripts.map(s => s.path)));
  };

  const deselectAllScripts = () => {
    setSelectedScripts(new Set());
  };


  const validateTrigger = (trigger: string | string[]): { valid: boolean; error?: string } => {
    // Handle array format
    if (Array.isArray(trigger)) {
      if (trigger.length === 0) {
      return { valid: false, error: 'Trigger cannot be empty' };
    }
      // Validate each pattern in the array
      for (const pattern of trigger) {
        if (typeof pattern !== 'string' || !pattern.trim()) {
          continue; // Skip empty patterns
        }
        const validation = validateTrigger(pattern);
        if (!validation.valid) {
          return validation;
        }
      }
      return { valid: true };
    }
    
    // Handle string format
    if (!trigger || typeof trigger !== 'string' || !trigger.trim()) {
      return { valid: false, error: 'Trigger cannot be empty' };
    }
    
    // Split into individual patterns and validate each
    const patterns = splitTriggerPatterns(trigger);
    
    if (patterns.length === 0) {
      return { valid: false, error: 'Trigger cannot be empty' };
    }
    
    // Validate each pattern individually
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      if (!pattern.trim()) {
        return { valid: false, error: `Pattern ${i + 1} cannot be empty` };
      }
      if (pattern.length > 100) {
        return { valid: false, error: `Pattern ${i + 1} too long (max 100 characters per pattern)` };
      }
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
      showToast(triggerValidation.error || t('auto_responder.invalid_trigger'), 'error');
      return;
    }

    const responseValidation = validateResponse(newResponse, newResponseType);
    if (!responseValidation.valid) {
      showToast(responseValidation.error || t('auto_responder.invalid_response'), 'error');
      return;
    }

    const trigger: AutoResponderTrigger = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      trigger: newTrigger.trim(),
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

  const saveEdit = (id: string, trigger: string | string[], responseType: ResponseType, response: string, multiline: boolean, verifyResponse: boolean, channel: number | 'dm' | 'none', scriptArgs?: string) => {
    const triggerValidation = validateTrigger(trigger);
    if (!triggerValidation.valid) {
      showToast(triggerValidation.error || t('auto_responder.invalid_trigger'), 'error');
      return;
    }

    const responseValidation = validateResponse(response, responseType);
    if (!responseValidation.valid) {
      showToast(responseValidation.error || t('auto_responder.invalid_response'), 'error');
      return;
    }

    setLocalTriggers(localTriggers.map(t =>
      t.id === id
        ? { ...t, trigger: Array.isArray(trigger) ? trigger : trigger.trim(), responseType, response: response.trim(), multiline: responseType !== 'script' ? multiline : undefined, verifyResponse, channel, scriptArgs: responseType === 'script' ? scriptArgs : undefined }
        : t
    ));
    setEditingId(null);
  };


  /**
   * Tests a message against all triggers and returns the first match.
   * For conflict detection, use testAllTriggerMatches instead.
   */
  const testTriggerMatch = (message: string): { trigger?: AutoResponderTrigger; params?: Record<string, string>; matchedPattern?: string; regexPattern?: string; matchPositions?: Array<{ start: number; end: number; type: 'literal' | 'parameter' }> } | null => {
    for (const trigger of localTriggers) {
      // Split trigger into individual patterns
      const patterns = splitTriggerPatterns(trigger.trigger);
      
      // Try each pattern until one matches
      for (const pattern of patterns) {
        const match = testSinglePattern(pattern, message);
        if (match) {
          // Build regex pattern for display
          const regexPattern = buildRegexPattern(pattern);
          // Get match positions
          const matchPositions = getMatchPositions(pattern, message, match.params || {});
          
          return { 
            trigger, 
            params: match.params,
            matchedPattern: pattern,
            regexPattern,
            matchPositions
          };
        }
      }
    }
    return null;
  };

  /**
   * Tests a message against all triggers and returns ALL matches (for conflict detection).
   */
  const testAllTriggerMatches = (message: string): Array<{ trigger: AutoResponderTrigger; params?: Record<string, string>; matchedPattern?: string; regexPattern?: string }> => {
    const matches: Array<{ trigger: AutoResponderTrigger; params?: Record<string, string>; matchedPattern?: string; regexPattern?: string }> = [];
    
    for (const trigger of localTriggers) {
      const patterns = splitTriggerPatterns(trigger.trigger);
      
      for (const pattern of patterns) {
        const match = testSinglePattern(pattern, message);
        if (match) {
          const regexPattern = buildRegexPattern(pattern);
          matches.push({
            trigger,
            params: match.params,
            matchedPattern: pattern,
            regexPattern
          });
          break; // Only add one match per trigger (first matching pattern)
        }
      }
    }
    
    return matches;
  };


  /**
   * Generates a sample response with parameter substitution.
   * Enhanced version that shows preview with example values if no match.
   */
  const generateSampleResponse = (trigger: AutoResponderTrigger, message?: string): string => {
    let response = trigger.response;
    
    // If message provided, try to match and extract real parameters
    if (message) {
      const match = testTriggerMatch(message);
      if (match && match.trigger?.id === trigger.id && match.params) {
        Object.entries(match.params).forEach(([key, value]) => {
      response = response.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    });
        return response;
      }
    }
    
    // Otherwise, use example values for preview
    const triggerStr = Array.isArray(trigger.trigger) ? trigger.trigger.join(', ') : trigger.trigger;
    const params = extractParameters(triggerStr);
    params.forEach((param) => {
      const exampleValue = getExampleValueForParam(param.name, param.pattern);
      response = response.replace(new RegExp(`\\{${param.name}\\}`, 'g'), exampleValue);
    });
    
    return response;
  };



  const handleSaveForSaveBar = useCallback(async () => {
    setIsSaving(true);
    try {
      // Sync to backend
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoResponderEnabled: String(localEnabled),
          autoResponderTriggers: JSON.stringify(localTriggers),
          autoResponderSkipIncompleteNodes: String(localSkipIncompleteNodes)
        })
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('common.permission_denied'), 'error');
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }

      // Update parent state after successful API call
      onEnabledChange(localEnabled);
      onTriggersChange(localTriggers);
      onSkipIncompleteNodesChange(localSkipIncompleteNodes);

      setHasChanges(false);
      showToast(t('auto_responder.settings_saved'), 'success');
    } catch (error) {
      console.error('Failed to save auto-responder settings:', error);
      showToast(t('auto_responder.settings_save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localEnabled, localTriggers, localSkipIncompleteNodes, baseUrl, csrfFetch, showToast, t, onEnabledChange, onTriggersChange, onSkipIncompleteNodesChange]);

  // Register with SaveBar
  useSaveBar({
    id: 'auto-responder',
    sectionName: t('auto_responder.title'),
    hasChanges,
    isSaving,
    onSave: handleSaveForSaveBar,
    onDismiss: resetChanges
  });

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
          {t('auto_responder.title')}
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
            title={t('auto_responder.view_docs')}
          >
            ❓
          </a>
        </h2>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('auto_responder.description')}
        </p>

        <div className="setting-item" style={{ marginTop: '1rem', marginBottom: '1.5rem' }}>
          <label>
            {t('auto_responder.security')}
            <span className="setting-description">
              {t('auto_responder.security_description')}
            </span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            <input
              type="checkbox"
              id="autoResponderSkipIncomplete"
              checked={localSkipIncompleteNodes}
              onChange={(e) => setLocalSkipIncompleteNodes(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
            />
            <label htmlFor="autoResponderSkipIncomplete" style={{ margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>
              {t('auto_responder.skip_incomplete_nodes')}
            </label>
          </div>
          <div style={{ marginTop: '0.5rem', marginLeft: '1.75rem', fontSize: '0.9rem', color: 'var(--ctp-subtext0)' }}>
            {t('auto_responder.skip_incomplete_description')}
          </div>
        </div>

        {/* Pattern Examples Section */}
        <PatternExamples onSelectPattern={setNewTrigger} />

        {/* Script Management Section */}
        <ScriptManagement
          availableScripts={availableScripts}
          selectedScripts={selectedScripts}
          isImporting={isImporting}
          isExporting={isExporting}
          isDeleting={isDeleting}
          onImportClick={() => setShowImportModal(true)}
          onExportClick={() => {
            if (selectedScripts.size === 0 && availableScripts.length === 0) {
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

        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            {t('auto_responder.add_trigger')}
            <span className="setting-description">
              {t('auto_responder.add_trigger_description')}
            </span>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '0.5rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <div style={{ flex: '1', position: 'relative' }}>
            <input
              type="text"
              value={newTrigger}
              onChange={(e) => setNewTrigger(e.target.value)}
                  placeholder={t('auto_responder.trigger_placeholder')}
              disabled={!localEnabled}
              className="setting-input"
                  style={{ 
                    width: '100%',
                    fontFamily: 'monospace',
                    borderColor: newTriggerValidation.valid ? undefined : 'var(--ctp-red)',
                    borderWidth: newTriggerValidation.valid ? undefined : '2px'
                  }}
                  title="Trigger pattern: Use {param} for parameters, separate multiple patterns with commas"
                />
                {newTrigger.trim() && (
                  <div style={{
                    position: 'absolute',
                    right: '0.5rem',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    fontSize: '0.7rem',
                    color: 'var(--ctp-subtext0)',
                    pointerEvents: 'none'
                  }}>
                    {t('auto_responder.pattern_count', { count: splitTriggerPatterns(newTrigger).length })}
                  </div>
                )}
              </div>
            <select
              value={newResponseType}
              onChange={(e) => setNewResponseType(e.target.value as ResponseType)}
              disabled={!localEnabled}
              className="setting-input"
              style={{ width: '120px', minWidth: '120px' }}
                title="Response type: Text (static), HTTP (fetch from URL), or Script (execute from data/scripts/)"
            >
              <option value="text">{t('auto_responder.type_text')}</option>
              <option value="http">{t('auto_responder.type_http')}</option>
              <option value="script">{t('auto_responder.type_script')}</option>
            </select>
            <div style={{ flex: '2' }}>
              {newResponseType === 'text' ? (
                <textarea
                  value={newResponse}
                  onChange={(e) => setNewResponse(e.target.value)}
                  placeholder={t('auto_responder.response_text_placeholder')}
                  disabled={!localEnabled}
                  className="setting-input"
                  style={{ width: '100%', fontFamily: 'monospace', minHeight: '60px', resize: 'vertical' }}
                  rows={3}
                  title="Text response: Use {parameter} to include values extracted from the trigger pattern"
                />
              ) : newResponseType === 'script' ? (
                <select
                  value={newResponse}
                  onChange={(e) => setNewResponse(e.target.value)}
                  disabled={!localEnabled || availableScripts.length === 0}
                  className="setting-input"
                  style={{ width: '100%', minWidth: '200px', fontFamily: 'monospace' }}
                  title="Select a script from data/scripts/ to execute. Scripts receive parameters as environment variables (PARAM_*)."
                >
                  <option value="">
                    {availableScripts.length === 0 ? t('auto_responder.no_scripts_found') : t('auto_responder.select_script')}
                  </option>
                  {availableScripts.map((script) => {
                    const langEmoji = script.language === 'Python' ? '🐍' : script.language === 'JavaScript' ? '📘' : script.language === 'Shell' ? '💻' : '📄';
                    const display = script.name
                      ? `${script.emoji || langEmoji} ${script.name} | ${script.filename} | ${script.language}`
                      : `${langEmoji} ${script.filename}`;
                    return (
                    <option key={script.path} value={script.path}>
                        {display}
                    </option>
                    );
                  })}
                </select>
              ) : (
                <input
                  type="text"
                  value={newResponse}
                  onChange={(e) => setNewResponse(e.target.value)}
                  placeholder="e.g., https://wttr.in/{location}?format=4"
                  disabled={!localEnabled}
                  className="setting-input"
                  style={{ width: '100%', fontFamily: 'monospace' }}
                  title="HTTP URL: Use {parameter} to substitute matched values. The response body will be sent as the message."
                />
              )}
            </div>
            <button
              onClick={addTrigger}
              disabled={!localEnabled || !newTrigger.trim() || !newResponse.trim() || !newTriggerValidation.valid}
              className="btn-primary"
              style={{
                padding: '0.5rem 1rem',
                fontSize: '14px',
                opacity: (localEnabled && newTrigger.trim() && newResponse.trim() && newTriggerValidation.valid) ? 1 : 0.5,
                cursor: (localEnabled && newTrigger.trim() && newResponse.trim() && newTriggerValidation.valid) ? 'pointer' : 'not-allowed'
              }}
            >
              {t('common.add')}
            </button>
            <button
              onClick={() => {
                setNewTrigger('');
                setNewResponse('');
                setNewResponseType('text');
                setNewMultiline(false);
                setNewVerifyResponse(false);
                setNewChannel('dm');
                setNewTriggerTestInput('');
              }}
              disabled={!localEnabled}
              style={{
                padding: '0.5rem 1rem',
                fontSize: '14px',
                background: 'var(--ctp-red)',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                opacity: localEnabled ? 1 : 0.5,
                cursor: localEnabled ? 'pointer' : 'not-allowed'
              }}
              title={t('auto_responder.clear_fields')}
            >
              {t('common.clear')}
            </button>
            </div>
            {!newTriggerValidation.valid && newTriggerValidation.error && (
              <div style={{ 
                fontSize: '0.75rem', 
                color: 'var(--ctp-red)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.25rem',
                marginTop: '0.25rem'
              }}>
                <span>⚠️</span>
                <span>{newTriggerValidation.error}</span>
              </div>
            )}
            {newTriggerValidation.valid && newTrigger.trim() && (() => {
              const patterns = splitTriggerPatterns(newTrigger);
              const allParams = patterns.flatMap(p => extractParameters(p));
              const uniqueParams = Array.from(new Set(allParams.map(p => p.name)));
              
              // Test the trigger against test input if provided
              // Create a temporary trigger to test against
              const testMatch = newTriggerTestInput.trim() ? (() => {
                // Test each pattern individually
                for (const pattern of patterns) {
                  const regexPattern = buildRegexPattern(pattern);
                  const regex = new RegExp(regexPattern, 'i');
                  const match = newTriggerTestInput.trim().match(regex);
                  
                  if (match) {
                    // Extract parameters
                    const params: Record<string, string> = {};
                    const patternParams = extractParameters(pattern);
                    patternParams.forEach((param, idx) => {
                      if (match[idx + 1]) {
                        params[param.name] = match[idx + 1];
                      }
                    });
                    
                    // Get match positions
                    const matchPositions = getMatchPositions(pattern, newTriggerTestInput.trim(), params);
                    
                    return {
                      matchedPattern: pattern,
                      params,
                      matchPositions,
                      regexPattern
                    };
                  }
                }
                return null;
              })() : null;
              
              return (
                <div style={{ marginTop: '0.5rem', padding: '0.75rem', background: 'var(--ctp-surface0)', border: '1px solid var(--ctp-overlay0)', borderRadius: '4px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--ctp-green)', fontWeight: 'bold' }}>✓ {t('auto_responder.valid')}</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--ctp-subtext0)' }}>
                      {t('auto_responder.pattern_count', { count: patterns.length })}
                      {uniqueParams.length > 0 && ` • ${t('auto_responder.parameter_count', { count: uniqueParams.length })}`}
                    </span>
                  </div>
                  
                  {/* Real-time Pattern Preview with Highlighting */}
                  <div style={{ marginTop: '0.75rem', marginBottom: '0.75rem' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem', fontWeight: 'bold' }}>{t('auto_responder.pattern_preview')}</div>
                    <div style={{ 
                      padding: '0.5rem', 
                      background: 'var(--ctp-surface1)', 
                      borderRadius: '4px', 
                      fontFamily: 'monospace', 
                      fontSize: '0.85rem',
                      lineHeight: '1.6',
                      minHeight: '30px',
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center'
                    }}>
                      {patterns.map((pattern, patternIdx) => {
                        const segments: Array<{ text: string; type: 'literal' | 'parameter'; paramName?: string; startPos: number; endPos: number }> = [];

                        // Parse pattern into segments
                        let i = 0;
                        while (i < pattern.length) {
                          if (pattern[i] === '{') {
                            const start = i + 1;
                            let depth = 1;
                            let end = start;
                            while (end < pattern.length && depth > 0) {
                              if (pattern[end] === '{') depth++;
                              else if (pattern[end] === '}') depth--;
                              end++;
                            }
                            const paramMatch = pattern.substring(start, end - 1);
                            const colonPos = paramMatch.indexOf(':');
                            const paramName = colonPos >= 0 ? paramMatch.substring(0, colonPos) : paramMatch;
                            segments.push({ text: pattern.substring(i, end), type: 'parameter', paramName, startPos: i, endPos: end });
                            i = end;
                          } else {
                            const literalStart = i;
                            while (i < pattern.length && pattern[i] !== '{') {
                              i++;
                            }
                            const literalText = pattern.substring(literalStart, i);
                            if (literalText.trim()) {
                              segments.push({ text: literalText, type: 'literal', startPos: literalStart, endPos: i });
                            }
                          }
                        }

                        // Merge adjacent segments (no whitespace between them)
                        const mergedSegments: Array<Array<{ text: string; type: 'literal' | 'parameter'; paramName?: string }>> = [];
                        let currentGroup: Array<{ text: string; type: 'literal' | 'parameter'; paramName?: string }> = [];

                        for (let j = 0; j < segments.length; j++) {
                          currentGroup.push(segments[j]);

                          const isLastSegment = j === segments.length - 1;
                          let nextSegmentIsAdjacent = false;

                          if (!isLastSegment) {
                            const current = segments[j];
                            const next = segments[j + 1];
                            const positionsAdjacent = next.startPos === current.endPos;
                            const currentEndsWithSpace = current.type === 'literal' && current.text.endsWith(' ');
                            const nextStartsWithSpace = next.type === 'literal' && next.text.startsWith(' ');
                            nextSegmentIsAdjacent = positionsAdjacent && !currentEndsWithSpace && !nextStartsWithSpace;
                          }

                          if (!nextSegmentIsAdjacent) {
                            mergedSegments.push(currentGroup);
                            currentGroup = [];
                          }
                        }

                        return (
                          <div key={patternIdx} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.1rem' }}>
                            {mergedSegments.map((group, groupIdx) => {
                              if (group.length === 1) {
                                const segment = group[0];
                                return (
                                  <span
                                    key={groupIdx}
                                    style={{
                                      backgroundColor: segment.type === 'parameter' ? 'rgba(166, 227, 161, 0.4)' : 'rgba(137, 180, 250, 0.4)',
                                      padding: '2px 4px',
                                      borderRadius: '2px',
                                      fontWeight: segment.type === 'parameter' ? 'bold' : 'normal',
                                      color: 'var(--ctp-text)'
                                    }}
                                    title={segment.type === 'parameter' ? `Parameter: ${segment.paramName}` : 'Literal text'}
                                  >
                                    {segment.type === 'literal' ? segment.text.trim() : segment.text}
                                  </span>
                                );
                              } else {
                                return (
                                  <span
                                    key={groupIdx}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      borderRadius: '2px',
                                      overflow: 'hidden',
                                      border: '1px solid rgba(166, 227, 161, 0.5)'
                                    }}
                                    title={group.map(s => s.type === 'parameter' ? `{${s.paramName}}` : s.text).join('')}
                                  >
                                    {group.map((segment, segIdx) => (
                                      <React.Fragment key={segIdx}>
                                        <span
                                          style={{
                                            backgroundColor: segment.type === 'parameter' ? 'rgba(166, 227, 161, 0.4)' : 'rgba(137, 180, 250, 0.4)',
                                            padding: '2px 4px',
                                            fontWeight: segment.type === 'parameter' ? 'bold' : 'normal',
                                            color: 'var(--ctp-text)'
                                          }}
                                        >
                                          {segment.type === 'literal' ? segment.text.trim() : segment.text}
                                        </span>
                                        {segIdx < group.length - 1 && (
                                          <span style={{
                                            width: '1px',
                                            height: '100%',
                                            backgroundColor: 'rgba(205, 214, 244, 0.3)',
                                            margin: '0'
                                          }} />
                                        )}
                                      </React.Fragment>
                                    ))}
                                  </span>
                                );
                              }
                            })}
                            {patternIdx < patterns.length - 1 && (
                              <span style={{ color: 'var(--ctp-subtext0)', margin: '0 0.25rem' }}>,</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: 'var(--ctp-subtext0)', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: 'rgba(137, 180, 250, 0.4)', borderRadius: '2px' }}></span>
                        Literal text
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: 'rgba(166, 227, 161, 0.4)', borderRadius: '2px' }}></span>
                        Parameter
                      </span>
                    </div>
                  </div>
                  
                  {uniqueParams.length > 0 && (
                    <div style={{ marginTop: '0.5rem' }}>
                      <div style={{ fontSize: '0.7rem', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem', fontWeight: 'bold' }}>{t('auto_responder.detected_parameters')}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                        {uniqueParams.map((paramName, idx) => {
                          const param = allParams.find(p => p.name === paramName);
                          return (
                            <span
                              key={idx}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                padding: '0.2rem 0.5rem',
                                background: 'var(--ctp-blue)',
                                color: 'var(--ctp-base)',
                                borderRadius: '3px',
                                fontSize: '0.7rem',
                                fontFamily: 'monospace',
                                fontWeight: 'bold'
                              }}
                              title={param?.pattern ? `Pattern: ${param.pattern}` : 'Default pattern: [^\\s]+'}
                            >
                              {`{${paramName}${param?.pattern ? `:${param.pattern}` : ''}}`}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  
                  {/* Test Section - Merged pattern matching and response testing */}
                  <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--ctp-overlay0)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--ctp-subtext0)', marginBottom: '0.5rem', fontWeight: 'bold' }}>🧪 Test:</div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
                      <input
                        type="text"
                        value={newTriggerTestInput}
                        onChange={(e) => {
                          setNewTriggerTestInput(e.target.value);
                          setNewTriggerLiveTestResult(null);
                        }}
                        placeholder={t('auto_responder.test_message_placeholder')}
                        className="setting-input"
                        style={{ 
                          flex: '1',
                          fontSize: '0.9rem',
                          padding: '0.5rem 0.75rem',
                          fontFamily: 'monospace',
                          borderColor: newTriggerTestInput.trim() ? (testMatch ? 'var(--ctp-green)' : 'var(--ctp-red)') : undefined,
                          borderWidth: newTriggerTestInput.trim() ? '2px' : undefined
                        }}
                        title="Test if a message matches your trigger pattern and execute the response"
                      />
                      {(newResponseType === 'http' || newResponseType === 'script') && testMatch && (
                        <button
                          onClick={async () => {
                            if (!newTriggerTestInput.trim() || !testMatch) return;
                            setNewTriggerLiveTestResult({ loading: true, result: null });
                            try {
                              if (newResponseType === 'http') {
                                let url = newResponse;
                                if (testMatch.params) {
                                  Object.entries(testMatch.params).forEach(([paramName, paramValue]) => {
                                    url = url.replace(new RegExp(`\\{${paramName}\\}`, 'g'), paramValue);
                                  });
                                }
                                const response = await csrfFetch(`${baseUrl}/api/http/test`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ url })
                                });
                                if (!response.ok) {
                                  let errorMessage = `HTTP ${response.status}`;
                                  try {
                                    const errorData = await response.json();
                                    errorMessage = errorData.error || errorMessage;
                                  } catch {
                                    try {
                                      const errorText = await response.text();
                                      errorMessage = errorText || errorMessage;
                                    } catch {
                                      // Use default error message
                                    }
                                  }
                                  throw new Error(errorMessage);
                                }
                                const result = await response.json();
                                setNewTriggerLiveTestResult({ loading: false, result: result.result || '(no output)' });
                              } else if (newResponseType === 'script') {
                                const response = await csrfFetch(`${baseUrl}/api/scripts/test`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                    script: newResponse,
                                    trigger: newTrigger,
                                    testMessage: newTriggerTestInput.trim()
                                  })
                                });
                                if (!response.ok) {
                                  let errorMessage = `HTTP ${response.status}`;
                                  try {
                                    const errorData = await response.json();
                                    errorMessage = errorData.error || errorMessage;
                                  } catch {
                                    try {
                                      const errorText = await response.text();
                                      errorMessage = errorText || errorMessage;
                                    } catch {
                                      // Use default error message
                                    }
                                  }
                                  throw new Error(errorMessage);
                                }
                                const result = await response.json();
                                let output = result.output || '(no output)';
                                if (result.stderr) {
                                  output += `\n\n[stderr]\n${result.stderr}`;
                                }
                                if (result.params && Object.keys(result.params).length > 0) {
                                  output += `\n\n[Parameters: ${JSON.stringify(result.params)}]`;
                                }
                                setNewTriggerLiveTestResult({ loading: false, result: output });
                              }
                            } catch (error: any) {
                              // Handle network errors more gracefully
                              let errorMessage = error.message || error.toString();
                              if (errorMessage.includes('NetworkError') || errorMessage.includes('Failed to fetch')) {
                                errorMessage = 'Network error: Unable to connect. Check your URL or network connection.';
                              }
                              setNewTriggerLiveTestResult({ loading: false, result: null, error: errorMessage });
                            }
                          }}
                          disabled={newTriggerLiveTestResult?.loading || !testMatch || !newResponse.trim()}
                          style={{
                            padding: '0.5rem 1rem',
                            fontSize: '0.875rem',
                            background: (newTriggerLiveTestResult?.loading || !testMatch || !newResponse.trim()) ? 'var(--ctp-surface2)' : 'var(--ctp-blue)',
                            color: (newTriggerLiveTestResult?.loading || !testMatch || !newResponse.trim()) ? 'var(--ctp-subtext0)' : 'var(--ctp-base)',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: (newTriggerLiveTestResult?.loading || !testMatch || !newResponse.trim()) ? 'not-allowed' : 'pointer',
                            fontWeight: 'bold',
                            whiteSpace: 'nowrap'
                          }}
                          title="Test the actual HTTP request or script execution with this message"
                        >
                          {newTriggerLiveTestResult?.loading ? 'Testing...' : '🧪 Test'}
                        </button>
                      )}
                    </div>
                    {newTriggerTestInput.trim() && (
                      <div style={{ marginTop: '0.5rem' }}>
                        {testMatch ? (
                          <div style={{ 
                            padding: '0.75rem', 
                            background: 'rgba(166, 227, 161, 0.1)', 
                            border: '1px solid var(--ctp-green)', 
                            borderRadius: '4px' 
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                              <span style={{ color: 'var(--ctp-green)', fontWeight: 'bold', fontSize: '0.85rem' }}>✓ Match Found!</span>
                              <span style={{ fontSize: '0.7rem', color: 'var(--ctp-subtext0)' }}>
                                Pattern: {testMatch.matchedPattern || formatTriggerPatterns(newTrigger)}
                              </span>
                            </div>
                            
                            {/* Highlighted Message Preview */}
                            {testMatch.matchPositions && testMatch.matchPositions.length > 0 && (
                              <div style={{ marginBottom: '0.5rem' }}>
                                <div style={{ fontSize: '0.7rem', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem', fontWeight: 'bold' }}>Match Highlight:</div>
                                <div style={{ 
                                  padding: '0.5rem', 
                                  background: 'var(--ctp-surface2)', 
                                  borderRadius: '4px', 
                                  fontFamily: 'monospace', 
                                  fontSize: '0.85rem',
                                  lineHeight: '1.6'
                                }}>
                                  {newTriggerTestInput.trim().split('').map((char, pos) => {
                                    const posInfo = testMatch.matchPositions?.find(p => pos >= p.start && pos < p.end);
                                    return (
                                      <span
                                        key={pos}
                                        style={{
                                          backgroundColor: posInfo ? (posInfo.type === 'parameter' ? 'rgba(166, 227, 161, 0.4)' : 'rgba(137, 180, 250, 0.4)') : 'transparent',
                                          padding: '2px',
                                          borderRadius: posInfo ? '2px' : '0',
                                          fontWeight: posInfo?.type === 'parameter' ? 'bold' : 'normal'
                                        }}
                                        title={posInfo ? `${posInfo.type}: ${posInfo.start}-${posInfo.end}` : ''}
                                      >
                                        {char}
                                      </span>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            
                            {testMatch.params && Object.keys(testMatch.params).length > 0 && (
                              <div style={{ marginBottom: '0.5rem' }}>
                                <div style={{ fontSize: '0.7rem', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem', fontWeight: 'bold' }}>{t('auto_responder.extracted_parameters')}</div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                                  {Object.entries(testMatch.params).map(([key, value]) => (
                                    <span
                                      key={key}
                                      style={{
                                        padding: '0.2rem 0.5rem',
                                        background: 'var(--ctp-blue)',
                                        color: 'var(--ctp-base)',
                                        borderRadius: '3px',
                                        fontSize: '0.7rem',
                                        fontFamily: 'monospace',
                                        fontWeight: 'bold'
                                      }}
                                    >
                                      {key}="{value}"
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            
                            {newResponse.trim() && newResponseType === 'text' && (
                              <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--ctp-overlay0)' }}>
                                <div style={{ fontSize: '0.7rem', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span>Response Preview:</span>
                                  <button
                                    onClick={() => setNewResponse('')}
                                    disabled={!localEnabled}
                                    style={{
                                      background: 'var(--ctp-red)',
                                      border: 'none',
                                      borderRadius: '3px',
                                      color: 'white',
                                      cursor: localEnabled ? 'pointer' : 'not-allowed',
                                      padding: '0.15rem 0.4rem',
                                      fontSize: '0.65rem',
                                      fontWeight: 'bold',
                                      opacity: localEnabled ? 1 : 0.5
                                    }}
                                    title="Clear response"
                                  >
                                    Clear
                                  </button>
                                </div>
                                <div style={{
                                  padding: '0.5rem',
                                  background: 'var(--ctp-surface2)',
                                  borderRadius: '4px',
                                  fontFamily: 'monospace',
                                  fontSize: '0.85rem',
                                  color: 'var(--ctp-text)'
                                }}>
                                  {generateSampleResponse({ trigger: newTrigger, responseType: newResponseType, response: newResponse } as AutoResponderTrigger, newTriggerTestInput.trim())}
                                </div>
                              </div>
                            )}
                            
                            {/* Test Results */}
                            {newTriggerLiveTestResult && !newTriggerLiveTestResult.loading && (
                              <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--ctp-overlay0)' }}>
                                <div style={{ fontSize: '0.7rem', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span>Test Result:</span>
                                  <button
                                    onClick={() => setNewTriggerLiveTestResult(null)}
                                    disabled={!localEnabled}
                                    style={{
                                      background: 'var(--ctp-red)',
                                      border: 'none',
                                      borderRadius: '3px',
                                      color: 'white',
                                      cursor: localEnabled ? 'pointer' : 'not-allowed',
                                      padding: '0.15rem 0.4rem',
                                      fontSize: '0.65rem',
                                      fontWeight: 'bold',
                                      opacity: localEnabled ? 1 : 0.5
                                    }}
                                    title="Clear test result"
                                  >
                                    Clear
                                  </button>
                                </div>
                                {newTriggerLiveTestResult.error ? (
                                  <div style={{ 
                                    padding: '0.5rem', 
                                    background: 'rgba(243, 139, 168, 0.1)', 
                                    border: '1px solid var(--ctp-red)', 
                                    borderRadius: '4px',
                                    color: 'var(--ctp-red)',
                                    fontSize: '0.85rem'
                                  }}>
                                    Error: {newTriggerLiveTestResult.error}
                                  </div>
                                ) : newTriggerLiveTestResult.result ? (
                                  <div>
                                    <div style={{ 
                                      padding: '0.5rem', 
                                      background: 'var(--ctp-surface2)', 
                                      borderRadius: '4px', 
                                      fontFamily: 'monospace', 
                                      fontSize: '0.85rem',
                                      color: 'var(--ctp-text)',
                                      whiteSpace: 'pre-wrap',
                                      maxHeight: '200px',
                                      overflowY: 'auto'
                                    }}>
                                      {newTriggerLiveTestResult.result}
                                    </div>
                                    <button
                                      onClick={() => {
                                        if (newTriggerLiveTestResult?.result) {
                                          navigator.clipboard.writeText(newTriggerLiveTestResult.result);
                                          showToast(t('common.copied_to_clipboard'), 'success');
                                        }
                                      }}
                                      style={{
                                        marginTop: '0.25rem',
                                        padding: '0.2rem 0.4rem',
                                        fontSize: '0.7rem',
                                        background: 'var(--ctp-surface2)',
                                        color: 'var(--ctp-text)',
                                        border: '1px solid var(--ctp-overlay0)',
                                        borderRadius: '3px',
                                        cursor: 'pointer'
                                      }}
                                    >
                                      📋 Copy
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div style={{ 
                            padding: '0.75rem', 
                            background: 'rgba(243, 139, 168, 0.1)', 
                            border: '1px solid var(--ctp-red)', 
                            borderRadius: '4px',
                            color: 'var(--ctp-red)',
                            fontSize: '0.85rem'
                          }}>
                            ✗ No match - This message does not match your trigger pattern
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
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
              title="Select which channel or direct messages this trigger should respond to"
            >
              <option value="dm">{t('auto_responder.direct_messages')}</option>
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

        {/* Separator between Add Trigger and Configured Triggers */}
        <div style={{ 
          marginTop: '2rem', 
          marginBottom: '1.5rem',
          height: '1px',
          background: 'linear-gradient(to right, transparent, var(--ctp-overlay0), transparent)',
          position: 'relative'
        }}>
          <div style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'var(--ctp-base)',
            padding: '0 1rem',
            color: 'var(--ctp-subtext0)',
            fontSize: '0.75rem',
            fontWeight: 'bold'
          }}>
            Configured Triggers
          </div>
        </div>

        {localTriggers.length > 0 && (
          <div className="setting-item" style={{ marginTop: '1.5rem' }}>
            <label>
              {t('auto_responder.configured_triggers', { count: localTriggers.length })}
              <span className="setting-description">
                {t('auto_responder.current_triggers_description')}
              </span>
            </label>
            {/* Search and Filter */}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
              <input
                type="text"
                value={triggerSearch}
                onChange={(e) => setTriggerSearch(e.target.value)}
                placeholder={t('auto_responder.search_triggers')}
                className="setting-input"
                style={{ flex: '1', minWidth: '200px', fontFamily: 'monospace', fontSize: '0.9rem' }}
              />
              <select
                value={triggerFilter}
                onChange={(e) => setTriggerFilter(e.target.value as 'all' | 'text' | 'http' | 'script')}
                className="setting-input"
                style={{ width: '120px' }}
              >
                <option value="all">{t('auto_responder.filter_all')}</option>
                <option value="text">{t('auto_responder.type_text')}</option>
                <option value="http">{t('auto_responder.type_http')}</option>
                <option value="script">{t('auto_responder.type_script')}</option>
              </select>
            </div>
            {/* Color Legend */}
            <div style={{ 
              display: 'flex', 
              gap: '1rem', 
              marginBottom: '0.75rem', 
              padding: '0.5rem',
              background: 'var(--ctp-surface0)',
              borderRadius: '4px',
              fontSize: '0.75rem',
              alignItems: 'center',
              flexWrap: 'wrap'
            }}>
              <span style={{ color: 'var(--ctp-subtext0)', fontWeight: 'bold' }}>{t('auto_responder.legend')}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ 
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem'
                }}>
                  <span style={{ 
                    display: 'inline-block',
                    width: '12px', 
                    height: '12px', 
                    backgroundColor: 'rgba(137, 180, 250, 0.3)', 
                    border: '1px solid rgba(137, 180, 250, 0.5)',
                    borderRadius: '2px' 
                  }}></span>
                  <span style={{ color: 'var(--ctp-text)' }}>{t('auto_responder.literal')}</span>
                </span>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem'
                }}>
                  <span style={{
                    display: 'inline-block',
                    width: '12px',
                    height: '12px',
                    backgroundColor: 'rgba(166, 227, 161, 0.3)',
                    border: '1px solid rgba(166, 227, 161, 0.5)',
                    borderRadius: '2px'
                  }}></span>
                  <span style={{ color: 'var(--ctp-text)' }}>{t('auto_responder.parameter')}</span>
                </span>
              </div>
            </div>
            <div style={{ marginTop: '0.5rem' }}>
              {localTriggers
                .filter(trigger => {
                  const triggerStr = Array.isArray(trigger.trigger) ? trigger.trigger.join(', ') : trigger.trigger;
                  const matchesSearch = !triggerSearch.trim() || 
                    triggerStr.toLowerCase().includes(triggerSearch.toLowerCase()) ||
                    trigger.response.toLowerCase().includes(triggerSearch.toLowerCase());
                  const matchesFilter = triggerFilter === 'all' || trigger.responseType === triggerFilter;
                  return matchesSearch && matchesFilter;
                })
                .map((trigger) => (
                <TriggerItem
                  key={trigger.id}
                  trigger={trigger}
                  isEditing={editingId === trigger.id}
                  localEnabled={localEnabled}
                  availableScripts={availableScripts}
                  channels={channels}
                  onStartEdit={() => startEditing(trigger.id)}
                  onCancelEdit={cancelEditing}
                  onSaveEdit={(t, rt, r, m, v, c, sa) => saveEdit(trigger.id, t, rt, r, m, v, c, sa)}
                  onRemove={() => removeTrigger(trigger.id)}
                  showToast={showToast}
                />
              ))}
              {localTriggers.filter(trigger => {
                const triggerStr = Array.isArray(trigger.trigger) ? trigger.trigger.join(', ') : trigger.trigger;
                const matchesSearch = !triggerSearch.trim() || 
                  triggerStr.toLowerCase().includes(triggerSearch.toLowerCase()) ||
                  trigger.response.toLowerCase().includes(triggerSearch.toLowerCase());
                const matchesFilter = triggerFilter === 'all' || trigger.responseType === triggerFilter;
                return matchesSearch && matchesFilter;
              }).length === 0 && (
                <div style={{ 
                  padding: '1rem', 
                  textAlign: 'center', 
                  color: 'var(--ctp-subtext0)', 
                  fontStyle: 'italic',
                  background: 'var(--ctp-surface0)',
                  borderRadius: '4px'
                }}>
                  {t('auto_responder.no_triggers_match')}
                </div>
              )}
            </div>
          </div>
        )}

        {localTriggers.length > 0 && (
          <div className="setting-item" style={{ marginTop: '1.5rem' }}>
            <label htmlFor="testMessages">
              {t('auto_responder.test_pattern_matching')}
              <span className="setting-description">
                {t('auto_responder.test_patterns_description')}
              </span>
            </label>
            {/* Real-time test input */}
            <div style={{ marginTop: '0.5rem', marginBottom: '0.5rem' }}>
              <label style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem', display: 'block' }}>
                {t('auto_responder.quick_test')}
              </label>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
                <input
                  type="text"
                  value={currentTestLine}
                  onChange={(e) => {
                    setCurrentTestLine(e.target.value);
                    setQuickTestResult(null);
                  }}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      const match = testTriggerMatch(currentTestLine.trim());
                      if (match?.trigger && match.trigger.responseType === 'text') {
                        // For text responses, Enter key just triggers the preview (which is already shown)
                        // No additional action needed as preview is live
                      }
                    }
                  }}
                  placeholder="Type a message to test in real-time... (Press Enter for text responses)"
                  className="setting-input"
                  style={{
                    fontFamily: 'monospace',
                    flex: '1',
                    borderColor: currentTestLine.trim() ? (testTriggerMatch(currentTestLine.trim()) ? 'var(--ctp-green)' : 'var(--ctp-red)') : undefined,
                    borderWidth: currentTestLine.trim() ? '2px' : undefined
                  }}
                />
                {(() => {
                  const match = testTriggerMatch(currentTestLine.trim());
                  return match?.trigger && (match.trigger.responseType === 'http' || match.trigger.responseType === 'script') && (
                    <button
                      onClick={async () => {
                        if (!currentTestLine.trim() || !match || !match.trigger) return;
                        setQuickTestResult({ loading: true, result: null });
                        try {
                          if (match.trigger.responseType === 'http') {
                            let url = match.trigger.response;
                            if (match.params) {
                              Object.entries(match.params).forEach(([paramName, paramValue]) => {
                                url = url.replace(new RegExp(`\\{${paramName}\\}`, 'g'), paramValue);
                              });
                            }
                            const response = await csrfFetch(`${baseUrl}/api/http/test`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ url })
                            });
                            if (!response.ok) {
                              let errorMessage = `HTTP ${response.status}`;
                              try {
                                const errorData = await response.json();
                                errorMessage = errorData.error || errorMessage;
                              } catch {
                                try {
                                  const errorText = await response.text();
                                  errorMessage = errorText || errorMessage;
                                } catch {
                                  // Use default error message
                                }
                              }
                              throw new Error(errorMessage);
                            }
                            const result = await response.json();
                            setQuickTestResult({ loading: false, result: result.result || '(no output)' });
                          } else if (match.trigger.responseType === 'script') {
                            const triggerStr = Array.isArray(match.trigger.trigger)
                              ? match.trigger.trigger.join(', ')
                              : match.trigger.trigger;
                            const response = await csrfFetch(`${baseUrl}/api/scripts/test`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                script: match.trigger.response,
                                trigger: triggerStr,
                                testMessage: currentTestLine.trim()
                              })
                            });
                            if (!response.ok) {
                              let errorMessage = `HTTP ${response.status}`;
                              try {
                                const errorData = await response.json();
                                errorMessage = errorData.error || errorMessage;
                              } catch {
                                try {
                                  const errorText = await response.text();
                                  errorMessage = errorText || errorMessage;
                                } catch {
                                  // Use default error message
                                }
                              }
                              throw new Error(errorMessage);
                            }
                            const result = await response.json();
                            let output = result.output || '(no output)';
                            if (result.stderr) {
                              output += `\n\n[stderr]\n${result.stderr}`;
                            }
                            if (result.params && Object.keys(result.params).length > 0) {
                              output += `\n\n[Parameters: ${JSON.stringify(result.params)}]`;
                            }
                            setQuickTestResult({ loading: false, result: output });
                          }
                        } catch (error: any) {
                          let errorMessage = error.message || error.toString();
                          if (errorMessage.includes('NetworkError') || errorMessage.includes('Failed to fetch')) {
                            errorMessage = 'Network error: Unable to connect. Check your URL or network connection.';
                          }
                          setQuickTestResult({ loading: false, result: null, error: errorMessage });
                        }
                      }}
                      className="btn-primary"
                      disabled={quickTestResult?.loading}
                      style={{
                        padding: '0.5rem 1rem',
                        fontSize: '14px',
                        minWidth: '80px',
                        opacity: quickTestResult?.loading ? 0.6 : 1,
                        cursor: quickTestResult?.loading ? 'wait' : 'pointer'
                      }}
                    >
                      {quickTestResult?.loading ? '⏳ Testing...' : '🧪 Test'}
                    </button>
                  );
                })()}
              </div>
              {currentTestLine.trim() && (() => {
                const realtimeMatch = testTriggerMatch(currentTestLine.trim());
                const allMatches = testAllTriggerMatches(currentTestLine.trim());
                return (
                  <div style={{
                    marginTop: '0.5rem',
                    padding: '0.5rem',
                    background: realtimeMatch ? 'rgba(166, 227, 161, 0.1)' : 'rgba(243, 139, 168, 0.1)',
                    border: `1px solid ${realtimeMatch ? 'var(--ctp-green)' : 'var(--ctp-red)'}`,
                    borderRadius: '4px',
                    fontSize: '0.85rem'
                  }}>
                    {realtimeMatch ? (
                      <div>
                        <div style={{ marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <span style={{ color: 'var(--ctp-green)', fontWeight: 'bold' }}>✓ Matches:</span>
                          {(() => {
                            const pattern = realtimeMatch.matchedPattern || '';
                            const segments: Array<{ text: string; type: 'literal' | 'parameter'; paramName?: string; startPos: number; endPos: number }> = [];

                            let i = 0;
                            while (i < pattern.length) {
                              if (pattern[i] === '{') {
                                const start = i + 1;
                                let depth = 1;
                                let end = start;
                                while (end < pattern.length && depth > 0) {
                                  if (pattern[end] === '{') depth++;
                                  else if (pattern[end] === '}') depth--;
                                  end++;
                                }
                                const paramMatch = pattern.substring(start, end - 1);
                                const colonPos = paramMatch.indexOf(':');
                                const paramName = colonPos >= 0 ? paramMatch.substring(0, colonPos) : paramMatch;
                                segments.push({ text: pattern.substring(i, end), type: 'parameter', paramName, startPos: i, endPos: end });
                                i = end;
                              } else {
                                const literalStart = i;
                                while (i < pattern.length && pattern[i] !== '{') {
                                  i++;
                                }
                                const literalText = pattern.substring(literalStart, i);
                                if (literalText.trim()) {
                                  segments.push({ text: literalText, type: 'literal', startPos: literalStart, endPos: i });
                                }
                              }
                            }

                            // Merge adjacent segments
                            const mergedSegments: Array<Array<{ text: string; type: 'literal' | 'parameter'; paramName?: string }>> = [];
                            let currentGroup: Array<{ text: string; type: 'literal' | 'parameter'; paramName?: string }> = [];

                            for (let j = 0; j < segments.length; j++) {
                              currentGroup.push(segments[j]);
                              const isLastSegment = j === segments.length - 1;
                              let nextSegmentIsAdjacent = false;

                              if (!isLastSegment) {
                                const current = segments[j];
                                const next = segments[j + 1];
                                const positionsAdjacent = next.startPos === current.endPos;
                                const currentEndsWithSpace = current.type === 'literal' && current.text.endsWith(' ');
                                const nextStartsWithSpace = next.type === 'literal' && next.text.startsWith(' ');
                                nextSegmentIsAdjacent = positionsAdjacent && !currentEndsWithSpace && !nextStartsWithSpace;
                              }

                              if (!nextSegmentIsAdjacent) {
                                mergedSegments.push(currentGroup);
                                currentGroup = [];
                              }
                            }

                            return mergedSegments.map((group, groupIdx) => {
                              if (group.length === 1) {
                                const segment = group[0];
                                return (
                                  <span
                                    key={groupIdx}
                                    style={{
                                      backgroundColor: segment.type === 'parameter' ? 'rgba(166, 227, 161, 0.3)' : 'rgba(137, 180, 250, 0.2)',
                                      padding: '0.2rem 0.4rem',
                                      borderRadius: '4px',
                                      fontWeight: segment.type === 'parameter' ? 'bold' : 'normal',
                                      color: segment.type === 'parameter' ? 'var(--ctp-green)' : 'var(--ctp-blue)',
                                      fontFamily: 'monospace',
                                      fontSize: '0.85rem',
                                      border: segment.type === 'parameter' ? '1px solid rgba(166, 227, 161, 0.5)' : '1px solid rgba(137, 180, 250, 0.3)'
                                    }}
                                  >
                                    {segment.type === 'literal' ? segment.text.trim() : segment.text}
                                  </span>
                                );
                              } else {
                                return (
                                  <span
                                    key={groupIdx}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      borderRadius: '4px',
                                      overflow: 'hidden',
                                      border: '1px solid rgba(166, 227, 161, 0.5)',
                                      fontFamily: 'monospace',
                                      fontSize: '0.85rem'
                                    }}
                                  >
                                    {group.map((segment, segIdx) => (
                                      <React.Fragment key={segIdx}>
                                        <span
                                          style={{
                                            backgroundColor: segment.type === 'parameter' ? 'rgba(166, 227, 161, 0.3)' : 'rgba(137, 180, 250, 0.2)',
                                            padding: '0.2rem 0.4rem',
                                            fontWeight: segment.type === 'parameter' ? 'bold' : 'normal',
                                            color: segment.type === 'parameter' ? 'var(--ctp-green)' : 'var(--ctp-blue)'
                                          }}
                                        >
                                          {segment.type === 'literal' ? segment.text.trim() : segment.text}
                                        </span>
                                        {segIdx < group.length - 1 && (
                                          <span style={{
                                            width: '1px',
                                            height: '100%',
                                            backgroundColor: 'rgba(205, 214, 244, 0.3)',
                                            margin: '0'
                                          }} />
                                        )}
                                      </React.Fragment>
                                    ))}
                                  </span>
                                );
                              }
                            });
                          })()}
                        </div>
                        {allMatches.length > 1 && (
                          <div style={{ color: 'var(--ctp-peach)', marginTop: '0.25rem', fontSize: '0.75rem' }}>
                            ⚠️ Warning: {allMatches.length} triggers match this message (conflict!)
                          </div>
                        )}

                        {/* Response Preview for text responses */}
                        {realtimeMatch.trigger && realtimeMatch.trigger.responseType === 'text' && (
                          <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--ctp-overlay0)' }}>
                            <div style={{ fontSize: '0.7rem', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span>Response Preview:</span>
                              <button
                                onClick={() => setCurrentTestLine('')}
                                disabled={!localEnabled}
                                style={{
                                  background: 'var(--ctp-red)',
                                  border: 'none',
                                  borderRadius: '3px',
                                  color: 'white',
                                  cursor: localEnabled ? 'pointer' : 'not-allowed',
                                  padding: '0.15rem 0.4rem',
                                  fontSize: '0.65rem',
                                  fontWeight: 'bold',
                                  opacity: localEnabled ? 1 : 0.5
                                }}
                                title="Clear test input"
                              >
                                Clear
                              </button>
                            </div>
                            <div style={{
                              padding: '0.5rem',
                              background: 'var(--ctp-surface2)',
                              borderRadius: '4px',
                              fontFamily: 'monospace',
                              fontSize: '0.85rem',
                              color: 'var(--ctp-text)',
                              whiteSpace: realtimeMatch.trigger.multiline ? 'pre-wrap' : 'nowrap',
                              overflowX: 'auto'
                            }}>
                              {generateSampleResponse(realtimeMatch.trigger, currentTestLine.trim())}
                            </div>
                          </div>
                        )}

                        {/* Test Results for HTTP/script */}
                        {quickTestResult && !quickTestResult.loading && (
                          <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--ctp-overlay0)' }}>
                            <div style={{ fontSize: '0.7rem', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span>Test Result:</span>
                              <button
                                onClick={() => setQuickTestResult(null)}
                                disabled={!localEnabled}
                                style={{
                                  background: 'var(--ctp-red)',
                                  border: 'none',
                                  borderRadius: '3px',
                                  color: 'white',
                                  cursor: localEnabled ? 'pointer' : 'not-allowed',
                                  padding: '0.15rem 0.4rem',
                                  fontSize: '0.65rem',
                                  fontWeight: 'bold',
                                  opacity: localEnabled ? 1 : 0.5
                                }}
                                title="Clear test result"
                              >
                                Clear
                              </button>
                            </div>
                            {quickTestResult.error ? (
                              <div style={{
                                padding: '0.5rem',
                                background: 'rgba(243, 139, 168, 0.1)',
                                border: '1px solid var(--ctp-red)',
                                borderRadius: '4px',
                                color: 'var(--ctp-red)',
                                fontSize: '0.85rem'
                              }}>
                                Error: {quickTestResult.error}
                              </div>
                            ) : quickTestResult.result ? (
                              <div>
                                <div style={{
                                  padding: '0.5rem',
                                  background: 'var(--ctp-surface2)',
                                  borderRadius: '4px',
                                  fontFamily: 'monospace',
                                  fontSize: '0.85rem',
                                  color: 'var(--ctp-text)',
                                  whiteSpace: 'pre-wrap',
                                  maxHeight: '200px',
                                  overflowY: 'auto'
                                }}>
                                  {quickTestResult.result}
                                </div>
                                <button
                                  onClick={() => {
                                    if (quickTestResult?.result) {
                                      navigator.clipboard.writeText(quickTestResult.result);
                                      showToast(t('common.copied_to_clipboard'), 'success');
                                    }
                                  }}
                                  className="btn-secondary"
                                  style={{
                                    padding: '0.25rem 0.5rem',
                                    fontSize: '0.75rem',
                                    marginTop: '0.25rem'
                                  }}
                                >
                                  📋 Copy
                                </button>
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ color: 'var(--ctp-red)' }}>✗ No matching trigger</div>
                    )}
                  </div>
                );
              })()}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '0.5rem' }}>
              <div>
                <textarea
                  id="testMessages"
                  value={testMessages}
                  onChange={(e) => setTestMessages(e.target.value)}
                  placeholder="Enter test messages, one per line..."
                  disabled={!localEnabled}
                  className="setting-input"
                  rows={8}
                  style={{
                    fontFamily: 'monospace',
                    resize: 'vertical',
                    minHeight: '200px',
                    width: '100%'
                  }}
                />
              </div>
              <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
                {testMessages.split('\n').filter(line => line.trim()).map((message, index) => {
                  const match = testTriggerMatch(message);
                  const allMatches = testAllTriggerMatches(message);
                  const hasConflict = allMatches.length > 1;
                  const showDetails = showMatchDetails[index] || false;
                  const showDebug = showDebugInfo[index] || false;
                  
                  return (
                    <div
                      key={index}
                      style={{
                        padding: '0.5rem',
                        marginBottom: '0.5rem',
                        backgroundColor: match ? 'rgba(166, 227, 161, 0.1)' : 'rgba(243, 139, 168, 0.1)',
                        border: `1px solid ${match ? (hasConflict ? 'var(--ctp-peach)' : 'var(--ctp-green)') : 'var(--ctp-red)'}`,
                        borderRadius: '4px',
                        fontFamily: 'monospace',
                        fontSize: '0.85rem',
                        lineHeight: '1.4'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.25rem', flexWrap: 'wrap', gap: '0.25rem' }}>
                        <span
                          style={{
                            display: 'inline-block',
                            width: '12px',
                            height: '12px',
                            borderRadius: '50%',
                            backgroundColor: match ? (hasConflict ? 'var(--ctp-peach)' : 'var(--ctp-green)') : 'var(--ctp-red)',
                            marginRight: '0.5rem',
                            flexShrink: 0
                          }}
                        />
                        <span style={{ color: 'var(--ctp-text)', fontWeight: 'bold', wordBreak: 'break-word', flex: '1' }}>
                          {message}
                        </span>
                        {match && (
                          <button
                            onClick={() => setShowMatchDetails({ ...showMatchDetails, [index]: !showDetails })}
                            style={{
                              fontSize: '0.7rem',
                              padding: '0.2rem 0.4rem',
                              background: 'var(--ctp-surface1)',
                              border: '1px solid var(--ctp-overlay0)',
                              borderRadius: '3px',
                              cursor: 'pointer',
                              color: 'var(--ctp-text)'
                            }}
                          >
                            {showDetails ? '▼' : '▶'} Details
                          </button>
                        )}
                        {match && (
                          <button
                            onClick={() => setShowDebugInfo({ ...showDebugInfo, [index]: !showDebug })}
                            style={{
                              fontSize: '0.7rem',
                              padding: '0.2rem 0.4rem',
                              background: 'var(--ctp-surface1)',
                              border: '1px solid var(--ctp-overlay0)',
                              borderRadius: '3px',
                              cursor: 'pointer',
                              color: 'var(--ctp-text)'
                            }}
                          >
                            {showDebug ? '▼' : '▶'} Debug
                          </button>
                        )}
                      </div>
                      {hasConflict && (
                        <div style={{ 
                          marginLeft: '1.25rem', 
                          marginBottom: '0.25rem',
                          padding: '0.25rem',
                          background: 'rgba(250, 179, 135, 0.2)',
                          borderRadius: '3px',
                          fontSize: '0.75rem',
                          color: 'var(--ctp-peach)'
                        }}>
                          ⚠️ Conflict: {allMatches.length} triggers match this message
                        </div>
                      )}
                      {match ? (
                        <div style={{ marginLeft: '1.25rem', fontSize: '0.8rem' }}>
                          <div style={{ color: 'var(--ctp-blue)', marginBottom: '0.15rem' }}>
                            ▸ {match.matchedPattern ? match.matchedPattern : formatTriggerPatterns(match.trigger?.trigger || (Array.isArray(match.trigger?.trigger) ? match.trigger.trigger : ''))}
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
                          <div style={{ color: 'var(--ctp-subtext1)', marginBottom: '0.15rem' }}>
                            💬 {generateSampleResponse(match.trigger!, message)}
                          </div>
                          {(match.trigger?.responseType === 'http' || match.trigger?.responseType === 'script') && (
                            <div style={{ marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                              <button
                                onClick={async () => {
                                  setLiveTestResults({ ...liveTestResults, [index]: { loading: true, result: null } });
                                  try {
                                    if (match.trigger?.responseType === 'http') {
                                      let url = match.trigger.response;
                                      if (match.params) {
                                        Object.entries(match.params).forEach(([paramName, paramValue]) => {
                                          url = url.replace(new RegExp(`\\{${paramName}\\}`, 'g'), paramValue);
                                        });
                                      }
                                      const response = await csrfFetch(`${baseUrl}/api/http/test`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ url })
                                      });
                                      if (!response.ok) {
                                        let errorMessage = `HTTP ${response.status}`;
                                        try {
                                          const errorData = await response.json();
                                          errorMessage = errorData.error || errorMessage;
                                        } catch {
                                          try {
                                            const errorText = await response.text();
                                            errorMessage = errorText || errorMessage;
                                          } catch {
                                            // Use default error message
                                          }
                                        }
                                        throw new Error(errorMessage);
                                      }
                                      const result = await response.json();
                                      setLiveTestResults({ ...liveTestResults, [index]: { loading: false, result: result.result || '(no output)' } });
                                    } else if (match.trigger?.responseType === 'script') {
                                      const response = await csrfFetch(`${baseUrl}/api/scripts/test`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                          script: match.trigger.response,
                                          trigger: Array.isArray(match.trigger.trigger) ? match.trigger.trigger.join(', ') : match.trigger.trigger,
                                          testMessage: message
                                        })
                                      });
                                      if (!response.ok) {
                                        const errorData = await response.json();
                                        throw new Error(errorData.error || `HTTP ${response.status}`);
                                      }
                                      const result = await response.json();
                                      let output = result.output || '(no output)';
                                      if (result.stderr) {
                                        output += `\n\n[stderr]\n${result.stderr}`;
                                      }
                                      if (result.params && Object.keys(result.params).length > 0) {
                                        output += `\n\n[Parameters: ${JSON.stringify(result.params)}]`;
                                      }
                                      setLiveTestResults({ ...liveTestResults, [index]: { loading: false, result: output } });
                                    }
                                  } catch (error: any) {
                                    setLiveTestResults({ ...liveTestResults, [index]: { loading: false, result: null, error: error.message || error.toString() } });
                                  }
                                }}
                                disabled={liveTestResults[index]?.loading}
                                style={{
                                  padding: '0.25rem 0.5rem',
                                  fontSize: '0.7rem',
                                  background: liveTestResults[index]?.loading ? 'var(--ctp-surface2)' : 'var(--ctp-blue)',
                                  color: liveTestResults[index]?.loading ? 'var(--ctp-subtext0)' : 'var(--ctp-base)',
                                  border: 'none',
                                  borderRadius: '3px',
                                  cursor: liveTestResults[index]?.loading ? 'not-allowed' : 'pointer',
                                  fontWeight: 'bold'
                                }}
                              >
                                {liveTestResults[index]?.loading ? 'Testing...' : '🧪 Test'}
                              </button>
                              {liveTestResults[index] && !liveTestResults[index].loading && (
                                <div style={{ marginTop: '0.5rem', padding: '0.5rem', background: 'var(--ctp-surface1)', borderRadius: '4px', fontSize: '0.75rem' }}>
                                  {liveTestResults[index].error ? (
                                    <div style={{ color: 'var(--ctp-red)' }}>Error: {liveTestResults[index].error}</div>
                                  ) : liveTestResults[index].result ? (
                                    <div>
                                      <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>Live Test Result:</div>
                                      <div style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: '200px', overflowY: 'auto' }}>
                                        {liveTestResults[index].result}
                                      </div>
                                      <button
                                        onClick={() => {
                                          if (liveTestResults[index]?.result) {
                                            navigator.clipboard.writeText(liveTestResults[index].result!);
                                            showToast(t('common.copied_to_clipboard'), 'success');
                                          }
                                        }}
                                        style={{
                                          marginTop: '0.25rem',
                                          padding: '0.2rem 0.4rem',
                                          fontSize: '0.7rem',
                                          background: 'var(--ctp-surface2)',
                                          color: 'var(--ctp-text)',
                                          border: '1px solid var(--ctp-overlay0)',
                                          borderRadius: '3px',
                                          cursor: 'pointer'
                                        }}
                                      >
                                        📋 Copy
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              )}
                            </div>
                          )}
                          {showDetails && (
                            <div style={{ 
                              marginTop: '0.5rem', 
                              padding: '0.5rem', 
                              background: 'var(--ctp-surface1)', 
                              borderRadius: '4px',
                              fontSize: '0.75rem'
                            }}>
                              <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>Match Details:</div>
                              <div style={{ marginBottom: '0.15rem' }}>
                                <strong>Trigger ID:</strong> {match.trigger?.id}
                              </div>
                              <div style={{ marginBottom: '0.15rem' }}>
                                <strong>Channel:</strong> {match.trigger?.channel === 'dm' ? 'DM' : `Channel ${match.trigger?.channel}`}
                              </div>
                              {match.trigger?.multiline && (
                                <div style={{ marginBottom: '0.15rem' }}>
                                  <strong>Multiline:</strong> Enabled
                                </div>
                              )}
                              {match.trigger?.verifyResponse && (
                                <div style={{ marginBottom: '0.15rem' }}>
                                  <strong>Verify Response:</strong> Enabled (3 retries)
                                </div>
                              )}
                              {hasConflict && (
                                <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--ctp-overlay0)' }}>
                                  <div style={{ fontWeight: 'bold', marginBottom: '0.25rem', color: 'var(--ctp-peach)' }}>
                                    All Matching Triggers ({allMatches.length}):
                                  </div>
                                  {allMatches.map((m, idx) => (
                                    <div key={idx} style={{ marginBottom: '0.25rem', paddingLeft: '0.5rem', borderLeft: '2px solid var(--ctp-peach)' }}>
                                      {m.matchedPattern} ({m.trigger.responseType})
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {showDebug && match.regexPattern && (
                            <div style={{ 
                              marginTop: '0.5rem', 
                              padding: '0.5rem', 
                              background: 'var(--ctp-surface1)', 
                              borderRadius: '4px',
                              fontSize: '0.75rem',
                              fontFamily: 'monospace'
                            }}>
                              <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>Debug Info:</div>
                              <div style={{ marginBottom: '0.15rem' }}>
                                <strong>Regex Pattern:</strong> <code style={{ background: 'var(--ctp-surface2)', padding: '2px 4px', borderRadius: '2px' }}>{match.regexPattern}</code>
                              </div>
                              {match.matchPositions && match.matchPositions.length > 0 && (
                                <div style={{ marginTop: '0.25rem' }}>
                                  <strong>Match Positions (Highlighted):</strong>
                                  <div style={{ marginTop: '0.25rem', padding: '0.5rem', background: 'var(--ctp-surface2)', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.85rem', lineHeight: '1.6' }}>
                                    {message.split('').map((char, pos) => {
                                      const posInfo = match.matchPositions?.find(p => pos >= p.start && pos < p.end);
                                      return (
                                        <span
                                          key={pos}
                                          style={{
                                            backgroundColor: posInfo ? (posInfo.type === 'parameter' ? 'rgba(166, 227, 161, 0.4)' : 'rgba(137, 180, 250, 0.4)') : 'transparent',
                                            padding: '2px',
                                            borderRadius: posInfo ? '2px' : '0',
                                            fontWeight: posInfo?.type === 'parameter' ? 'bold' : 'normal'
                                          }}
                                          title={posInfo ? `${posInfo.type}: ${posInfo.start}-${posInfo.end}` : ''}
                                        >
                                          {char}
                                        </span>
                                      );
                                    })}
                                  </div>
                                  <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: 'var(--ctp-subtext0)', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                                      <span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: 'rgba(137, 180, 250, 0.4)', borderRadius: '2px' }}></span>
                                      Literal text
                                    </span>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                                      <span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: 'rgba(166, 227, 161, 0.4)', borderRadius: '2px' }}></span>
                                      Parameter match
                                    </span>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={{ marginLeft: '1.25rem', fontSize: '0.8rem', color: 'var(--ctp-subtext0)', fontStyle: 'italic' }}>
                          ✗ No matching trigger
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
            {t('auto_responder.no_triggers_configured')}
          </div>
        )}

        {/* Import Modal */}
        {showImportModal && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000
          }}>
            <div style={{
              background: 'var(--ctp-base)',
              padding: '1.5rem',
              borderRadius: '8px',
              maxWidth: '500px',
              width: '90%',
              border: '1px solid var(--ctp-overlay0)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, color: 'var(--ctp-text)' }}>{t('auto_responder.import_script')}</h3>
                <button
                  onClick={() => setShowImportModal(false)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    fontSize: '1.5rem',
                    color: 'var(--ctp-subtext0)',
                    cursor: 'pointer',
                    padding: '0',
                    lineHeight: '1'
                  }}
                >
                  ×
                </button>
              </div>
              <p style={{ color: 'var(--ctp-subtext0)', fontSize: '0.875rem', marginBottom: '1rem' }}>
                Select a script file (.js, .mjs, .py, or .sh) to import into /data/scripts/
              </p>
              <input
                type="file"
                accept=".js,.mjs,.py,.sh"
                id="script-import-input"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  const filenameDisplay = document.getElementById('script-import-filename');
                  if (file) {
                    if (filenameDisplay) {
                      filenameDisplay.textContent = `Selected: ${file.name}`;
                      filenameDisplay.style.color = 'var(--ctp-green)';
                    }
                    handleImportScript(file);
                  } else {
                    if (filenameDisplay) {
                      filenameDisplay.textContent = 'No file selected';
                      filenameDisplay.style.color = 'var(--ctp-subtext0)';
                    }
                  }
                }}
                style={{ display: 'none' }}
              />
              <label
                htmlFor="script-import-input"
                style={{
                  display: 'block',
                  padding: '0.75rem 1rem',
                  background: 'var(--ctp-blue)',
                  color: 'var(--ctp-base)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  textAlign: 'center',
                  fontSize: '0.9rem',
                  marginBottom: '1rem',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--ctp-sky)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--ctp-blue)';
                }}
              >
                📁 Choose File...
              </label>
              <div id="script-import-filename" style={{ 
                color: 'var(--ctp-subtext0)', 
                fontSize: '0.85rem', 
                fontStyle: 'italic',
                marginBottom: '1rem',
                minHeight: '1.2rem'
              }}>
                No file selected
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => {
                    setShowImportModal(false);
                    const input = document.getElementById('script-import-input') as HTMLInputElement;
                    const filenameDisplay = document.getElementById('script-import-filename');
                    if (input) input.value = '';
                    if (filenameDisplay) {
                      filenameDisplay.textContent = 'No file selected';
                      filenameDisplay.style.color = 'var(--ctp-subtext0)';
                    }
                  }}
                  style={{
                    padding: '0.5rem 1rem',
                    background: 'var(--ctp-surface1)',
                    color: 'var(--ctp-text)',
                    border: '1px solid var(--ctp-overlay0)',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Export Modal */}
        {showExportModal && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000
          }}>
            <div style={{
              background: 'var(--ctp-base)',
              padding: '1.5rem',
              borderRadius: '8px',
              maxWidth: '500px',
              width: '90%',
              border: '1px solid var(--ctp-overlay0)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, color: 'var(--ctp-text)' }}>{t('auto_responder.export_scripts')}</h3>
                <button
                  onClick={() => setShowExportModal(false)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    fontSize: '1.5rem',
                    color: 'var(--ctp-subtext0)',
                    cursor: 'pointer',
                    padding: '0',
                    lineHeight: '1'
                  }}
                >
                  ×
                </button>
              </div>
              <p style={{ color: 'var(--ctp-subtext0)', fontSize: '0.875rem', marginBottom: '1rem' }}>
                {selectedScripts.size > 0
                  ? `Export ${selectedScripts.size} selected script(s) as a zip file?`
                  : `Export all ${availableScripts.length} script(s) as a zip file?`}
              </p>
              {selectedScripts.size > 0 && (
                <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'var(--ctp-surface0)', borderRadius: '4px', maxHeight: '200px', overflowY: 'auto' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)', marginBottom: '0.5rem', fontWeight: 'bold' }}>Selected Scripts:</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    {Array.from(selectedScripts).map((script) => {
                      const filename = script.replace('/data/scripts/', '');
                      return (
                        <div key={script} style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--ctp-text)' }}>
                          {getFileIcon(filename)} {filename}
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
                    background: 'var(--ctp-surface1)',
                    color: 'var(--ctp-text)',
                    border: '1px solid var(--ctp-overlay0)',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleExportScripts}
                  disabled={isExporting}
                  style={{
                    padding: '0.5rem 1rem',
                    background: isExporting ? 'var(--ctp-surface2)' : 'var(--ctp-green)',
                    color: isExporting ? 'var(--ctp-subtext0)' : 'var(--ctp-base)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: isExporting ? 'not-allowed' : 'pointer',
                    fontWeight: 'bold'
                  }}
                >
                  {isExporting ? 'Exporting...' : '📥 Download ZIP'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Delete Modal */}
        {showDeleteModal && scriptToDelete && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000
          }}>
            <div style={{
              background: 'var(--ctp-base)',
              padding: '1.5rem',
              borderRadius: '8px',
              maxWidth: '500px',
              width: '90%',
              border: '1px solid var(--ctp-overlay0)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, color: 'var(--ctp-text)' }}>{t('auto_responder.delete_script')}</h3>
                <button
                  onClick={() => {
                    setShowDeleteModal(false);
                    setScriptToDelete(null);
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    fontSize: '1.5rem',
                    color: 'var(--ctp-subtext0)',
                    cursor: 'pointer',
                    padding: '0',
                    lineHeight: '1'
                  }}
                >
                  ×
                </button>
              </div>
              <p style={{ color: 'var(--ctp-subtext0)', fontSize: '0.875rem', marginBottom: '1rem' }}>
                Are you sure you want to delete <strong style={{ color: 'var(--ctp-text)' }}>{scriptToDelete}</strong>? This action cannot be undone.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => {
                    setShowDeleteModal(false);
                    setScriptToDelete(null);
                  }}
                  style={{
                    padding: '0.5rem 1rem',
                    background: 'var(--ctp-surface1)',
                    color: 'var(--ctp-text)',
                    border: '1px solid var(--ctp-overlay0)',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDeleteScript(scriptToDelete)}
                  disabled={isDeleting === scriptToDelete}
                  style={{
                    padding: '0.5rem 1rem',
                    background: isDeleting === scriptToDelete ? 'var(--ctp-surface2)' : 'var(--ctp-red)',
                    color: isDeleting === scriptToDelete ? 'var(--ctp-subtext0)' : 'var(--ctp-base)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: isDeleting === scriptToDelete ? 'not-allowed' : 'pointer',
                    fontWeight: 'bold'
                  }}
                >
                  {isDeleting === scriptToDelete ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default AutoResponderSection;
