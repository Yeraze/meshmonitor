import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings, type Theme } from '../contexts/SettingsContext';
import './ThemeDocumentation.css';
import { UiIcon } from './icons';

interface ThemeInfo {
  id: Theme;
  name: string;
  description: string;
  category: 'catppuccin' | 'popular' | 'high-contrast' | 'colorblind';
  accessibility?: string;
}

const themes: ThemeInfo[] = [
  // Catppuccin
  {
    id: 'latte',
    name: 'Catppuccin Latte',
    description: 'Soothing pastel light theme',
    category: 'catppuccin'
  },
  {
    id: 'frappe',
    name: 'Catppuccin Frappé',
    description: 'Medium-contrast cool theme',
    category: 'catppuccin'
  },
  {
    id: 'macchiato',
    name: 'Catppuccin Macchiato',
    description: 'Medium-dark comfortable theme',
    category: 'catppuccin'
  },
  {
    id: 'mocha',
    name: 'Catppuccin Mocha',
    description: 'Deep dark theme (default)',
    category: 'catppuccin'
  },
  // Popular
  {
    id: 'nord',
    name: 'Nord',
    description: 'Arctic, north-bluish color palette',
    category: 'popular'
  },
  {
    id: 'dracula',
    name: 'Dracula',
    description: 'Dark theme with vibrant purple and pink accents',
    category: 'popular'
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    description: 'Precision colors for machines and people',
    category: 'popular'
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    description: 'Light variant of the classic Solarized theme',
    category: 'popular'
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    description: 'Retro groove color scheme with warm tones',
    category: 'popular'
  },
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    description: 'Light variant of the warm Gruvbox theme',
    category: 'popular'
  },
  // High Contrast
  {
    id: 'high-contrast-dark',
    name: 'High Contrast Dark',
    description: 'Maximum contrast for improved readability in dark mode',
    category: 'high-contrast',
    accessibility: 'WCAG AAA compliant - Ideal for users with low vision'
  },
  {
    id: 'high-contrast-light',
    name: 'High Contrast Light',
    description: 'Maximum contrast for improved readability in light mode',
    category: 'high-contrast',
    accessibility: 'WCAG AAA compliant - Ideal for users with low vision'
  },
  // Color Blind Friendly
  {
    id: 'protanopia',
    name: 'Protanopia Friendly',
    description: 'Optimized for red color blindness (blue/yellow contrast)',
    category: 'colorblind',
    accessibility: 'Designed for protanopia (red-blind) - Uses blue/yellow contrast'
  },
  {
    id: 'deuteranopia',
    name: 'Deuteranopia Friendly',
    description: 'Optimized for green color blindness (blue/yellow contrast)',
    category: 'colorblind',
    accessibility: 'Designed for deuteranopia (green-blind) - Uses blue/yellow contrast'
  },
  {
    id: 'tritanopia',
    name: 'Tritanopia Friendly',
    description: 'Optimized for blue color blindness (red/cyan contrast)',
    category: 'colorblind',
    accessibility: 'Designed for tritanopia (blue-blind) - Uses red/cyan contrast'
  }
];

const colorSwatchProps = [
  { var: '--ctp-base', label: 'Base' },
  { var: '--ctp-mantle', label: 'Mantle' },
  { var: '--ctp-text', label: 'Text' },
  { var: '--ctp-blue', label: 'Blue' },
  { var: '--ctp-green', label: 'Green' },
  { var: '--ctp-yellow', label: 'Yellow' },
  { var: '--ctp-red', label: 'Red' },
  { var: '--ctp-mauve', label: 'Mauve' }
];

