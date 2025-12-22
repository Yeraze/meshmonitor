import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

// OLED type options from protobufs
const OLED_TYPES = [
  { value: 0, label: 'AUTO' },
  { value: 1, label: 'SSD1306' },
  { value: 2, label: 'SH1106' },
  { value: 3, label: 'SH1107' },
  { value: 4, label: 'SH1107_128_128' },
];

// Display mode options from protobufs
const DISPLAY_MODES = [
  { value: 0, label: 'DEFAULT' },
  { value: 1, label: 'TWOCOLOR' },
  { value: 2, label: 'INVERTED' },
  { value: 3, label: 'COLOR' },
];

// Units options from protobufs
const UNITS_OPTIONS = [
  { value: 0, label: 'METRIC' },
  { value: 1, label: 'IMPERIAL' },
];

// Compass orientation options (0-7)
const COMPASS_ORIENTATION_OPTIONS = [
  { value: 0, label: '0 degrees' },
  { value: 1, label: '90 degrees CW' },
  { value: 2, label: '180 degrees' },
  { value: 3, label: '270 degrees CW' },
  { value: 4, label: '0 degrees (inverted)' },
  { value: 5, label: '90 degrees CW (inverted)' },
  { value: 6, label: '180 degrees (inverted)' },
  { value: 7, label: '270 degrees CW (inverted)' },
];

