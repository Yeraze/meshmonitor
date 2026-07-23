import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import { ThemeEditor } from './ThemeEditor';
import { useSettings, type CustomTheme, type BuiltInTheme } from '../contexts/SettingsContext';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import './CustomThemeManagement.css';

export const CustomThemeManagement: React.FC = () => {
  const { t } = useTranslation();
  const { customThemes, loadCustomThemes, theme, darkTheme, lightTheme, setDarkTheme, setLightTheme } = useSettings();
  const { authStatus } = useAuth();

  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingTheme, setEditingTheme] = useState<CustomTheme | null>(null);
  const [baseTheme, setBaseTheme] = useState<BuiltInTheme | CustomTheme | undefined>(undefined);

  const canWrite = authStatus?.permissions?.global?.themes?.write || false;

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
    const body = { name, slug, definition };

    if (editingTheme) {
      await api.put(`/api/themes/${editingTheme.slug}`, body);
    } else {
      await api.post('/api/themes', body);
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

    try {
      await api.delete(`/api/themes/${themeSlug}`);
    } catch (error) {
      alert(t('theme_management.delete_failed', { error: error instanceof Error ? error.message : String(error) }));
      return;
    }

    if (darkTheme === themeSlug) {
      setDarkTheme('mocha');
    }
    if (lightTheme === themeSlug) {
      setLightTheme('latte');
    }

    // Reload themes
    await loadCustomThemes();
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
              isDarkTheme={darkTheme === customTheme.slug}
              isLightTheme={lightTheme === customTheme.slug}
              canWrite={canWrite}
              onApplyDark={() => setDarkTheme(customTheme.slug)}
              onApplyLight={() => setLightTheme(customTheme.slug)}
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
  isDarkTheme: boolean;
  isLightTheme: boolean;
  canWrite: boolean;
  onApplyDark: () => void;
  onApplyLight: () => void;
  onEdit: () => void;
  onClone: () => void;
  onDelete: () => void;
}

const ThemeCard: React.FC<ThemeCardProps> = ({
  theme,
  isDarkTheme,
  isLightTheme,
  canWrite,
  onApplyDark,
  onApplyLight,
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
  const isAssigned = isDarkTheme || isLightTheme;

  return (
    <div className={`theme-card ${isAssigned ? 'active' : ''}`}>
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
          {isAssigned && (
            <div className="theme-assignment-badges">
              {isDarkTheme && <span className="assignment-badge">{t('theme_management.assigned_dark')}</span>}
              {isLightTheme && <span className="assignment-badge">{t('theme_management.assigned_light')}</span>}
            </div>
          )}
        </div>

        <div className="theme-card-actions">
          <button
            onClick={onApplyDark}
            className={`btn-apply ${isDarkTheme ? 'active' : ''}`}
            disabled={isDarkTheme}
          >
            {isDarkTheme ? t('theme_management.dark_active') : t('theme_management.apply_dark')}
          </button>

          <button
            onClick={onApplyLight}
            className={`btn-apply ${isLightTheme ? 'active' : ''}`}
            disabled={isLightTheme}
          >
            {isLightTheme ? t('theme_management.light_active') : t('theme_management.apply_light')}
          </button>

          {canWrite && !theme.is_builtin && (
            <button onClick={onEdit} className="btn-icon" title={t('common.edit')} aria-label={t('common.edit')}>
              <UiIcon name="edit" />
            </button>
          )}

          <button onClick={onClone} className="btn-icon" title={t('theme_management.clone')} aria-label={t('theme_management.clone')}>
            <UiIcon name="copy" />
          </button>

          {canWrite && !theme.is_builtin && (
            <button onClick={onDelete} className="btn-icon btn-danger" title={t('common.delete')} aria-label={t('common.delete')}>
              <UiIcon name="delete" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
