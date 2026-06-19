import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import {
  NODE_TYPE_CATEGORIES,
  NODE_TYPE_CATEGORY_META,
} from '../../utils/nodeTypeCategory';

/**
 * Popover of node-type checkboxes that show/hide map markers by role
 * (issue #3546). Mirrors {@link SourceMultiSelect}'s pill + popover pattern.
 * State lives in `config.nodeTypes`; a missing/true value means visible.
 */
export default function NodeTypeFilterControl() {
  const { config, setNodeTypeEnabled } = useMapAnalysisCtx();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const hidden = NODE_TYPE_CATEGORIES.filter((c) => config.nodeTypes[c] === false);
  const label =
    hidden.length === 0
      ? t('map.nodeType.allTypes', 'All node types')
      : t('map.nodeType.someHidden', '{{count}} type hidden', { count: hidden.length });

  return (
    <div className="map-analysis-source-select">
      <button type="button" onClick={() => setOpen((o) => !o)} className="map-analysis-pill">
        {label}
      </button>
      {open && (
        <div className="map-analysis-source-popover" role="dialog">
          {NODE_TYPE_CATEGORIES.map((c) => {
            const meta = NODE_TYPE_CATEGORY_META[c];
            return (
              <label key={c} className="map-analysis-source-row">
                <input
                  type="checkbox"
                  checked={config.nodeTypes[c] !== false}
                  onChange={(e) => setNodeTypeEnabled(c, e.target.checked)}
                />
                {t(meta.labelKey, meta.label)}
              </label>
            );
          })}
          {hidden.length > 0 && (
            <button
              type="button"
              onClick={() => hidden.forEach((c) => setNodeTypeEnabled(c, true))}
            >
              {t('map.nodeType.showAll', 'Show all')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