interface DisplayConfigSectionProps {
  // Screen settings
  screenOnSecs: number;
  setScreenOnSecs: (value: number) => void;
  autoScreenCarouselSecs: number;
  setAutoScreenCarouselSecs: (value: number) => void;
  flipScreen: boolean;
  setFlipScreen: (value: boolean) => void;
  // Display options
  units: number;
  setUnits: (value: number) => void;
  oled: number;
  setOled: (value: number) => void;
  displayMode: number;
  setDisplayMode: (value: number) => void;
  headingBold: boolean;
  setHeadingBold: (value: boolean) => void;
  // Motion/interaction
  wakeOnTapOrMotion: boolean;
  setWakeOnTapOrMotion: (value: boolean) => void;
  compassOrientation: number;
  setCompassOrientation: (value: number) => void;
  // UI state
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const DisplayConfigSection: React.FC<DisplayConfigSectionProps> = ({
  screenOnSecs,
  setScreenOnSecs,
  autoScreenCarouselSecs,
  setAutoScreenCarouselSecs,
  flipScreen,
  setFlipScreen,
  units,
  setUnits,
  oled,
  setOled,
  displayMode,
  setDisplayMode,
  headingBold,
  setHeadingBold,
  wakeOnTapOrMotion,
  setWakeOnTapOrMotion,
  compassOrientation,
  setCompassOrientation,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Convert seconds to human-readable format
  const formatDuration = (seconds: number): string => {
    if (seconds === 0) return t('display_config.always_on');
    if (seconds < 60) return `${seconds} ${t('common.seconds')}`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} ${t('common.minutes')}`;
    return `${Math.floor(seconds / 3600)} ${t('common.hours')}`;
  };

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('display_config.title')}
        <a
          href="https://meshmonitor.org/features/device#display-configuration"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('display_config.view_docs')}
        >
          ❓
        </a>
      </h3>

      {/* Screen On Seconds */}
      <div className="setting-item">
        <label htmlFor="screenOnSecs">
          {t('display_config.screen_on_secs')}
          <span className="setting-description">
            {t('display_config.screen_on_secs_description')}
            {screenOnSecs > 0 && (
              <span style={{ marginLeft: '0.5rem', color: '#89b4fa' }}>
                ({formatDuration(screenOnSecs)})
              </span>
            )}
          </span>
        </label>
        <input
          id="screenOnSecs"
          type="number"
          min="0"
          max="4294967295"
          value={screenOnSecs}
          onChange={(e) => setScreenOnSecs(parseInt(e.target.value) || 0)}
          className="setting-input"
          placeholder="60"
        />
      </div>

      {/* Auto Screen Carousel */}
      <div className="setting-item">
        <label htmlFor="autoScreenCarouselSecs">
          {t('display_config.auto_carousel')}
          <span className="setting-description">
            {t('display_config.auto_carousel_description')}
            {autoScreenCarouselSecs > 0 && (
              <span style={{ marginLeft: '0.5rem', color: '#89b4fa' }}>
                ({formatDuration(autoScreenCarouselSecs)})
              </span>
            )}
          </span>
        </label>
        <input
          id="autoScreenCarouselSecs"
          type="number"
          min="0"
          max="4294967295"
          value={autoScreenCarouselSecs}
          onChange={(e) => setAutoScreenCarouselSecs(parseInt(e.target.value) || 0)}
          className="setting-input"
          placeholder="0"
        />
      </div>

      {/* Flip Screen */}
      <div className="setting-item">
        <label htmlFor="flipScreen" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="flipScreen"
            type="checkbox"
            checked={flipScreen}
            onChange={(e) => setFlipScreen(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('display_config.flip_screen')}</div>
            <span className="setting-description">{t('display_config.flip_screen_description')}</span>
          </div>
        </label>
      </div>

      {/* Units */}
      <div className="setting-item">
        <label htmlFor="units">
          {t('display_config.units')}
          <span className="setting-description">{t('display_config.units_description')}</span>
        </label>
        <select
          id="units"
          value={units}
          onChange={(e) => setUnits(parseInt(e.target.value))}
          className="setting-input"
        >
          {UNITS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {/* Display Mode */}
      <div className="setting-item">
        <label htmlFor="displayMode">
          {t('display_config.display_mode')}
          <span className="setting-description">{t('display_config.display_mode_description')}</span>
        </label>
        <select
          id="displayMode"
          value={displayMode}
          onChange={(e) => setDisplayMode(parseInt(e.target.value))}
          className="setting-input"
        >
          {DISPLAY_MODES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {/* Heading Bold */}
      <div className="setting-item">
        <label htmlFor="headingBold" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="headingBold"
            type="checkbox"
            checked={headingBold}
            onChange={(e) => setHeadingBold(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('display_config.heading_bold')}</div>
            <span className="setting-description">{t('display_config.heading_bold_description')}</span>
          </div>
        </label>
      </div>

      {/* Wake on Tap/Motion */}
      <div className="setting-item">
        <label htmlFor="wakeOnTapOrMotion" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="wakeOnTapOrMotion"
            type="checkbox"
            checked={wakeOnTapOrMotion}
            onChange={(e) => setWakeOnTapOrMotion(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('display_config.wake_on_tap')}</div>
            <span className="setting-description">{t('display_config.wake_on_tap_description')}</span>
          </div>
        </label>
      </div>

      {/* Advanced Section Toggle */}
      <div className="setting-item">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="advanced-toggle-btn"
          style={{
            background: 'transparent',
            border: '1px solid var(--ctp-surface2)',
            color: 'var(--ctp-subtext0)',
            padding: '0.5rem 1rem',
            borderRadius: '4px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}
        >
          <span>{showAdvanced ? '▼' : '▶'}</span>
          {t('display_config.advanced_settings')}
        </button>
      </div>

      {/* Advanced Settings */}
      {showAdvanced && (
        <div className="advanced-section" style={{
          marginLeft: '1rem',
          paddingLeft: '1rem',
          borderLeft: '2px solid var(--ctp-surface2)'
        }}>
          {/* OLED Type */}
          <div className="setting-item">
            <label htmlFor="oled">
              {t('display_config.oled_type')}
              <span className="setting-description">{t('display_config.oled_type_description')}</span>
            </label>
            <select
              id="oled"
              value={oled}
              onChange={(e) => setOled(parseInt(e.target.value))}
              className="setting-input"
            >
              {OLED_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* Compass Orientation */}
          <div className="setting-item">
            <label htmlFor="compassOrientation">
              {t('display_config.compass_orientation')}
              <span className="setting-description">{t('display_config.compass_orientation_description')}</span>
            </label>
            <select
              id="compassOrientation"
              value={compassOrientation}
              onChange={(e) => setCompassOrientation(parseInt(e.target.value))}
              className="setting-input"
            >
              {COMPASS_ORIENTATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? t('common.saving') : t('display_config.save_button')}
      </button>
    </div>
  );
};

export default DisplayConfigSection;
