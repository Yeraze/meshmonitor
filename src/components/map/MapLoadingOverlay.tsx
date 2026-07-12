import { useTranslation } from 'react-i18next';

/**
 * Shared "map data is loading" overlay.
 *
 * Rendered as a `BaseMap` sibling (same relatively-positioned wrapper the
 * "no nodes" empty-state overlays already use) while the FIRST fetch for a
 * map's node data is still unresolved. Without this, a map whose data hasn't
 * arrived yet is indistinguishable from one that genuinely has no positioned
 * nodes — the "No Node Locations" / "No node positions" empty states would
 * flash on-screen before a slow initial fetch even completes.
 *
 * Reuses the existing `.loading-spinner` spin animation (see
 * `src/styles/messages.css`) rather than inventing a new one, and the
 * existing `common.loading_indicator` i18n key rather than adding a new one.
 */
export function MapLoadingOverlay() {
  const { t } = useTranslation();

  return (
    <div className="map-loading-overlay" data-testid="map-loading-overlay" role="status" aria-live="polite">
      <div className="map-loading-overlay-content">
        <div className="loading-spinner" aria-hidden="true" />
        <p>{t('common.loading_indicator', 'Loading...')}</p>
      </div>
    </div>
  );
}

export default MapLoadingOverlay;
