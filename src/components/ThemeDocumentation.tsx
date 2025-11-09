import React, { useState } from 'react';
import { useSettings, type Theme } from '../contexts/SettingsContext';
import './ThemeDocumentation.css';

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
  const { theme: currentTheme, setTheme } = useSettings();
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const filteredThemes = selectedCategory === 'all'
    ? themes
    : themes.filter(t => t.category === selectedCategory);

  const categories = [
    { id: 'all', name: 'All Themes' },
    { id: 'catppuccin', name: 'Catppuccin' },
    { id: 'popular', name: 'Popular' },
    { id: 'high-contrast', name: 'High Contrast' },
    { id: 'colorblind', name: 'Color Blind Friendly' }
  ];

  return (
    <div className="theme-documentation">
      <div className="theme-doc-header">
        <h2>Theme Gallery</h2>
        <p>
          Choose from {themes.length} carefully crafted themes including accessibility-focused options.
          Click on any theme card to preview it instantly!
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
            isActive={currentTheme === themeInfo.id}
            onSelect={() => setTheme(themeInfo.id)}
          />
        ))}
      </div>

      <div className="theme-doc-footer">
        <h3>Accessibility Information</h3>
        <div className="accessibility-info">
          <div className="info-section">
            <h4>High Contrast Themes</h4>
            <p>
              Our high-contrast themes provide maximum readability with WCAG AAA compliance.
              Perfect for users with low vision or anyone who prefers stronger color differentiation.
            </p>
          </div>
          <div className="info-section">
            <h4>Color Blind Friendly Themes</h4>
            <p>
              We offer three specialized themes for different types of color blindness:
            </p>
            <ul>
              <li><strong>Protanopia:</strong> For red color blindness (affects ~1% of males)</li>
              <li><strong>Deuteranopia:</strong> For green color blindness (affects ~1% of males)</li>
              <li><strong>Tritanopia:</strong> For blue color blindness (rare, affects ~0.001%)</li>
            </ul>
          </div>
          <div className="info-section">
            <h4>Theme Persistence</h4>
            <p>
              Your theme choice is saved automatically and will persist across sessions.
              All themes work seamlessly across all pages and components.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

interface ThemeCardProps {
  themeInfo: ThemeInfo;
  isActive: boolean;
  onSelect: () => void;
}

const ThemeCard: React.FC<ThemeCardProps> = ({ themeInfo, isActive, onSelect }) => {
  const [colors, setColors] = useState<Record<string, string>>({});

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
      className={`theme-card ${isActive ? 'active' : ''}`}
      onClick={onSelect}
    >
      <div className="theme-card-header">
        <h3>{themeInfo.name}</h3>
        {isActive && <span className="current-badge">Current</span>}
      </div>

      <p className="theme-description">{themeInfo.description}</p>

      {themeInfo.accessibility && (
        <div className="accessibility-badge">
          <span className="badge-icon">♿</span>
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

      <button className="preview-btn" onClick={onSelect}>
        {isActive ? 'Active' : 'Preview'}
      </button>
    </div>
  );
};
