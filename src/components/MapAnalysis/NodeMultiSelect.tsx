import { useState } from 'react';

export interface NodeMultiSelectProps {
  nodes: Array<{ key: string; label: string }>;
  value: string[];
  onChange: (next: string[]) => void;
}

/**
 * Node picker for the Map Analysis toolbar (issue #3788 WP-B/C). Mirrors
 * {@link SourceMultiSelect}'s pill + popover pattern — same CSS classes, no
 * new styling. `value`/`onChange` hold the `mt:`/`mc:` unified node keys
 * (see `src/utils/nodeIdentity.ts`); a non-empty selection dims unselected
 * markers/trails elsewhere on the map.
 */
export default function NodeMultiSelect({ nodes, value, onChange }: NodeMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const label = value.length === 0 ? 'All nodes' : `${value.length} selected`;

  function toggle(key: string) {
    onChange(value.includes(key) ? value.filter((v) => v !== key) : [...value, key]);
  }

  return (
    <div className="map-analysis-source-select">
      <button type="button" onClick={() => setOpen((o) => !o)} className="map-analysis-pill">
        {label}
      </button>
      {open && (
        <div className="map-analysis-source-popover" role="dialog">
          {nodes.map((n) => (
            <label key={n.key} className="map-analysis-source-row">
              <input
                type="checkbox"
                checked={value.includes(n.key)}
                onChange={() => toggle(n.key)}
              />
              {n.label}
            </label>
          ))}
          <button type="button" onClick={() => onChange(nodes.map((n) => n.key))}>
            Select all
          </button>
          {value.length > 0 && (
            <button type="button" onClick={() => onChange([])}>Clear</button>
          )}
        </div>
      )}
    </div>
  );
}
