import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { useVisibleNodeTypeCategories } from './useVisibleNodeTypeCategories';
import { NODE_TYPE_CATEGORY_META } from '../../utils/nodeTypeCategory';

/**
 * Popover of node-type checkboxes that show/hide map markers by role
 * (issue #3546). Mirrors {@link SourceMultiSelect}'s pill + popover pattern.
 * State lives in `config.nodeTypes`; a missing/true value means visible.
 *
 * The list of categories adapts to the connected source types (issue #3610):
 * a Meshtastic-only instance gets Meshtastic role categories, MeshCore-only
 * gets the MeshCore categories, and a mixed instance gets the union. The
 * persisted toggle map still keys on stable category names, so a hidden
 * category that drops out of scope is simply inert (default visible) and never
 * permanently hides a node when the source mix changes.
 */
export default function NodeTypeFilterControl() {
  const { config, setNodeTypeEnabled } = useMapAnalysisCtx();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const categories = useVisibleNodeTypeCategories();

  // Only count toggles for categories that are currently shown, so the pill
  // label reflects what the user can actually see/change.
  const hidden = categories.filter((c) => config.nodeTypes[c] === false);
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
          {categories.map((c) => {
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
