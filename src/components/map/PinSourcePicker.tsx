/**
 * PinSourcePicker — which source a new map pin belongs to (#5685).
 *
 * Map Analysis shows many sources at once, so a new waypoint or local marker
 * has no implied source. With several candidates the user must choose: there
 * is no default, because for a waypoint the choice decides which radio
 * transmits. With one candidate, or when editing, the source is shown as text.
 */
import styles from './PinSourcePicker.module.css';

export interface PinSourceOption {
  id: string;
  name: string;
}

export interface PinSourceChoice {
  options: PinSourceOption[];
  value: string | null;
  /** Omit to show the source read-only (edit mode). */
  onChange?: (sourceId: string) => void;
  /** The chosen source is filtered out of the map, so the pin will not show yet. */
  hiddenByFilter?: boolean;
}

export default function PinSourcePicker({ id, label, placeholder, hint, hiddenNote, choice }: {
  id: string;
  label: string;
  placeholder: string;
  hint: string;
  hiddenNote: string;
  choice: PinSourceChoice;
}) {
  const { options, value, onChange, hiddenByFilter } = choice;
  const selected = options.find((o) => o.id === value) ?? null;
  const pickable = Boolean(onChange) && options.length > 1;
  return (
    <div className={styles.picker} data-testid="pin-source-picker">
      <label className={styles.label} htmlFor={pickable ? id : undefined}>{label}</label>
      {pickable ? (
        <select
          id={id}
          className={styles.select}
          value={value ?? ''}
          onChange={(e) => { if (e.target.value) onChange?.(e.target.value); }}
        >
          <option value="" disabled>{placeholder}</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      ) : (
        <div className={styles.fixed} data-testid="pin-source-fixed">{selected?.name ?? value ?? placeholder}</div>
      )}
      <span className={styles.hint}>{hint}</span>
      {hiddenByFilter && value && <span className={styles.warn} role="note">{hiddenNote}</span>}
    </div>
  );
}