export const ThemeDocumentation: React.FC = () => {
  const { t } = useTranslation();
  const { darkTheme, lightTheme, setDarkTheme, setLightTheme } = useSettings();
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const filteredThemes = selectedCategory === 'all'
    ? themes
    : themes.filter(theme => theme.category === selectedCategory);

  const categories = [
    { id: 'all', name: t('theme_gallery.category_all') },
    { id: 'catppuccin', name: t('theme_gallery.category_catppuccin') },
    { id: 'popular', name: t('theme_gallery.category_popular') },
    { id: 'high-contrast', name: t('theme_gallery.category_high_contrast') },
    { id: 'colorblind', name: t('theme_gallery.category_colorblind') }
  ];

  return (
    <div className="theme-documentation">
      <div className="theme-doc-header">
        <h2>{t('theme_gallery.title')}</h2>
        <p>
          {t('theme_gallery.description', { count: themes.length })}
        </p>
      </div>

      <div className="theme-categories">
        {categories.map(cat => (
          <button
            key={cat.id}
            className={`category-btn ${selectedCategory === cat.id ? 'active' : ''}`}
            onClick={() => setSelectedCategory(cat.id)}
          >
            {cat.name}
          </button>
        ))}
      </div>

      <div className="themes-grid">
        {filteredThemes.map(themeInfo => (
          <ThemeCard
            key={themeInfo.id}
            themeInfo={themeInfo}
            isDarkTheme={darkTheme === themeInfo.id}
            isLightTheme={lightTheme === themeInfo.id}
            onApplyDark={() => setDarkTheme(themeInfo.id)}
            onApplyLight={() => setLightTheme(themeInfo.id)}
          />
        ))}
      </div>

      <div className="theme-doc-footer">
        <h3>{t('theme_gallery.accessibility_info')}</h3>
        <div className="accessibility-info">
          <div className="info-section">
            <h4>{t('theme_gallery.high_contrast_title')}</h4>
            <p>
              {t('theme_gallery.high_contrast_desc')}
            </p>
          </div>
          <div className="info-section">
            <h4>{t('theme_gallery.colorblind_title')}</h4>
            <p>
              {t('theme_gallery.colorblind_desc')}
            </p>
            <ul>
              <li><strong>{t('theme_gallery.protanopia')}:</strong> {t('theme_gallery.protanopia_desc')}</li>
              <li><strong>{t('theme_gallery.deuteranopia')}:</strong> {t('theme_gallery.deuteranopia_desc')}</li>
              <li><strong>{t('theme_gallery.tritanopia')}:</strong> {t('theme_gallery.tritanopia_desc')}</li>
            </ul>
          </div>
          <div className="info-section">
            <h4>{t('theme_gallery.persistence_title')}</h4>
            <p>
              {t('theme_gallery.persistence_desc')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

interface ThemeCardProps {
  themeInfo: ThemeInfo;
  isDarkTheme: boolean;
  isLightTheme: boolean;
  onApplyDark: () => void;
  onApplyLight: () => void;
}

const ThemeCard: React.FC<ThemeCardProps> = ({ themeInfo, isDarkTheme, isLightTheme, onApplyDark, onApplyLight }) => {
  const { t } = useTranslation();
  const [colors, setColors] = useState<Record<string, string>>({});
  const isAssigned = isDarkTheme || isLightTheme;

  React.useEffect(() => {
    // Temporarily apply the theme to get its colors
    const originalTheme = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', themeInfo.id);

    const style = getComputedStyle(document.documentElement);
    const newColors: Record<string, string> = {};

    colorSwatchProps.forEach(prop => {
      newColors[prop.var] = style.getPropertyValue(prop.var).trim();
    });

    setColors(newColors);

    // Restore original theme
    if (originalTheme) {
      document.documentElement.setAttribute('data-theme', originalTheme);
    }
  }, [themeInfo.id]);

  return (
    <div
      className={`theme-card ${isAssigned ? 'active' : ''}`}
    >
      <div className="theme-card-header">
        <h3>{themeInfo.name}</h3>
        {isAssigned && (
          <span className="current-badge">
            {isDarkTheme && isLightTheme
              ? `${t('theme_management.assigned_dark')} + ${t('theme_management.assigned_light')}`
              : isDarkTheme
                ? t('theme_management.assigned_dark')
                : t('theme_management.assigned_light')}
          </span>
        )}
      </div>

      <p className="theme-description">{themeInfo.description}</p>

      {themeInfo.accessibility && (
        <div className="accessibility-badge">
          <span className="badge-icon"><UiIcon name="accessibility" size={16} /></span>
          <span className="badge-text">{themeInfo.accessibility}</span>
        </div>
      )}

      <div className="color-swatches">
        {colorSwatchProps.map(prop => (
          <div key={prop.var} className="color-swatch">
            <div
              className="swatch-color"
              style={{ backgroundColor: colors[prop.var] || '#000' }}
              title={`${prop.label}: ${colors[prop.var]}`}
            />
            <span className="swatch-label">{prop.label}</span>
          </div>
        ))}
      </div>

      <div className="theme-card-actions">
        <button
          className={`preview-btn ${isDarkTheme ? 'active' : ''}`}
          onClick={onApplyDark}
          disabled={isDarkTheme}
        >
          {isDarkTheme ? t('theme_management.dark_active') : t('theme_management.apply_dark')}
        </button>
        <button
          className={`preview-btn ${isLightTheme ? 'active' : ''}`}
          onClick={onApplyLight}
          disabled={isLightTheme}
        >
          {isLightTheme ? t('theme_management.light_active') : t('theme_management.apply_light')}
        </button>
      </div>
    </div>
  );
};
