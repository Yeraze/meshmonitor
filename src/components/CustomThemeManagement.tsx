import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ThemeEditor } from './ThemeEditor';
import { useSettings, type CustomTheme, type BuiltInTheme } from '../contexts/SettingsContext';
import { useAuth } from '../contexts/AuthContext';
import { useCsrf } from '../contexts/CsrfContext';
import api from '../services/api';
import './CustomThemeManagement.css';

export const CustomThemeManagement: React.FC = () => {
  const { t } = useTranslation();
  const { customThemes, loadCustomThemes, theme, setTheme } = useSettings();
  const { authStatus } = useAuth();
  const { getToken: getCsrfToken } = useCsrf();

  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingTheme, setEditingTheme] = useState<CustomTheme | null>(null);
  const [baseTheme, setBaseTheme] = useState<BuiltInTheme | CustomTheme | undefined>(undefined);

  const canWrite = authStatus?.permissions?.themes?.write || false;

  const handleCreateNew = () => {
    setEditingTheme(null);
    setBaseTheme(theme as any);
    setIsEditorOpen(true);
  };

  const handleEdit = (themeToEdit: CustomTheme) => {
    setEditingTheme(themeToEdit);
    setBaseTheme(undefined);
    setIsEditorOpen(true);
  };

  const handleClone = (themeToClone: CustomTheme) => {
    setEditingTheme(null);
    setBaseTheme(themeToClone);
    setIsEditorOpen(true);
  };

  const handleSave = async (name: string, slug: string, definition: Record<string, string>) => {
    const baseUrl = await api.getBaseUrl();
    const csrfToken = getCsrfToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    const url = editingTheme
      ? `${baseUrl}/api/themes/${editingTheme.slug}`
      : `${baseUrl}/api/themes`;

    const method = editingTheme ? 'PUT' : 'POST';

    const response = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      body: JSON.stringify({
        name,
        slug,
        definition
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to save theme');
    }

    // Reload themes
    await loadCustomThemes();
    setIsEditorOpen(false);
    setEditingTheme(null);
  };

  const handleDelete = async (themeSlug: string) => {
    if (!confirm(t('theme_management.delete_confirm'))) {
      return;
    }

    const baseUrl = await api.getBaseUrl();
    const csrfToken = getCsrfToken();
    const headers: Record<string, string> = {};

    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    const response = await fetch(`${baseUrl}/api/themes/${themeSlug}`, {
      method: 'DELETE',
      headers,
      credentials: 'include'
    });

    if (!response.ok) {
      const error = await response.json();
      alert(t('theme_management.delete_failed', { error: error.error }));
      return;
    }

    // If we deleted the active theme, switch to mocha
    if (theme === themeSlug) {
      setTheme('mocha');
    }

    // Reload themes
    await loadCustomThemes();
  };

  const handleApply = (themeSlug: string) => {
    setTheme(themeSlug);
  };

  if (isEditorOpen) {
    return (
      <ThemeEditor
        theme={editingTheme}
        baseTheme={baseTheme}
        onSave={handleSave}
        onCancel={() => {
          setIsEditorOpen(false);
          setEditingTheme(null);
        }}
      />
    );
  }

  return (
    <div className="custom-theme-management">
      <div className="theme-management-header">
        <div>
          <h3>{t('theme_management.title')}</h3>
          <p>{t('theme_management.description')}</p>
        </div>
        {canWrite && (
          <button onClick={handleCreateNew} className="btn-primary">
            {t('theme_management.create_new')}
          </button>
        )}
      </div>

      {customThemes.length === 0 ? (
        <div className="no-themes-message">
          <p>{t('theme_management.no_themes')}</p>
          {canWrite && (
            <p>{t('theme_management.get_started')}</p>
          )}
        </div>
      ) : (
        <div className="theme-list">
          {customThemes.map((customTheme) => (
            <ThemeCard
              key={customTheme.id}
              theme={customTheme}
              isActive={theme === customTheme.slug}
              canWrite={canWrite}
              onApply={() => handleApply(customTheme.slug)}
              onEdit={() => handleEdit(customTheme)}
              onClone={() => handleClone(customTheme)}
              onDelete={() => handleDelete(customTheme.slug)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface ThemeCardProps {
  theme: CustomTheme;
  isActive: boolean;
  canWrite: boolean;
  onApply: () => void;
  onEdit: () => void;
  onClone: () => void;
  onDelete: () => void;
}

const ThemeCard: React.FC<ThemeCardProps> = ({
  theme,
  isActive,
  canWrite,
  onApply,
  onEdit,
  onClone,
  onDelete
}) => {
  const { t } = useTranslation();
  const definition = React.useMemo(() => {
    try {
      return JSON.parse(theme.definition);
    } catch {
      return {};
    }
  }, [theme.definition]);

  const previewColors = [
    definition.base,
    definition.text,
    definition.blue,
    definition.green,
    definition.yellow,
    definition.red
  ].filter(Boolean);

  return (
    <div className={`theme-card ${isActive ? 'active' : ''}`}>
      <div className="theme-card-preview">
        <div className="color-preview-grid">
          {previewColors.map((color, i) => (
            <div
              key={i}
              className="color-preview-swatch"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </div>

      <div className="theme-card-content">
        <div className="theme-card-info">
          <h4>{theme.name}</h4>
          <span className="theme-slug">{theme.slug}</span>
          {theme.is_builtin === 1 && (
            <span className="builtin-badge">{t('theme_management.built_in')}</span>
          )}
        </div>

        <div className="theme-card-actions">
          <button
            onClick={onApply}
            className={`btn-apply ${isActive ? 'active' : ''}`}
            disabled={isActive}
          >
            {isActive ? t('theme_management.active') : t('theme_management.apply')}
          </button>

          {canWrite && !theme.is_builtin && (
            <button onClick={onEdit} className="btn-icon" title={t('common.edit')}>
              ✏️
            </button>
          )}

          <button onClick={onClone} className="btn-icon" title={t('theme_management.clone')}>
            📋
          </button>

          {canWrite && !theme.is_builtin && (
            <button onClick={onDelete} className="btn-icon btn-danger" title={t('common.delete')}>
              🗑️
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
