import React, { useState } from 'react';
import { ScriptMetadata } from './types';

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
 * Format script for list display
 * Returns: "emoji name | filename | language" or "langEmoji filename" if no metadata
 */
const formatScriptListDisplay = (script: ScriptMetadata): string => {
  const langEmoji = getLanguageEmoji(script.language);
  if (script.name) {
    const emoji = script.emoji || langEmoji;
    return `${emoji} ${script.name} | ${script.filename} | ${script.language}`;
  }
  return `${langEmoji} ${script.filename}`;
};

interface ScriptManagementProps {
  availableScripts: ScriptMetadata[];
  selectedScripts: Set<string>;
  isImporting: boolean;
  isExporting: boolean;
  isDeleting: string | null;
  onImportClick: () => void;
  onExportClick: () => void;
  onDeleteClick: (filename: string) => void;
  onToggleSelection: (script: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

const ScriptManagement: React.FC<ScriptManagementProps> = ({
  availableScripts,
  selectedScripts,
  isImporting,
  isExporting,
  isDeleting,
  onImportClick,
  onExportClick,
  onDeleteClick,
  onToggleSelection,
  onSelectAll,
  onDeselectAll,
}) => {
  const [showScriptManagement, setShowScriptManagement] = useState(false);

  return (
    <div className="setting-item" style={{ marginTop: '1.5rem' }}>
      <button
        onClick={() => setShowScriptManagement(!showScriptManagement)}
        style={{
          width: '100%',
          padding: '0.75rem 1rem',
          background: 'var(--ctp-surface1)',
          border: 'none',
          borderBottom: showScriptManagement ? '1px solid var(--ctp-overlay0)' : 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '0.9rem',
          fontWeight: 'bold',
          color: 'var(--ctp-blue)'
        }}
      >
        <span>📜 Script Management</span>
        <span style={{ fontSize: '1.2rem' }}>{showScriptManagement ? '▼' : '▶'}</span>
      </button>

      {showScriptManagement && (
        <div style={{ 
          marginTop: '0.75rem', 
          padding: '1rem', 
          background: 'var(--ctp-surface0)', 
          border: '1px solid var(--ctp-overlay0)', 
          borderRadius: '4px' 
        }}>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <button
              onClick={onImportClick}
              disabled={isImporting}
              style={{
                padding: '0.5rem 1rem',
                fontSize: '0.875rem',
                background: isImporting ? 'var(--ctp-surface2)' : 'var(--ctp-blue)',
                color: isImporting ? 'var(--ctp-subtext0)' : 'var(--ctp-base)',
                border: 'none',
                borderRadius: '4px',
                cursor: isImporting ? 'not-allowed' : 'pointer',
                fontWeight: 'bold'
              }}
            >
              {isImporting ? 'Importing...' : '📥 Import Script'}
            </button>
            <button
              onClick={onExportClick}
              disabled={isExporting || availableScripts.length === 0}
              style={{
                padding: '0.5rem 1rem',
                fontSize: '0.875rem',
                background: (isExporting || availableScripts.length === 0) ? 'var(--ctp-surface2)' : 'var(--ctp-green)',
                color: (isExporting || availableScripts.length === 0) ? 'var(--ctp-subtext0)' : 'var(--ctp-base)',
                border: 'none',
                borderRadius: '4px',
                cursor: (isExporting || availableScripts.length === 0) ? 'not-allowed' : 'pointer',
                fontWeight: 'bold'
              }}
            >
              {isExporting ? 'Exporting...' : '📤 Export Scripts'}
            </button>
            {availableScripts.length > 0 && (
              <>
                <button
                  onClick={onSelectAll}
                  style={{
                    padding: '0.5rem 1rem',
                    fontSize: '0.875rem',
                    background: 'var(--ctp-surface1)',
                    color: 'var(--ctp-text)',
                    border: '1px solid var(--ctp-overlay0)',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  Select All
                </button>
                <button
                  onClick={onDeselectAll}
                  style={{
                    padding: '0.5rem 1rem',
                    fontSize: '0.875rem',
                    background: 'var(--ctp-surface1)',
                    color: 'var(--ctp-text)',
                    border: '1px solid var(--ctp-overlay0)',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  Deselect All
                </button>
              </>
            )}
            <a
              href="https://meshmonitor.org/user-scripts.html"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: '0.5rem 1rem',
                fontSize: '0.875rem',
                background: 'var(--ctp-mauve)',
                color: 'var(--ctp-base)',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 'bold',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center'
              }}
            >
              Script Gallery
            </a>
          </div>

          {availableScripts.length === 0 ? (
            <div style={{ 
              padding: '1rem', 
              textAlign: 'center', 
              color: 'var(--ctp-subtext0)', 
              fontStyle: 'italic' 
            }}>
              No scripts found in /data/scripts/
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {availableScripts.map((script) => {
                const isSelected = selectedScripts.has(script.path);
                return (
                  <div
                    key={script.path}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.75rem',
                      padding: '0.75rem',
                      background: isSelected ? 'var(--ctp-surface1)' : 'transparent',
                      border: '1px solid var(--ctp-overlay0)',
                      borderRadius: '4px'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleSelection(script.path)}
                      style={{ cursor: 'pointer' }}
                    />
                    <span style={{ flex: '1', fontSize: '0.9rem' }}>
                      {formatScriptListDisplay(script)}
                    </span>
                    <button
                      onClick={() => onDeleteClick(script.filename)}
                      disabled={isDeleting === script.filename}
                      style={{
                        padding: '0.25rem 0.75rem',
                        fontSize: '0.75rem',
                        background: isDeleting === script.filename ? 'var(--ctp-surface2)' : 'var(--ctp-red)',
                        color: isDeleting === script.filename ? 'var(--ctp-subtext0)' : 'var(--ctp-base)',
                        border: 'none',
                        borderRadius: '3px',
                        cursor: isDeleting === script.filename ? 'not-allowed' : 'pointer',
                        fontWeight: 'bold'
                      }}
                    >
                      {isDeleting === script.filename ? 'Deleting...' : '🗑️ Delete'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ScriptManagement;

