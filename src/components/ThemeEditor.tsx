import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { validateThemeDefinition, generateThemeSlug } from '../utils/themeValidation';
import { validateThemeAccessibility } from '../utils/accessibilityChecker';
import type { CustomTheme, BuiltInTheme } from '../contexts/SettingsContext';
import { useAuth } from '../contexts/AuthContext';
import './ThemeEditor.css';

interface ThemeEditorProps {
  theme?: CustomTheme | null;
  baseTheme?: BuiltInTheme | CustomTheme;
  onSave: (name: string, slug: string, definition: Record<string, string>) => Promise<void>;
  onCancel: () => void;
}

type EditorMode = 'visual' | 'json';

const COLOR_GROUPS = [
  {
    name: 'Base Colors',
    colors: ['base', 'mantle', 'crust'] as const,
    description: 'Background and surface colors'
  },
  {
    name: 'Text Colors',
    colors: ['text', 'subtext1', 'subtext0'] as const,
    description: 'Text and secondary text colors'
  },
  {
    name: 'Overlay Colors',
    colors: ['overlay2', 'overlay1', 'overlay0'] as const,
    description: 'UI element overlays and borders'
  },
  {
    name: 'Surface Colors',
    colors: ['surface2', 'surface1', 'surface0'] as const,
    description: 'Card and panel backgrounds'
  },
  {
    name: 'Accent Colors',
    colors: ['lavender', 'blue', 'sapphire', 'sky', 'teal', 'green'] as const,
    description: 'Primary accent colors'
  },
  {
    name: 'Semantic Colors',
    colors: ['yellow', 'peach', 'maroon', 'red', 'mauve', 'pink', 'flamingo', 'rosewater'] as const,
    description: 'Warning, error, and decorative colors'
  }
];

const OPTIONAL_COLOR_GROUPS = [
  {
    name: 'Chat Bubble Colors',
    description: 'Override chat bubble colors independently from accent colors',
    colors: [
      { key: 'chatBubbleSentBg', label: 'Sent Background', fallback: 'blue' },
      { key: 'chatBubbleSentText', label: 'Sent Text', fallback: 'base' },
      { key: 'chatBubbleReceivedBg', label: 'Received Background', fallback: 'surface1' },
      { key: 'chatBubbleReceivedText', label: 'Received Text', fallback: 'text' }
    ]
  }
];

