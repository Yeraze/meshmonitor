import React, { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { UiIcon } from '../icons';
import layout from '../AutomationFormLayout.module.css';

interface PatternExamplesProps {
  onSelectPattern: (pattern: string) => void;
}

/*
 * Patterns, regexes, env var names and config snippets are literal syntax, so
 * they stay here in code and never go into a translated string. Translations
 * carry only the prose around them: descriptions are looked up by key, and the
 * tips reach the literals through <Trans> self-closing components.
 */

/** Clickable command cards: [pattern, description key]. */
const COMMAND_EXAMPLES: Array<[string, string]> = [
  ['weather, weather {location}, w {location}', 'examples_weather_command'],
  ['status, status {nodeid}', 'examples_status_command'],
  ['ping', 'examples_ping_command'],
  ['help, help {topic}', 'examples_help_command'],
];

interface PatternExample {
  pattern: string;
  descKey: string;
  /** Interpolation values for literals inside the description. */
  values?: Record<string, string>;
  titleKey?: string;
}

const PATTERN_GROUPS: Array<{ titleKey: string; items: PatternExample[] }> = [
  {
    titleKey: 'examples_group_node',
    items: [
      { pattern: 'node {nodeid:![a-f0-9]+}', descKey: 'examples_node_id', values: { example: '!a1b2c3d4' } },
      { pattern: 'node {nodenum:\\d+}', descKey: 'examples_node_number' },
      { pattern: 'channel {ch:\\d}', descKey: 'examples_channel_number' },
      { pattern: 'temp {value:\\d+}', descKey: 'examples_temperature' },
    ],
  },
  {
    titleKey: 'examples_group_location',
    items: [
      // Space, not comma, between the two: a top-level comma separates
      // patterns, so "{lat},{lon}" inserted as two patterns.
      { pattern: 'loc {lat:-?\\d+\\.?\\d*} {lon:-?\\d+\\.?\\d*}', descKey: 'examples_lat_lon' },
      { pattern: 'grid {square:[A-R]{2}\\d{2}[a-x]{2}}', descKey: 'examples_grid_square' },
      { pattern: 'zip {code:\\d{5}}', descKey: 'examples_zip_code' },
      { pattern: 'weather {location}', descKey: 'examples_location_name' },
    ],
  },
  {
    titleKey: 'examples_group_time',
    items: [
      { pattern: 'time', descKey: 'examples_current_time', values: { env: 'TZ' }, titleKey: 'examples_click_to_use_time' },
      { pattern: 'date', descKey: 'examples_current_date' },
    ],
  },
  {
    titleKey: 'examples_group_text',
    items: [
      { pattern: 'msg {text:[\\w\\s]+}', descKey: 'examples_multiple_words' },
      { pattern: 'say {text:.+}', descKey: 'examples_any_text' },
      { pattern: 'alert {message}', descKey: 'examples_alert_message' },
      { pattern: 'log {data:[a-zA-Z0-9]+}', descKey: 'examples_alphanumeric' },
    ],
  },
  {
    titleKey: 'examples_group_numeric',
    items: [
      { pattern: 'set {value:-?\\d+}', descKey: 'examples_signed_integer' },
      { pattern: 'battery {level:\\d{1,3}}', descKey: 'examples_battery_level' },
      { pattern: 'rssi {dbm:-?\\d+}', descKey: 'examples_rssi' },
      { pattern: 'snr {value:-?\\d+}', descKey: 'examples_snr' },
    ],
  },
];

const cardStyle: React.CSSProperties = {
  padding: '0.4rem 0.6rem',
  background: 'var(--color-surface-hover)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: '4px',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'monospace',
  fontSize: '0.8rem',
  color: 'var(--color-text)',
  transition: 'all 0.2s'
};

const patternCodeStyle: React.CSSProperties = {
  background: 'var(--color-surface-active)',
  padding: '2px 6px',
  borderRadius: '3px',
  cursor: 'pointer'
};

const tipCodeStyle: React.CSSProperties = {
  background: 'var(--color-surface-active)',
  padding: '2px 4px',
  borderRadius: '2px'
};

/** A literal shown inside a translated tip. */
const lit = (text: string, style: React.CSSProperties = tipCodeStyle) => <code style={style}>{text}</code>;

const PatternExamples: React.FC<PatternExamplesProps> = ({ onSelectPattern }) => {
  const { t } = useTranslation();
  const [showExamples, setShowExamples] = useState(false);

  return (
    <div style={{
      marginBottom: '1.5rem',
      marginLeft: '1.75rem',
      marginRight: '1.75rem',
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border-subtle)',
      borderRadius: '6px',
      overflow: 'hidden'
    }}>
      <button
        onClick={() => setShowExamples(!showExamples)}
        style={{
          width: '100%',
          padding: '0.75rem 1rem',
          background: 'var(--color-surface-hover)',
          border: 'none',
          borderBottom: showExamples ? '1px solid var(--color-border-subtle)' : 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '0.9rem',
          fontWeight: 'bold',
          color: 'var(--color-accent)'
        }}
      >
        <span><UiIcon name="sparkles" size={15} /> {t('auto_responder.examples_title')}</span>
        <UiIcon name={showExamples ? 'chevronDown' : 'forward'} size={17} />
      </button>
      {showExamples && (
        <div style={{ padding: '1rem', fontSize: '0.85rem' }}>
          {/* Common Meshtastic Commands */}
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ fontWeight: 'bold', color: 'var(--color-accent)', marginBottom: '0.5rem', fontSize: '0.9rem' }}>
              <UiIcon name="radio" size={15} /> {t('auto_responder.examples_common_commands')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
              {COMMAND_EXAMPLES.map(([pattern, descKey]) => (
                <button
                  key={pattern}
                  className={layout.scrollTarget}
                  onClick={() => onSelectPattern(pattern)}
                  style={cardStyle}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--color-surface-active)';
                    e.currentTarget.style.borderColor = 'var(--color-accent)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--color-surface-hover)';
                    e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
                  }}
                  title={t('auto_responder.examples_click_to_use_pattern')}
                >
                  <code style={{ color: 'var(--color-accent)' }}>{pattern}</code>
                  <div style={{ fontSize: '0.7rem', color: 'var(--color-text-subtle)', marginTop: '0.2rem' }}>{t(`auto_responder.${descKey}`)}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Regex Pattern Examples */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', fontFamily: 'monospace' }}>
            {PATTERN_GROUPS.map((group) => (
              <div key={group.titleKey}>
                <div style={{ fontWeight: 'bold', color: 'var(--color-accent-alt)', marginBottom: '0.5rem' }}>{t(`auto_responder.${group.titleKey}`)}</div>
                <div style={{ lineHeight: '1.8', fontSize: '0.8rem' }}>
                  {group.items.map((item) => (
                    <div key={item.pattern}>
                      <code
                        className={layout.scrollTarget}
                        style={patternCodeStyle}
                        onClick={() => onSelectPattern(item.pattern)}
                        title={t(`auto_responder.${item.titleKey ?? 'examples_click_to_use'}`)}
                      >{item.pattern}</code>
                      {' '}- {t(`auto_responder.${item.descKey}`, item.values)}
                    </div>
                  ))}
                  {group.titleKey === 'examples_group_time' && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-subtle)', marginTop: '0.3rem', fontStyle: 'italic' }}>
                      <UiIcon name="info" size={13} />{' '}
                      <Trans
                        i18nKey="auto_responder.examples_tz_note"
                        components={{ env: lit('TZ', { background: 'var(--color-surface-hover)', padding: '1px 3px', borderRadius: '2px' }) }}
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div style={{
            marginTop: '1rem',
            paddingTop: '1rem',
            borderTop: '1px solid var(--color-border-subtle)',
            color: 'var(--color-text-subtle)',
            fontSize: '0.8rem',
            lineHeight: '1.6'
          }}>
            <strong><UiIcon name="info" size={13} /> {t('auto_responder.examples_tips_title')}</strong><br/>
            • <Trans i18nKey="auto_responder.examples_tip_click" components={{ b: <strong /> }} /><br/>
            • <Trans i18nKey="auto_responder.examples_tip_default_param" components={{ example: lit('{param}') }} /><br/>
            • <Trans i18nKey="auto_responder.examples_tip_regex_param" components={{ example: lit('{param:regex}') }} /><br/>
            • <Trans i18nKey="auto_responder.examples_tip_multiple" components={{ example: lit('pattern1, pattern2 {param}') }} /><br/>
            • <Trans i18nKey="auto_responder.examples_tip_default_pattern" components={{ example: lit('[^\\s]+') }} /><br/>
            • <Trans i18nKey="auto_responder.examples_tip_multiple_words" components={{ example: lit('[\\w\\s]+') }} /><br/>
            • <Trans i18nKey="auto_responder.examples_tip_escape" components={{ example: lit('\\ . + * ? ^ $ { } [ ] ( ) |') }} /><br/>
            • <Trans
              i18nKey="auto_responder.examples_tip_timezone"
              components={{ b: <strong />, env: lit('TZ'), setting: lit('TZ=America/New_York'), file: lit('docker-compose.yaml') }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default PatternExamples;
