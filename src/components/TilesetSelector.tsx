import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import { getAllTilesets, type TilesetId } from '../config/tilesets';
import { isCartoUrl, withCartoKey } from '../config/cartoKey';
import { useSettings } from '../contexts/SettingsContext';
import { DraggableOverlay } from './DraggableOverlay';
import { useIsMobileViewport } from '../hooks/useIsMobileViewport';
import './TilesetSelector.css';

interface TilesetSelectorProps {
  selectedTilesetId: TilesetId;
  onTilesetChange: (tilesetId: TilesetId) => void;
  /**
   * Render inline inside the unified map sidebar (#4909) instead of as a
   * floating/draggable overlay: no drag wrapper, no mobile bottom-sheet, and
   * the card grid reflows to fit the sidebar column width. Starts expanded.
   */
  embedded?: boolean;
}

// Default position: top-left, aligned with top of node list, shifted right past node list
// Map container starts at top: 60px (header), left: 60px (sidebar)
// Node list is at left: 16px relative to map, width: 360px, top: 16px relative to map
const getDefaultPosition = () => ({
  x: 60 + 16 + 360 + 16, // sidebar + node list left + node list width + gap = 452
  y: 60 + 16 // header + node list top offset = 76
});

export const TilesetSelector: React.FC<TilesetSelectorProps> = ({
  selectedTilesetId,
  onTilesetChange,
  embedded = false,
}) => {
  const { t } = useTranslation();
  const { customTilesets, activeMapTilesetMode, cartoApiKey } = useSettings();
  const tilesets = getAllTilesets(customTilesets);

  // #5015: Carto retired its free keyless rasters. An unkeyed request still
  // returns a valid HTTP 200 PNG — with "API KEY REQUIRED" painted across it —
  // so there is no load error to react to and nothing downstream can notice.
  // The only place a user can be told is here, where they pick the tileset.
  //
  // We warn rather than silently substituting a different basemap: the user
  // may be choosing Carto precisely because they are about to add a key, and a
  // picker that shows one tileset selected while rendering another is worse
  // than a watermark.
  const selectedTileset = tilesets.find((ts) => ts.id === selectedTilesetId);
  const selectedNeedsCartoKey = Boolean(
    selectedTileset && isCartoUrl(selectedTileset.url) && !cartoApiKey,
  );
  // Floating overlay starts collapsed; embedded-in-sidebar starts expanded
  // (the sidebar itself provides the outer collapse).
  const [isCollapsed, setIsCollapsed] = useState(!embedded);
  const isMobile = useIsMobileViewport();

  const title =
    activeMapTilesetMode === 'dark'
      ? t('tileset.tileset_dark', 'Tileset (Dark mode)')
      : t('tileset.tileset_light', 'Tileset (Light mode)');

  const handleTilesetChange = (tilesetId: TilesetId) => {
    onTilesetChange(tilesetId);
    // Dismiss-on-select, mobile only: the sheet covers the map it is styling,
    // so leaving it open would hide the result of the choice just made. On
    // desktop the panel sits beside the map and stays put, as it always has.
    if (isMobile) setIsCollapsed(true);
  };

  const panel = (
    <div className={`tileset-selector ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="tileset-header">
        <div className="tileset-selector-title">{title}</div>
        <button
          className="tileset-collapse-btn"
          onClick={() => setIsCollapsed(!isCollapsed)}
          onMouseDown={(e) => e.stopPropagation()}
          title={isCollapsed ? t('tileset.expand') : t('tileset.collapse')}
        >
          <UiIcon name={isCollapsed ? 'chevronDown' : 'chevronUp'} />
        </button>
      </div>
      {!isCollapsed && selectedNeedsCartoKey && (
        <div className="tileset-carto-warning" role="status">
          <UiIcon name="alert" />
          <span>
            {t(
              'tileset.carto_key_required',
              'This basemap needs a CARTO API key. Without one CARTO returns tiles watermarked "API KEY REQUIRED". Add a free key in Settings, or pick a keyless basemap such as Dark Gray.',
            )}
          </span>
        </div>
      )}
      {!isCollapsed && (
        <div className="tileset-buttons">
          {tilesets.map((tileset) => (
            <button
              key={tileset.id}
              className={`tileset-button ${selectedTilesetId === tileset.id ? 'active' : ''}`}
              onClick={() => handleTilesetChange(tileset.id)}
              title={tileset.description || tileset.name}
            >
              <div
                className="tileset-preview"
                style={{
                  backgroundImage: `url(${withCartoKey(getTilePreviewUrl(tileset.url), cartoApiKey)})`
                }}
              />
              <div className="tileset-name">
                {tileset.name}
                {tileset.isCustom && <span className="custom-badge">{t('tileset.custom')}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  // Embedded in the unified map sidebar (#4909): render the panel inline (the
  // sidebar handles positioning + mobile full-screen), reflowed to fit the
  // column. No drag overlay, no separate bottom-sheet.
  if (embedded) {
    return (
      <div className="tileset-selector-wrapper tileset-selector-wrapper--embedded">
        {panel}
      </div>
    );
  }

  // Mobile: a full-width bottom sheet instead of the draggable overlay (#4380).
  // Dragging a floating panel around a phone screen is not useful, and the
  // overlay was force-hidden by CSS on this breakpoint — the Features-panel
  // checkbox stayed toggleable but controlled something that could never
  // appear. Collapsed, the sheet is a tappable title bar pinned to the bottom;
  // expanded, it lists the tilesets full-width.
  if (isMobile) {
    return (
      <div className="tileset-selector-wrapper tileset-selector-sheet">{panel}</div>
    );
  }

  return (
    <DraggableOverlay
      id="tileset-selector"
      defaultPosition={getDefaultPosition()}
      className="tileset-selector-wrapper"
    >
      {panel}
    </DraggableOverlay>
  );
};

// Generate a preview tile URL for a specific location (showing a generic preview)
// Using a fixed location (lat: 40, lon: -95, zoom: 4) for consistent previews
function getTilePreviewUrl(templateUrl: string): string {
  return templateUrl
    .replace('{z}', '4')
    .replace('{x}', '3')
    .replace('{y}', '6')
    .replace('{s}', 'a');
}
