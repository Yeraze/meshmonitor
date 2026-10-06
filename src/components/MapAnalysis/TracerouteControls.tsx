import { useState } from 'react';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { NumberInput } from '../common/NumberInput';
import { getTracerouteOptions, type TracerouteLayerOptions } from '../../hooks/useMapAnalysisConfig';

const DIRECTIONS: Array<{ key: TracerouteLayerOptions['directionMode']; label: string }> = [
  { key: 'both', label: 'Both' },
  { key: 'outbound', label: 'Out' },
  { key: 'inbound', label: 'In' },
];

/**
 * Traceroute analysis controls (issue #3399): inbound/outbound direction filter,
 * focus-on-selected toggle, and weak-link filters (min occurrences, min SNR).
 * Rendered in the toolbar only while the traceroutes layer is enabled.
 */
export default function TracerouteControls() {
  const { config, setLayerOptions } = useMapAnalysisCtx();
  const opts = getTracerouteOptions(config);
  const [open, setOpen] = useState(false);

  const update = (patch: Partial<TracerouteLayerOptions>) =>
    setLayerOptions('traceroutes', patch as Record<string, unknown>);

  return (
    <div className="map-analysis-tr-controls">
      <button
        type="button"
        className="map-analysis-pill"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Traceroute filters ▾
      </button>
      {open && (
        <div className="map-analysis-tr-popover" role="dialog">
          <div className="map-analysis-popover-label">Direction (selected node)</div>
          <div className="map-analysis-tr-seg">
            {DIRECTIONS.map((d) => (
              <button
                key={d.key}
                type="button"
                className={opts.directionMode === d.key ? 'selected' : ''}
                onClick={() => update({ directionMode: d.key })}
              >
                {d.label}
              </button>
            ))}
          </div>

          <label className="map-analysis-tr-check">
            <input
              type="checkbox"
              checked={opts.scopeToSelectedNode}
              onChange={(e) => update({ scopeToSelectedNode: e.target.checked })}
            />
            Focus on selected node
          </label>

          <div className="map-analysis-popover-label">Min occurrences</div>
          <NumberInput
            integer
            min={1}
            className="map-analysis-tr-num"
            value={opts.minOccurrences}
            aria-label="Minimum occurrences"
            onChange={(v) => update({ minOccurrences: v })}
          />

          <div className="map-analysis-popover-label">Min SNR (dB)</div>
          <NumberInput
            allowEmpty
            step={1}
            className="map-analysis-tr-num"
            placeholder="off"
            value={opts.minSnr}
            aria-label="Minimum SNR in dB"
            onChange={(v) => update({ minSnr: v })}
          />
        </div>
      )}
    </div>
  );
}
