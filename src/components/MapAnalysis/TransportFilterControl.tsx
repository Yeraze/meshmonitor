import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapAnalysisCtx } from './MapAnalysisContext';

/**
 * Popover of Show RF / UDP / MQTT checkboxes that show/hide map markers by the
 * node's transport class (issue #4129). Mirrors {@link NodeTypeFilterControl}'s
 * pill + popover pattern and drives `config.transports`; the filtering itself
 * lives in `useAnalysisNodes` via the shared `nodePassesTransportFilter`, the
 * same classifier the Dashboard/NodesTab "Show RF/UDP/MQTT" toggles use.
 */
const TRANSPORTS: Array<{ key: 'rf' | 'udp' | 'mqtt'; labelKey: string; label: string }> = [
  { key: 'rf', labelKey: 'map.transport.rf', label: 'Show RF' },
  { key: 'udp', labelKey: 'map.transport.udp', label: 'Show UDP' },
  { key: 'mqtt', labelKey: 'map.transport.mqtt', label: 'Show MQTT' },
];

export default function TransportFilterControl() {
  const { config, setTransportEnabled } = useMapAnalysisCtx();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const hidden = TRANSPORTS.filter((tr) => config.transports[tr.key] === false);
  const label =
    hidden.length === 0
      ? t('map.transport.all', 'All transports')
      : t('map.transport.someHidden', '{{count}} transport hidden', { count: hidden.length });

  return (
    <div className="map-analysis-source-select">
      <button type="button" onClick={() => setOpen((o) => !o)} className="map-analysis-pill">
        {label}
      </button>
      {open && (
        <div className="map-analysis-source-popover" role="dialog">
          {TRANSPORTS.map((tr) => (
            <label key={tr.key} className="map-analysis-source-row">
              <input
                type="checkbox"
                checked={config.transports[tr.key] !== false}
                onChange={(e) => setTransportEnabled(tr.key, e.target.checked)}
              />
              {t(tr.labelKey, tr.label)}
            </label>
          ))}
          {hidden.length > 0 && (
            <button
              type="button"
              onClick={() => hidden.forEach((tr) => setTransportEnabled(tr.key, true))}
            >
              {t('map.transport.showAll', 'Show all')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
