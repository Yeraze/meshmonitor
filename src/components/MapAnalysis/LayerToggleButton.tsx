import { useState, type ReactNode } from 'react';

export interface LayerToggleButtonProps {
  label: string;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  lookbackHours?: number | null;
  lookbackOptions?: Array<number | null>;
  onLookbackChange?: (h: number | null) => void;
  loading?: boolean;
  errored?: boolean;
  /** When true the toggle can't be clicked (e.g. no own-node position, #3971). */
  disabled?: boolean;
  /** Tooltip shown on the button — useful to explain a disabled state. */
  title?: string;
  /** Icon rendered in place of the text label; `label` becomes the tooltip + accessible name. */
  icon?: ReactNode;
}

export default function LayerToggleButton({
  label,
  enabled,
  onToggle,
  lookbackHours,
  lookbackOptions,
  onLookbackChange,
  loading,
  errored,
  disabled,
  title,
  icon,
}: LayerToggleButtonProps) {
  const [popOpen, setPopOpen] = useState(false);
  const showChevron = !!lookbackOptions && !!onLookbackChange;

  return (
    <div className={`map-analysis-layer-btn-wrap ${errored ? 'errored' : ''}`}>
      <button
        type="button"
        onClick={() => onToggle(!enabled)}
        disabled={disabled}
        // Tooltip: the disabled-explanation title when given, otherwise the label
        // (so the icon-only button still tells you what it is on hover).
        title={title ?? label}
        aria-label={label}
        className={`map-analysis-layer-btn ${enabled ? 'active' : ''} ${icon ? 'icon-only' : ''}`}
      >
        {icon ?? label}
        {loading && <span className="map-analysis-layer-spinner" data-testid="layer-spinner" />}
      </button>
      {showChevron && (
        <span
          role="img"
          tabIndex={0}
          aria-label={`Configure ${label}`}
          className="map-analysis-layer-chevron"
          onClick={() => setPopOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setPopOpen((o) => !o);
            }
          }}
        >
          ▾
        </span>
      )}
      {popOpen && lookbackOptions && onLookbackChange && (
        <div className="map-analysis-layer-popover" role="dialog">
          <div className="map-analysis-popover-label">Lookback</div>
          {lookbackOptions.map((h) => (
            <button
              key={h ?? 'last'}
              type="button"
              className={lookbackHours === h ? 'selected' : ''}
              onClick={() => { onLookbackChange(h); setPopOpen(false); }}
            >
              {h === null ? 'Last' : `${h}h`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
