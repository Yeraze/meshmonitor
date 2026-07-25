import { UiIcon, type UiIconName } from '../icons';
import styles from './MapModeIndicator.module.css';

export interface MapModeIndicatorProps {
  /** Icon for the active mode. */
  icon: UiIconName;
  /** Short mode name, e.g. "Traceroute mode". */
  label: string;
  /** One-line explanation of how the mode changes clicking a node. */
  hint: string;
  /** Turns the mode off. Omit to render a non-dismissable indicator. */
  onDisable?: () => void;
  /** Accessible label/tooltip for the dismiss button. */
  disableLabel?: string;
}

/**
 * Persistent "this map is in a non-default click mode" banner (issue #4326).
 *
 * Rendered as a `BaseMap` sibling inside the relatively-positioned map
 * container, NOT inside the draggable Features panel — the whole point is
 * that it stays visible when that panel is collapsed or dragged away. Map
 * toggles that silently change what clicking a node does (today: "Show
 * Traceroute", which suppresses the node info popup for any node that has a
 * stored route) read as random behavior when the only evidence of the mode is
 * a checkbox the user can't see at click time.
 */
export function MapModeIndicator({
  icon,
  label,
  hint,
  onDisable,
  disableLabel,
}: MapModeIndicatorProps) {
  return (
    <div
      className={styles.indicator}
      data-testid="map-mode-indicator"
      role="status"
      aria-live="polite"
      title={hint}
    >
      <span className={styles.icon} aria-hidden="true">
        <UiIcon name={icon} size={15} />
      </span>
      <span className={styles.label}>{label}</span>
      <span className={styles.hint}>{hint}</span>
      {onDisable && (
        <button
          type="button"
          className={styles.disable}
          onClick={onDisable}
          title={disableLabel}
          aria-label={disableLabel}
        >
          <UiIcon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

export default MapModeIndicator;
