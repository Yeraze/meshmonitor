import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import styles from './ToolbarMenu.module.css';

export interface ToolbarMenuProps {
  /** Short menu label shown on the trigger, e.g. "View", "Layers". */
  label: string;
  /** Leading icon on the trigger. */
  icon: ReactNode;
  /**
   * Number of currently-active items in this group. Rendered as a badge and
   * used to highlight the trigger, so a user can still see at a glance that a
   * grouped layer is on without opening the menu (#4871 discoverability).
   */
  activeCount?: number;
  /** Menu rows — normally `ToolbarMenuItem`s. */
  children: ReactNode;
}

/**
 * A labeled dropdown that groups a set of related toolbar controls behind one
 * trigger button, to keep the Map Analysis toolbar on a single row on narrow
 * screens (#4871). Closes on outside-click and Escape. The trigger shows an
 * active-count badge so grouping doesn't hide which layers are on.
 */
export default function ToolbarMenu({ label, icon, activeCount = 0, children }: ToolbarMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = activeCount > 0;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.trigger} ${active ? styles.active : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
      >
        <span className={styles.icon}>{icon}</span>
        <span>{label}</span>
        {active && <span className={styles.badge} aria-label={`${activeCount} active`}>{activeCount}</span>}
        <ChevronDown size={12} className={styles.caret} aria-hidden />
      </button>
      {open && (
        <div className={styles.panel} role="menu">
          {children}
        </div>
      )}
    </div>
  );
}

export interface ToolbarMenuItemProps {
  icon: ReactNode;
  label: string;
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** Tooltip — usually an explanation of a disabled state. */
  title?: string;
  loading?: boolean;
  /** Timed-layer lookback: current value, options, and setter. Omit for plain toggles. */
  lookbackHours?: number | null;
  lookbackOptions?: Array<number | null>;
  onLookbackChange?: (h: number | null) => void;
}

/**
 * One toggle row inside a {@link ToolbarMenu}. Clicking the row toggles the
 * item; a trailing check marks the active state. Timed layers get an inline
 * lookback `<select>` (clicks on it don't toggle the row).
 */
export function ToolbarMenuItem({
  icon,
  label,
  active,
  onToggle,
  disabled = false,
  title,
  loading = false,
  lookbackHours,
  lookbackOptions,
  onLookbackChange,
}: ToolbarMenuItemProps) {
  const showLookback = !!lookbackOptions && !!onLookbackChange;
  return (
    <div
      role="menuitemcheckbox"
      aria-checked={active}
      aria-disabled={disabled}
      aria-label={label}
      className={`${styles.item} ${active ? styles.itemActive : ''} ${disabled ? styles.itemDisabled : ''}`}
      title={title ?? label}
      onClick={() => { if (!disabled) onToggle(); }}
    >
      <span className={styles.itemIcon}>{icon}</span>
      <span className={styles.itemLabel}>{label}</span>
      {loading && <span className={styles.spinner} data-testid="layer-spinner" />}
      {showLookback && (
        <select
          className={styles.lookback}
          value={lookbackHours === null || lookbackHours === undefined ? 'last' : String(lookbackHours)}
          disabled={disabled}
          // Don't let interacting with the lookback toggle the row.
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const v = e.target.value;
            onLookbackChange!(v === 'last' ? null : Number(v));
          }}
          aria-label={`${label} lookback`}
        >
          {lookbackOptions!.map((h) => (
            <option key={h ?? 'last'} value={h === null ? 'last' : String(h)}>
              {h === null ? 'Last' : `${h}h`}
            </option>
          ))}
        </select>
      )}
      <span className={styles.check}>{active && <Check size={14} />}</span>
    </div>
  );
}