export const ThemeEditor: React.FC<ThemeEditorProps> = ({
  theme,
  baseTheme,
  onSave,
  onCancel
}) => {
  const { t } = useTranslation();
  const { authStatus } = useAuth();

  const [name, setName] = useState(theme?.name || '');
  const [mode, setMode] = useState<EditorMode>('visual');
  const [colors, setColors] = useState<Record<string, string>>(() => {
    if (theme) {
      try {
        return JSON.parse(theme.definition);
      } catch {
        return getDefaultColors();
      }
    }
    if (baseTheme) {
      if (typeof baseTheme === 'string') {
        // Built-in theme - extract colors from CSS
        return getColorsFromBuiltInTheme(baseTheme);
      } else {
        // Custom theme
        try {
          return JSON.parse(baseTheme.definition);
        } catch {
          return getDefaultColors();
        }
      }
    }
    return getDefaultColors();
  });

  const [jsonValue, setJsonValue] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [accessibilityReport, setAccessibilityReport] = useState<any>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Sync JSON value with colors
  useEffect(() => {
    if (mode === 'json') {
      setJsonValue(JSON.stringify(colors, null, 2));
    }
  }, [colors, mode]);

  // Validate theme whenever colors change
  useEffect(() => {
    const validation = validateThemeDefinition(colors);
    setValidationErrors(validation.errors);

    if (validation.isValid) {
      const accessibility = validateThemeAccessibility(colors as any);
      setAccessibilityReport(accessibility);
    }
  }, [colors]);

  const handleColorChange = useCallback((colorKey: string, value: string) => {
    setColors(prev => ({
      ...prev,
      [colorKey]: value
    }));
  }, []);

  const handleJsonChange = useCallback((value: string) => {
    setJsonValue(value);
    setJsonError(null);

    try {
      const parsed = JSON.parse(value);
      const validation = validateThemeDefinition(parsed);

      if (validation.isValid) {
        setColors(parsed);
        setJsonError(null);
      } else {
        setJsonError(validation.errors.join(', '));
      }
    } catch (error: any) {
      setJsonError(`Invalid JSON: ${error.message}`);
    }
  }, []);

  const handleSave = async () => {
    if (!name.trim()) {
      alert(t('theme_editor.enter_name'));
      return;
    }

    const validation = validateThemeDefinition(colors);
    if (!validation.isValid) {
      alert(t('theme_editor.validation_failed', { errors: validation.errors.join('\n') }));
      return;
    }

    setIsSaving(true);
    try {
      const slug = theme?.slug || generateThemeSlug(name);
      await onSave(name.trim(), slug, colors);
    } catch (error: any) {
      alert(t('theme_editor.save_failed', { error: error.message }));
    } finally {
      setIsSaving(false);
    }
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const imported = JSON.parse(text);

        if (imported.name) setName(imported.name);
        if (imported.definition) {
          const def = typeof imported.definition === 'string'
            ? JSON.parse(imported.definition)
            : imported.definition;

          const validation = validateThemeDefinition(def);
          if (validation.isValid) {
            setColors(def);
          } else {
            alert(t('theme_editor.invalid_file', { errors: validation.errors.join('\n') }));
          }
        }
      } catch (error: any) {
        alert(t('theme_editor.import_failed', { error: error.message }));
      }
    };
    input.click();
  };

  const handleExport = () => {
    const exportData = {
      name,
      slug: theme?.slug || generateThemeSlug(name),
      definition: colors
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json'
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${exportData.slug}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const canSave = authStatus?.permissions?.themes?.write && validationErrors.length === 0 && name.trim().length > 0;

  return (
    <div className="theme-editor">
      <div className="theme-editor-header">
        <h2>{theme ? t('theme_editor.edit_title') : t('theme_editor.create_title')}</h2>

        <div className="theme-editor-actions">
          <button onClick={handleImport} className="btn-secondary">
            {t('theme_editor.import')}
          </button>
          <button onClick={handleExport} className="btn-secondary" disabled={!name.trim()}>
            {t('theme_editor.export')}
          </button>
        </div>
      </div>

      <div className="theme-editor-metadata">
        <div className="form-group">
          <label htmlFor="theme-name">{t('theme_editor.theme_name')}</label>
          <input
            id="theme-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('theme_editor.name_placeholder')}
            maxLength={50}
            className="form-control"
          />
          {theme?.slug && (
            <small className="form-text">{t('theme_editor.slug')}: {theme.slug}</small>
          )}
        </div>
      </div>

      <div className="theme-editor-mode-switch">
        <button
          className={`mode-btn ${mode === 'visual' ? 'active' : ''}`}
          onClick={() => setMode('visual')}
        >
          {t('theme_editor.visual_editor')}
        </button>
        <button
          className={`mode-btn ${mode === 'json' ? 'active' : ''}`}
          onClick={() => setMode('json')}
        >
          {t('theme_editor.json_editor')}
        </button>
      </div>

      {mode === 'visual' ? (
        <div className="theme-editor-visual">
          {COLOR_GROUPS.map((group) => (
            <div key={group.name} className="color-group">
              <h3>{group.name}</h3>
              <p className="color-group-description">{group.description}</p>
              <div className="color-grid">
                {group.colors.map((colorKey) => (
                  <div key={colorKey} className="color-picker-item">
                    <label htmlFor={`color-${colorKey}`}>{colorKey}</label>
                    <div className="color-input-wrapper">
                      <input
                        id={`color-${colorKey}`}
                        type="color"
                        value={colors[colorKey] || '#000000'}
                        onChange={(e) => handleColorChange(colorKey, e.target.value)}
                        className="color-picker"
                      />
                      <input
                        type="text"
                        value={colors[colorKey] || '#000000'}
                        onChange={(e) => handleColorChange(colorKey, e.target.value)}
                        pattern="^#[0-9A-Fa-f]{6}$"
                        className="color-hex-input"
                        placeholder="#000000"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {OPTIONAL_COLOR_GROUPS.map((group) => (
            <div key={group.name} className="color-group">
              <h3>{group.name}</h3>
              <p className="color-group-description">{group.description}</p>
              <div className="color-grid">
                {group.colors.map((colorDef) => {
                  const isEnabled = colorDef.key in colors;
                  const fallbackValue = colors[colorDef.fallback] || '#000000';
                  return (
                    <div key={colorDef.key} className="color-picker-item">
                      <label htmlFor={`color-${colorDef.key}`}>
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={(e) => {
                            if (e.target.checked) {
                              handleColorChange(colorDef.key, fallbackValue);
                            } else {
                              setColors(prev => {
                                const next = { ...prev };
                                delete next[colorDef.key];
                                return next;
                              });
                            }
                          }}
                          style={{ marginRight: '6px' }}
                        />
                        {colorDef.label}
                      </label>
                      {isEnabled && (
                        <div className="color-input-wrapper">
                          <input
                            id={`color-${colorDef.key}`}
                            type="color"
                            value={colors[colorDef.key] || fallbackValue}
                            onChange={(e) => handleColorChange(colorDef.key, e.target.value)}
                            className="color-picker"
                          />
                          <input
                            type="text"
                            value={colors[colorDef.key] || fallbackValue}
                            onChange={(e) => handleColorChange(colorDef.key, e.target.value)}
                            pattern="^#[0-9A-Fa-f]{6}$"
                            className="color-hex-input"
                            placeholder="#000000"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="theme-editor-json">
          <textarea
            value={jsonValue}
            onChange={(e) => handleJsonChange(e.target.value)}
            className="json-editor-textarea"
            spellCheck={false}
            placeholder='{\n  "base": "#1e1e2e",\n  "text": "#cdd6f4",\n  ...\n}'
          />
          {jsonError && (
            <div className="json-error">{jsonError}</div>
          )}
        </div>
      )}

      {validationErrors.length > 0 && (
        <div className="theme-validation-errors">
          <h4>{t('theme_editor.validation_errors')}:</h4>
          <ul>
            {validationErrors.map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      {accessibilityReport && (
        <div className={`theme-accessibility-report ${accessibilityReport.isAccessible ? 'success' : 'warning'}`}>
          <h4>{t('theme_editor.accessibility_check')}</h4>

          {accessibilityReport.criticalIssues.length > 0 && (
            <div className="critical-issues">
              <strong>{t('theme_editor.critical_issues')}:</strong>
              <ul>
                {accessibilityReport.criticalIssues.map((issue: string, i: number) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            </div>
          )}

          {accessibilityReport.warnings.length > 0 && (
            <div className="warnings">
              <strong>{t('theme_editor.warnings')}:</strong>
              <ul>
                {accessibilityReport.warnings.map((warning: string, i: number) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {accessibilityReport.recommendations.length > 0 && (
            <div className="recommendations">
              <strong>{t('theme_editor.recommendations')}:</strong>
              <ul>
                {accessibilityReport.recommendations.map((rec: string, i: number) => (
                  <li key={i}>{rec}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="theme-editor-footer">
        <button onClick={onCancel} className="btn-secondary">
          {t('common.cancel')}
        </button>
        <button
          onClick={handleSave}
          className="btn-primary"
          disabled={!canSave || isSaving}
        >
          {isSaving ? t('common.saving') : theme ? t('theme_editor.update_theme') : t('theme_editor.create_theme')}
        </button>
      </div>
    </div>
  );
};

/**
 * Get default color values (mocha theme)
 */
function getDefaultColors(): Record<string, string> {
  return {
    base: '#1e1e2e',
    mantle: '#181825',
    crust: '#11111b',
    text: '#cdd6f4',
    subtext1: '#bac2de',
    subtext0: '#a6adc8',
    overlay2: '#9399b2',
    overlay1: '#7f849c',
    overlay0: '#6c7086',
    surface2: '#585b70',
    surface1: '#45475a',
    surface0: '#313244',
    lavender: '#b4befe',
    blue: '#89b4fa',
    sapphire: '#74c7ec',
    sky: '#89dceb',
    teal: '#94e2d5',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    peach: '#fab387',
    maroon: '#eba0ac',
    red: '#f38ba8',
    mauve: '#cba6f7',
    pink: '#f5c2e7',
    flamingo: '#f2cdcd',
    rosewater: '#f5e0dc'
  };
}

/**
 * Extract colors from a built-in theme
 * This is a simplified version - in reality you'd read from computed styles
 */
function getColorsFromBuiltInTheme(_themeName: string): Record<string, string> {
  // For now, return default colors
  // In a real implementation, you'd extract these from CSS or have predefined values
  return getDefaultColors();
}
