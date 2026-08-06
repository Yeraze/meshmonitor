import React, { useState } from 'react';
import { UiIcon } from '../icons';

interface PatternExamplesProps {
  onSelectPattern: (pattern: string) => void;
}

const PatternExamples: React.FC<PatternExamplesProps> = ({ onSelectPattern }) => {
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
        <span><UiIcon name="sparkles" size={15} /> Pattern Examples & Templates</span>
        <UiIcon name={showExamples ? 'chevronDown' : 'forward'} size={17} />
      </button>
      {showExamples && (
        <div style={{ padding: '1rem', fontSize: '0.85rem' }}>
          {/* Common Meshtastic Commands */}
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ fontWeight: 'bold', color: 'var(--color-accent)', marginBottom: '0.5rem', fontSize: '0.9rem' }}>
              <UiIcon name="radio" size={15} /> Common Meshtastic Commands
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <button
                onClick={() => onSelectPattern('weather, weather {location}, w {location}')}
                style={{
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
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-surface-active)';
                  e.currentTarget.style.borderColor = 'var(--color-accent)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--color-surface-hover)';
                  e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
                }}
                title="Click to use this pattern"
              >
                <code style={{ color: 'var(--color-accent)' }}>weather, weather {`{location}`}, w {`{location}`}</code>
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-subtle)', marginTop: '0.2rem' }}>Multi-pattern weather command</div>
              </button>
              <button
                onClick={() => onSelectPattern('status, status {nodeid}')}
                style={{
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
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-surface-active)';
                  e.currentTarget.style.borderColor = 'var(--color-accent)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--color-surface-hover)';
                  e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
                }}
                title="Click to use this pattern"
              >
                <code style={{ color: 'var(--color-accent)' }}>status, status {`{nodeid}`}</code>
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-subtle)', marginTop: '0.2rem' }}>Node status check</div>
              </button>
              <button
                onClick={() => onSelectPattern('ping')}
                style={{
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
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-surface-active)';
                  e.currentTarget.style.borderColor = 'var(--color-accent)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--color-surface-hover)';
                  e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
                }}
                title="Click to use this pattern"
              >
                <code style={{ color: 'var(--color-accent)' }}>ping</code>
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-subtle)', marginTop: '0.2rem' }}>Simple ping command</div>
              </button>
              <button
                onClick={() => onSelectPattern('help, help {topic}')}
                style={{
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
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-surface-active)';
                  e.currentTarget.style.borderColor = 'var(--color-accent)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--color-surface-hover)';
                  e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
                }}
                title="Click to use this pattern"
              >
                <code style={{ color: 'var(--color-accent)' }}>help, help {`{topic}`}</code>
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-subtle)', marginTop: '0.2rem' }}>Help system</div>
              </button>
            </div>
          </div>

          {/* Regex Pattern Examples */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', fontFamily: 'monospace' }}>
            <div>
              <div style={{ fontWeight: 'bold', color: 'var(--color-accent-alt)', marginBottom: '0.5rem' }}>Node & Network Patterns</div>
              <div style={{ lineHeight: '1.8', fontSize: '0.8rem' }}>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('node {nodeid:![a-f0-9]+}')}
                    title="Click to use"
                  >node {`{nodeid:![a-f0-9]+}`}</code>
                  {' '}- Meshtastic node ID (e.g., !a1b2c3d4)
                </div>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('node {nodenum:\\d+}')}
                    title="Click to use"
                  >node {`{nodenum:\\d+}`}</code>
                  {' '}- Node number (integer)
                </div>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('channel {ch:\\d}')}
                    title="Click to use"
                  >channel {`{ch:\\d}`}</code>
                  {' '}- Channel number (0-7)
                </div>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('temp {value:\\d+}')}
                    title="Click to use"
                  >temp {`{value:\\d+}`}</code>
                  {' '}- Temperature value (integer)
                </div>
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 'bold', color: 'var(--color-accent-alt)', marginBottom: '0.5rem' }}>Location & Coordinates</div>
              <div style={{ lineHeight: '1.8', fontSize: '0.8rem' }}>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('loc {lat:-?\\d+\\.?\\d*},{lon:-?\\d+\\.?\\d*}')}
                    title="Click to use"
                  >loc {`{lat:-?\\d+\\.?\\d*}`},{`{lon:-?\\d+\\.?\\d*}`}</code>
                  {' '}- Latitude/longitude
                </div>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('grid {square:[A-R]{2}\\d{2}[a-x]{2}}')}
                    title="Click to use"
                  >grid {`{square:[A-R]{2}\\d{2}[a-x]{2}}`}</code>
                  {' '}- Maidenhead grid square
                </div>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('zip {code:\\d{5}}')}
                    title="Click to use"
                  >zip {`{code:\\d{5}}`}</code>
                  {' '}- 5-digit zip code
                </div>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('weather {location}')}
                    title="Click to use"
                  >weather {`{location}`}</code>
                  {' '}- Location name (default: any text)
                </div>
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 'bold', color: 'var(--color-accent-alt)', marginBottom: '0.5rem' }}>Time & Date</div>
              <div style={{ lineHeight: '1.8', fontSize: '0.8rem' }}>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('time')}
                    title="Click to use - Scripts receive TZ env var for timezone-aware time"
                  >time</code>
                  {' '}- Current time (timezone-aware via TZ env var)
                </div>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('date')}
                    title="Click to use"
                  >date</code>
                  {' '}- Current date (timezone-aware)
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-subtle)', marginTop: '0.3rem', fontStyle: 'italic' }}>
                  <UiIcon name="info" size={13} /> Scripts can access <code style={{ background: 'var(--color-surface-hover)', padding: '1px 3px', borderRadius: '2px' }}>TZ</code> environment variable for server's configured timezone
                </div>
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 'bold', color: 'var(--color-accent-alt)', marginBottom: '0.5rem' }}>Text & Messages</div>
              <div style={{ lineHeight: '1.8', fontSize: '0.8rem' }}>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('msg {text:[\\w\\s]+}')}
                    title="Click to use"
                  >msg {`{text:[\\w\\s]+}`}</code>
                  {' '}- Multiple words (letters, numbers, spaces)
                </div>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('say {text:.+}')}
                    title="Click to use"
                  >say {`{text:.+}`}</code>
                  {' '}- Any text (including punctuation)
                </div>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('alert {message}')}
                    title="Click to use"
                  >alert {`{message}`}</code>
                  {' '}- Alert message (default: single word)
                </div>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('log {data:[a-zA-Z0-9]+}')}
                    title="Click to use"
                  >log {`{data:[a-zA-Z0-9]+}`}</code>
                  {' '}- Alphanumeric data
                </div>
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 'bold', color: 'var(--color-accent-alt)', marginBottom: '0.5rem' }}>Numeric & Data</div>
              <div style={{ lineHeight: '1.8', fontSize: '0.8rem' }}>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('set {value:-?\\d+}')}
                    title="Click to use"
                  >set {`{value:-?\\d+}`}</code>
                  {' '}- Positive/negative integer
                </div>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('battery {level:\\d{1,3}}')}
                    title="Click to use"
                  >battery {`{level:\\d{1,3}}`}</code>
                  {' '}- Battery level (0-100)
                </div>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('rssi {dbm:-?\\d+}')}
                    title="Click to use"
                  >rssi {`{dbm:-?\\d+}`}</code>
                  {' '}- RSSI value (can be negative)
                </div>
                <div>
                  <code style={{ background: 'var(--color-surface-active)', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer' }}
                    onClick={() => onSelectPattern('snr {value:-?\\d+}')}
                    title="Click to use"
                  >snr {`{value:-?\\d+}`}</code>
                  {' '}- SNR value
                </div>
              </div>
            </div>
          </div>
          <div style={{
            marginTop: '1rem',
            paddingTop: '1rem',
            borderTop: '1px solid var(--color-border-subtle)',
            color: 'var(--color-text-subtle)',
            fontSize: '0.8rem',
            lineHeight: '1.6'
          }}>
            <strong><UiIcon name="info" size={13} /> Quick Tips:</strong><br/>
            • <strong>Click any pattern</strong> above to insert it into the trigger field<br/>
            • Use <code style={{ background: 'var(--color-surface-active)', padding: '2px 4px', borderRadius: '2px' }}>{`{param}`}</code> for default matching (single word, no spaces)<br/>
            • Use <code style={{ background: 'var(--color-surface-active)', padding: '2px 4px', borderRadius: '2px' }}>{`{param:regex}`}</code> for custom regex patterns<br/>
            • Separate multiple patterns with commas: <code style={{ background: 'var(--color-surface-active)', padding: '2px 4px', borderRadius: '2px' }}>pattern1, pattern2 {`{param}`}</code><br/>
            • Default pattern <code style={{ background: 'var(--color-surface-active)', padding: '2px 4px', borderRadius: '2px' }}>[^\\s]+</code> matches any single word (no spaces)<br/>
            • Use <code style={{ background: 'var(--color-surface-active)', padding: '2px 4px', borderRadius: '2px' }}>[\\w\\s]+</code> for multiple words with spaces<br/>
            • Escape special regex characters: <code style={{ background: 'var(--color-surface-active)', padding: '2px 4px', borderRadius: '2px' }}>\ . + * ? ^ $ {'{ }'} [ ] ( ) |</code><br/>
            • <strong>Timezone Support:</strong> Scripts receive <code style={{ background: 'var(--color-surface-active)', padding: '2px 4px', borderRadius: '2px' }}>TZ</code> environment variable for timezone-aware time (configure via <code style={{ background: 'var(--color-surface-active)', padding: '2px 4px', borderRadius: '2px' }}>TZ=America/New_York</code> in docker-compose.yaml)
          </div>
        </div>
      )}
    </div>
  );
};

export default PatternExamples;
