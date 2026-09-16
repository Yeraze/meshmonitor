/**
 * Hop-limit override picker for automated sends (#5121), shared by the
 * Auto-Announce and Auto-Acknowledge sections.
 *
 * Value is the settings string form: `''` inherits the node's own hop limit,
 * `'0'`–`'7'` pins it. The server caps any value at the node's configured hop
 * limit, so the copy says the override only ever shortens reach.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { HOP_LIMIT_OVERRIDE_MAX } from '../utils/hopLimitOverride';

export interface HopLimitOverrideSelectProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** What a zero-hop send gives up in this context, shown when 0 is chosen. */
  zeroHopNote?: string;
}

export const HopLimitOverrideSelect: React.FC<HopLimitOverrideSelectProps> = ({
  id,
  value,
  onChange,
  disabled,
  zeroHopNote,
}) => {
  const { t } = useTranslation();
  return (
    <div style={{ marginTop: '1rem' }}>
      <label htmlFor={id} style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
        {t('automation.hop_limit_override.label', 'Hop limit')}
      </label>
      <div style={{ marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--color-text-subtle)' }}>
        {t(
          'automation.hop_limit_override.description',
          "How far this automated message may travel. Capped at the node's own hop limit, so it can only shorten reach, never extend it. 0 keeps it to nodes that hear this radio directly.",
        )}
      </div>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ padding: '2px 4px' }}
      >
        <option value="">{t('automation.hop_limit_override.inherit', "Inherit (the node's own hop limit)")}</option>
        <option value="0">{t('automation.hop_limit_override.zero', '0 — local only, no relay')}</option>
        {Array.from({ length: HOP_LIMIT_OVERRIDE_MAX }, (_, i) => i + 1).map((n) => (
          <option key={n} value={String(n)}>
            {n}
          </option>
        ))}
      </select>
      {value === '0' && zeroHopNote && (
        <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--color-caution)' }}>
          {zeroHopNote}
        </div>
      )}
    </div>
  );
};

export default HopLimitOverrideSelect;
