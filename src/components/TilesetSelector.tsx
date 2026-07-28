import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import { getAllTilesets, type TilesetId } from '../config/tilesets';
import { useSettings } from '../contexts/SettingsContext';
import { DraggableOverlay } from './DraggableOverlay';
import { useIsMobileViewport } from '../hooks/useIsMobileViewport';
import './TilesetSelector.css';

interface TilesetSelectorProps {
  selectedTilesetId: TilesetId;
  onTilesetChange: (tilesetId: TilesetId) => void;
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
  onTilesetChange
}) => {
  const { t } = useTranslation();
  const { customTilesets, activeMapTilesetMode } = useSettings();
  const tilesets = getAllTilesets(customTilesets);
  const [isCollapsed, setIsCollapsed] = useState(true);
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
                  backgroundImage: `url(${getTilePreviewUrl(tileset.url)})`
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
