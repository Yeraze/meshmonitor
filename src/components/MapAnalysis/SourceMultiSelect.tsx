import { useState } from 'react';

export interface SourceMultiSelectProps {
  sources: Array<{ id: string; name: string }>;
  value: string[];
  onChange: (next: string[]) => void;
}

export default function SourceMultiSelect({ sources, value, onChange }: SourceMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const label = value.length === 0
    ? `All sources (${sources.length})`
    : `${value.length} sources`;

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  return (
    <div className="map-analysis-source-select">
      <button type="button" onClick={() => setOpen((o) => !o)} className="map-analysis-pill">
        {label}
      </button>
      {open && (
        <div className="map-analysis-source-popover" role="dialog">
          {sources.map((s) => (
            <label key={s.id} className="map-analysis-source-row">
              <input
                type="checkbox"
                checked={value.includes(s.id)}
                onChange={() => toggle(s.id)}
              />
              {s.name}
            </label>
          ))}
          {value.length > 0 && (
            <button type="button" onClick={() => onChange([])}>Clear</button>
          )}
        </div>
      )}
    </div>
  );
}
