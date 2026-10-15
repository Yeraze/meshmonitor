/**
 * PresetPicker — one look for every broker preset list (#5831, part of #5797).
 *
 * A labelled row of chips. Each form keeps its own preset data and decides
 * what a pick does; this component only draws the chips and reports the pick.
 *
 *   select mode  pass `selectedId`: one chip is marked pressed (the preset the
 *                form's values match, or the "Custom…" chip). The Meshtastic
 *                broker presets use this.
 *   add mode     leave `selectedId` out: every chip adds something (shown with
 *                a plus). The Analyzer Observer broker list uses this.
 *
 * Picking a chip never saves anything: the form's own Save does that.
 */
import React, { useId } from 'react';
import { UiIcon } from '../../icons';
import styles from './PresetPicker.module.css';

export interface PresetPickerOption {
  /** Stable handle; written to `data-preset-id`. */
  id: string;
  label: string;
  /** Tooltip, e.g. the broker URL the chip fills in. */
  title?: string;
}

export interface PresetPickerProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  options: readonly PresetPickerOption[];
  /** Select mode: the chip shown as chosen, or null for none. Omit for add mode. */
  selectedId?: string | null;
  onPick: (id: string) => void;
  disabled?: boolean;
  /** Notes drawn under the chips (kept credentials, privacy, …). */
  children?: React.ReactNode;
  'data-testid'?: string;
  className?: string;
}

export const PresetPicker: React.FC<PresetPickerProps> = ({
  label,
  description,
  options,
  selectedId,
  onPick,
  disabled = false,
  children,
  className,
  'data-testid': testId,
}) => {
  const labelId = useId();
  const addMode = selectedId === undefined;
  return (
    <div className={className ? `${styles.picker} ${className}` : styles.picker} data-testid={testId}>
      <div id={labelId} className={styles.label}>
        {label}
      </div>
      {description && <p className={styles.description}>{description}</p>}
      <div className={styles.chips} role="group" aria-labelledby={labelId}>
        {options.map((o) => {
          const pressed = !addMode && o.id === selectedId;
          return (
            <button
              key={o.id}
              type="button"
              className={pressed ? `${styles.chip} ${styles.chipSelected}` : styles.chip}
              data-preset-id={o.id}
              aria-pressed={addMode ? undefined : pressed}
              title={o.title}
              disabled={disabled}
              onClick={() => onPick(o.id)}
            >
              {addMode && <UiIcon name="plus" size={12} />}
              {o.label}
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
};

export default PresetPicker;
