import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { TriggerItemProps, ResponseType, ScriptMetadata } from './types';
import { splitTriggerPatterns, formatTriggerPatterns } from './utils';
import { normalizeTriggerChannels } from '../../utils/autoResponderUtils';
import ScriptTestModal from '../ScriptTestModal';

/**
 * Format script for dropdown display
 */
const formatScriptDisplay = (script: ScriptMetadata): string => {
  const langEmoji = script.language === 'Python' ? '🐍' : script.language === 'JavaScript' ? '📘' : script.language === 'Shell' ? '💻' : '📄';
  if (script.name) {
    const emoji = script.emoji || langEmoji;
    return `${emoji} ${script.name} | ${script.filename} | ${script.language}`;
  }
  return `${langEmoji} ${script.filename}`;
};

const TriggerItem: React.FC<TriggerItemProps> = ({
  trigger,
  isEditing,
  localEnabled,
  availableScripts,
  channels,
  baseUrl,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRemove,
  showToast,
}) => {
  const { t } = useTranslation();
  const [showRemoveModal, setShowRemoveModal] = useState(false);
  const [showTestModal, setShowTestModal] = useState(false);
  // Format trigger for editing (convert array to comma-separated string)
  const formatTriggerForEdit = (trigger: string | string[]): string => {
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
  const [editChannels, setEditChannels] = useState<Array<number | 'dm' | 'none'>>(normalizeTriggerChannels(trigger));
  const [editScriptArgs, setEditScriptArgs] = useState(trigger.scriptArgs || '');
  const [triggerValidation, setTriggerValidation] = useState<{ valid: boolean; error?: string }>({ valid: true });

  // Validate trigger in realtime
  const validateTriggerInput = (triggerStr: string | string[]): { valid: boolean; error?: string } => {
    // Handle array format
    if (Array.isArray(triggerStr)) {
      // Validate each pattern in the array
      for (const pattern of triggerStr) {
        if (typeof pattern !== 'string' || !pattern.trim()) {
          continue; // Skip empty patterns
        }
        const validation = validateTriggerInput(pattern);
        if (!validation.valid) {
          return validation;
        }
      }
      return { valid: true };
    }
    
    // Handle string format
    if (!triggerStr || typeof triggerStr !== 'string' || !triggerStr.trim()) {
      return { valid: true }; // Allow empty during typing
    }
    
    const patterns = splitTriggerPatterns(triggerStr);
    
    if (patterns.length === 0) {
      return { valid: false, error: 'Trigger cannot be empty' };
    }
    
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

  // Reset local edit state when editing mode changes
  useEffect(() => {
    if (isEditing) {
      setEditTrigger(formatTriggerForEdit(trigger.trigger));
      setEditResponseType(trigger.responseType);
      setEditResponse(trigger.response);
      setEditMultiline(trigger.multiline || false);
      setEditVerifyResponse(trigger.verifyResponse || false);
      setEditChannels(normalizeTriggerChannels(trigger));
      setEditScriptArgs(trigger.scriptArgs || '');
      setTriggerValidation({ valid: true });
    }
  }, [isEditing, trigger.trigger, trigger.responseType, trigger.response, trigger.multiline, trigger.verifyResponse, trigger.channels, trigger.channel, trigger.scriptArgs]);

  // Validate trigger on change
  useEffect(() => {
    if (isEditing) {
      const validation = validateTriggerInput(editTrigger);
      setTriggerValidation(validation);
    }
  }, [editTrigger, isEditing]);

  const handleSave = () => {
    if (editChannels.length === 0) {
      showToast?.('Please select at least one channel for this trigger', 'error');
      return;
    }
    // Automatically disable verifyResponse when channel is not DM
    const finalVerifyResponse = editChannels.includes('dm') ? editVerifyResponse : false;
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
    // Only pass scriptArgs if responseType is script and args are not empty
    const scriptArgsToSave = editResponseType === 'script' && editScriptArgs.trim() ? editScriptArgs.trim() : undefined;
    onSaveEdit(normalizedTrigger, editResponseType, editResponse, editMultiline, finalVerifyResponse, editChannels, scriptArgsToSave);
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: '1' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>Trigger:</label>
                <input
                  type="text"
                  value={editTrigger}
                  onChange={(e) => setEditTrigger(e.target.value)}
                  className="setting-input"
                  style={{ 
                    flex: '1', 
                    fontFamily: 'monospace',
                    borderColor: triggerValidation.valid ? undefined : 'var(--ctp-red)',
                    borderWidth: triggerValidation.valid ? undefined : '2px'
                  }}
                  placeholder="e.g., weather, weather {location}, w {location}"
                />
              </div>
              {!triggerValidation.valid && triggerValidation.error && (
                <div style={{ 
                  marginLeft: '88px', 
                  fontSize: '0.75rem', 
                  color: 'var(--ctp-red)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem'
                }}>
                  <span>⚠️</span>
                  <span>{triggerValidation.error}</span>
                </div>
              )}
              {triggerValidation.valid && editTrigger.trim() && (
                <div style={{ 
                  marginLeft: '88px', 
                  fontSize: '0.75rem', 
                  color: 'var(--ctp-green)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem'
                }}>
                  <span>✓</span>
                  <span>Valid trigger pattern{splitTriggerPatterns(editTrigger).length > 1 ? 's' : ''}</span>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>Type:</label>
              <select
                value={editResponseType}
                onChange={(e) => setEditResponseType(e.target.value as ResponseType)}
                className="setting-input"
                style={{ width: '120px', minWidth: '120px' }}
              >
                <option value="text">Text Response</option>
                <option value="http">HTTP Request</option>
                <option value="script">Script Execution</option>
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
              <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold', paddingTop: '0.5rem' }}>Response:</label>
              <div style={{ flex: '1' }}>
                {editResponseType === 'text' ? (
                  <textarea
                    value={editResponse}
                    onChange={(e) => setEditResponse(e.target.value)}
                    className="setting-input"
                    style={{ width: '100%', fontFamily: 'monospace', minHeight: '60px', resize: 'vertical' }}
                    rows={3}
                  />
                ) : editResponseType === 'script' ? (
                  <select
                    value={editResponse}
                    onChange={(e) => setEditResponse(e.target.value)}
                    className="setting-input"
                    style={{
                      width: '100%',
                      minWidth: '200px',
                      fontFamily: 'monospace',
                      backgroundImage: 'none',
                      paddingLeft: '2.5rem'
                    }}
                  >
                    <option value="">
                      {availableScripts.length === 0 ? 'No scripts found in /data/scripts/' : 'Select a script...'}
                    </option>
                    {availableScripts.map((script) => (
                      <option key={script.path} value={script.path}>
                        {formatScriptDisplay(script)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={editResponse}
                    onChange={(e) => setEditResponse(e.target.value)}
                    className="setting-input"
                    style={{ width: '100%', fontFamily: 'monospace' }}
                  />
                )}
              </div>
            </div>
            {editResponseType === 'script' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>{t('auto_responder.script_args', 'Arguments:')}</label>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <input
                    type="text"
                    value={editScriptArgs}
                    onChange={(e) => setEditScriptArgs(e.target.value)}
                    className="setting-input"
                    style={{ width: '100%', fontFamily: 'monospace' }}
                    placeholder="--ip {IP} --dest {NODE_ID} --flag"
                  />
                  <span style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)' }}>
                    {t('auto_responder.script_args_help', 'Optional CLI arguments. Tokens: {NODE_ID}, {IP}, {VERSION}, etc.')}
                  </span>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
              <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>Channels:</label>
              <div className="channel-checkbox-list" style={{ flex: 1 }}>
                {editResponseType === 'script' && (
                  <div className="channel-checkbox-row">
                    <input
                      type="checkbox"
                      id={`edit-channel-none-${trigger.id}`}
                      checked={editChannels.includes('none')}
                      onChange={(e) => {
                        if (e.target.checked) {
                          // 'none' is mutually exclusive — clear all other selections
                          setEditChannels(['none']);
                        } else {
                          // When unchecking 'none', default back to DM
                          setEditChannels(['dm']);
                        }
                      }}
                    />
                    <label htmlFor={`edit-channel-none-${trigger.id}`} style={{ color: 'var(--ctp-subtext0)' }}>
                      {t('auto_responder.channel_none', 'None (no mesh output)')}
                    </label>
                  </div>
                )}
                <div className="channel-checkbox-row">
                  <input
                    type="checkbox"
                    id={`edit-channel-dm-${trigger.id}`}
                    checked={editChannels.includes('dm')}
                    disabled={editChannels.includes('none')}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setEditChannels([...editChannels.filter(ch => ch !== 'none'), 'dm']);
                      } else {
                        setEditChannels(editChannels.filter(ch => ch !== 'dm'));
                        setEditVerifyResponse(false);
                      }
                    }}
                  />
                  <label htmlFor={`edit-channel-dm-${trigger.id}`} className="dm-channel">
                    Direct Messages
                  </label>
                </div>
                {channels.map((channel) => (
                  <div key={channel.id} className="channel-checkbox-row">
                    <input
                      type="checkbox"
                      id={`edit-channel-${channel.id}-${trigger.id}`}
                      checked={editChannels.includes(channel.id)}
                      disabled={editChannels.includes('none')}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setEditChannels([...editChannels.filter(ch => ch !== 'none'), channel.id]);
                        } else {
                          setEditChannels(editChannels.filter(ch => ch !== channel.id));
                        }
                      }}
                    />
                    <label
                      htmlFor={`edit-channel-${channel.id}-${trigger.id}`}
                      className={channel.id === 0 ? 'primary-channel' : undefined}
                    >
                      Channel {channel.id}: {channel.name}
                    </label>
                  </div>
                ))}
              </div>
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
            {/* Response Preview */}
            {editResponse.trim() && editTrigger.trim() && editResponseType !== 'script' && (() => {
              // Simple preview function for TriggerItem
              const getPreview = () => {
                let preview = editResponse;
                // Extract parameters from trigger
                const paramMatches = editTrigger.match(/\{([^}:]+)(?::[^}]+)?\}/g) || [];
                paramMatches.forEach((match) => {
                  const paramName = match.replace(/[{}]/g, '').split(':')[0];
                  preview = preview.replace(new RegExp(`\\{${paramName}\\}`, 'g'), 'example');
                });
                return preview;
              };
              
              return (
                <div style={{ marginTop: '0.5rem', padding: '0.5rem', background: 'var(--ctp-surface1)', borderRadius: '4px' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>Response Preview:</span>
                    <button
                      onClick={() => setEditResponse('')}
                      style={{
                        background: 'var(--ctp-red)',
                        border: 'none',
                        borderRadius: '3px',
                        color: 'white',
                        cursor: 'pointer',
                        padding: '0.15rem 0.4rem',
                        fontSize: '0.7rem',
                        fontWeight: 'bold'
                      }}
                      title="Clear response"
                    >
                      Clear
                    </button>
                  </div>
                  <div style={{
                    fontFamily: 'monospace',
                    fontSize: '0.85rem',
                    color: 'var(--ctp-text)',
                    padding: '0.5rem',
                    background: 'var(--ctp-surface2)',
                    borderRadius: '3px',
                    whiteSpace: editMultiline ? 'pre-wrap' : 'nowrap',
                    overflowX: editMultiline ? 'visible' : 'auto'
                  }}>
                    {getPreview()}
                  </div>
                </div>
              );
            })()}
            <div style={{ paddingLeft: '0.5rem', marginTop: '0.25rem' }}>
              <label style={{ display: 'block', fontSize: '0.85rem', cursor: editChannels.includes('dm') ? 'pointer' : 'not-allowed', color: 'var(--ctp-subtext0)', opacity: editChannels.includes('dm') ? 1 : 0.5 }}>
                <input
                  type="checkbox"
                  checked={editVerifyResponse}
                  onChange={(e) => setEditVerifyResponse(e.target.checked)}
                  disabled={!editChannels.includes('dm')}
                  style={{ marginRight: '0.5rem', cursor: editChannels.includes('dm') ? 'pointer' : 'not-allowed', verticalAlign: 'middle' }}
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
            {/* Enhanced Multi-Pattern Trigger Display - Inline with Brackets */}
            <div style={{ marginBottom: '0.5rem' }}>
              {(() => {
                const patterns = splitTriggerPatterns(trigger.trigger);
                const isMultiPattern = patterns.length > 1;
                
                return (
                  <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0', 
                    flexWrap: 'wrap',
                    fontWeight: 'bold'
                  }}>
                    {isMultiPattern && (
                      <span style={{ 
                        color: 'var(--ctp-subtext0)', 
                        fontSize: '1rem',
                        fontWeight: 'normal',
                        marginRight: '0',
                        paddingRight: '0'
                      }}>[</span>
                    )}
                    {patterns.map((pattern, patternIdx) => {
                      // Parse pattern into segments for highlighting
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
                            // Keep the original text (including whitespace) for accurate boundary detection
                            segments.push({ text: literalText, type: 'literal', startPos: literalStart, endPos: i });
                          }
                        }
                      }

                      // Merge adjacent segments (no whitespace between them)
                      const mergedSegments: Array<Array<{ text: string; type: 'literal' | 'parameter'; paramName?: string }>> = [];
                      let currentGroup: Array<{ text: string; type: 'literal' | 'parameter'; paramName?: string }> = [];

                      for (let j = 0; j < segments.length; j++) {
                        currentGroup.push(segments[j]);

                        // Check if next segment is adjacent (starts immediately after current ends, with no whitespace)
                        const isLastSegment = j === segments.length - 1;
                        let nextSegmentIsAdjacent = false;

                        if (!isLastSegment) {
                          const current = segments[j];
                          const next = segments[j + 1];

                          // Check if positions are adjacent
                          const positionsAdjacent = next.startPos === current.endPos;

                          // Check if there's whitespace at the boundary
                          const currentEndsWithSpace = current.type === 'literal' && current.text.endsWith(' ');
                          const nextStartsWithSpace = next.type === 'literal' && next.text.startsWith(' ');

                          // Only merge if positions are adjacent AND no whitespace at boundary
                          nextSegmentIsAdjacent = positionsAdjacent && !currentEndsWithSpace && !nextStartsWithSpace;
                        }

                        if (!nextSegmentIsAdjacent) {
                          // End of group, push and start new group
                          mergedSegments.push(currentGroup);
                          currentGroup = [];
                        }
                      }
                      
                      return (
                        <React.Fragment key={patternIdx}>
                          <div style={{
                            display: 'inline-flex',
                            flexWrap: 'wrap',
                            alignItems: 'center',
                            gap: '0.2rem'
                          }}>
                            {mergedSegments.map((group, groupIdx) => {
                              if (group.length === 1) {
                                // Single segment - render normally
                                const segment = group[0];
                                return (
                                  <span
                                    key={groupIdx}
                                    style={{
                                      backgroundColor: segment.type === 'parameter'
                                        ? 'rgba(166, 227, 161, 0.3)'
                                        : 'rgba(137, 180, 250, 0.2)',
                                      padding: '0.2rem 0.4rem',
                                      borderRadius: '4px',
                                      fontWeight: segment.type === 'parameter' ? 'bold' : 'normal',
                                      color: segment.type === 'parameter' ? 'var(--ctp-green)' : 'var(--ctp-blue)',
                                      fontFamily: 'monospace',
                                      fontSize: '0.85rem',
                                      border: segment.type === 'parameter'
                                        ? '1px solid rgba(166, 227, 161, 0.5)'
                                        : '1px solid rgba(137, 180, 250, 0.3)'
                                    }}
                                    title={segment.type === 'parameter' ? `Parameter: ${segment.paramName}` : 'Literal text'}
                                  >
                                    {segment.type === 'literal' ? segment.text.trim() : segment.text}
                                  </span>
                                );
                              } else {
                                // Multiple adjacent segments - render as merged badge with dual-color split
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
                                    title={group.map(s => s.type === 'parameter' ? `{${s.paramName}}` : s.text).join('')}
                                  >
                                    {group.map((segment, segIdx) => (
                                      <React.Fragment key={segIdx}>
                                        <span
                                          style={{
                                            backgroundColor: segment.type === 'parameter'
                                              ? 'rgba(166, 227, 161, 0.3)'
                                              : 'rgba(137, 180, 250, 0.2)',
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
                            })}
                          </div>
                          {patternIdx < patterns.length - 1 && (
                            <span style={{ 
                              color: 'var(--ctp-subtext0)', 
                              fontSize: '0.9rem',
                              margin: '0',
                              padding: '0 0.1rem'
                            }}>,</span>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {isMultiPattern && (
                      <span style={{ 
                        color: 'var(--ctp-subtext0)', 
                        fontSize: '1rem',
                        fontWeight: 'normal',
                        marginLeft: '0',
                        paddingLeft: '0'
                      }}>]</span>
                    )}
                  </div>
                );
              })()}
            </div>
            {trigger.responseType === 'script' && (
              <div style={{ color: 'var(--ctp-subtext0)', fontSize: '0.75rem', fontFamily: 'monospace', marginTop: '0.25rem' }}>
                {trigger.response}
              </div>
            )}
            <div style={{ color: 'var(--ctp-subtext0)', fontSize: '0.85rem', marginTop: '0.25rem', whiteSpace: 'pre-wrap' }}>
              {trigger.responseType !== 'script' ? trigger.response : null}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
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
                  background: trigger.responseType === 'text' ? 'var(--ctp-green)' : trigger.responseType === 'script' ? 'var(--ctp-yellow)' : 'var(--ctp-mauve)',
                  color: 'var(--ctp-base)',
                  borderRadius: '3px',
                  fontWeight: 'bold'
                }}>
                  {trigger.responseType.toUpperCase()}
                </span>
                {(() => {
                  const triggerCh = normalizeTriggerChannels(trigger);
                  return (
                    <span style={{
                      fontSize: '0.7rem',
                      padding: '0.15rem 0.4rem',
                      background: triggerCh.includes('dm') ? 'var(--ctp-sky)' : 'var(--ctp-lavender)',
                      color: 'var(--ctp-base)',
                      borderRadius: '3px',
                      fontWeight: 'bold'
                    }}>
                      {triggerCh.map(c => {
                        if (c === 'dm') return 'DM';
                        if (c === 'none') return 'NONE';
                        return `CH${c}`;
                      }).join('+')}
                    </span>
                  );
                })()}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {trigger.responseType === 'script' && (
                <button
                  onClick={() => setShowTestModal(true)}
                  style={{
                    padding: '0.25rem 0.5rem',
                    fontSize: '12px',
                    background: 'var(--ctp-teal)',
                    color: 'var(--ctp-base)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                  title={t('script_test.run_test', 'Run Test')}
                >
                  {t('common.test', 'Test')}
                </button>
              )}
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
                onClick={() => setShowRemoveModal(true)}
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
          zIndex: 10000
        }}>
          <div style={{
            background: 'var(--ctp-base)',
            borderRadius: '8px',
            padding: '1.5rem',
            maxWidth: '500px',
            width: '90%',
            border: '1px solid var(--ctp-overlay0)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, color: 'var(--ctp-text)' }}>Remove Trigger</h3>
              <button
                onClick={() => setShowRemoveModal(false)}
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
              Are you sure you want to remove this trigger? This action cannot be undone.
            </p>
            <div style={{ 
              marginBottom: '1rem',
              padding: '0.75rem',
              background: 'var(--ctp-surface0)',
              borderRadius: '4px',
              fontFamily: 'monospace',
              fontSize: '0.85rem',
              color: 'var(--ctp-text)'
            }}>
              {formatTriggerPatterns(trigger.trigger)}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowRemoveModal(false)}
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
                onClick={() => {
                  onRemove();
                  setShowRemoveModal(false);
                  if (showToast) {
                    showToast(t('auto_responder.trigger_removed'), 'success');
                  }
                }}
                style={{
                  padding: '0.5rem 1rem',
                  background: 'var(--ctp-red)',
                  color: 'var(--ctp-base)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontWeight: 'bold'
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Script Test Modal */}
      {trigger.responseType === 'script' && (
        <ScriptTestModal
          isOpen={showTestModal}
          onClose={() => setShowTestModal(false)}
          triggerType="auto-responder"
          scriptPath={trigger.response}
          scriptArgs={trigger.scriptArgs}
          trigger={trigger.trigger}
          baseUrl={baseUrl}
        />
      )}
    </div>
  );
};

export default TriggerItem;

