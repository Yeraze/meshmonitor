import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAllTilesets, type TilesetId } from '../config/tilesets';
import { useSettings } from '../contexts/SettingsContext';
import { DraggableOverlay } from './DraggableOverlay';
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
  const { customTilesets } = useSettings();
  const tilesets = getAllTilesets(customTilesets);
  const [isCollapsed, setIsCollapsed] = useState(true);

  return (
    <DraggableOverlay
      id="tileset-selector"
      defaultPosition={getDefaultPosition()}
      className="tileset-selector-wrapper"
    >
      <div className={`tileset-selector ${isCollapsed ? 'collapsed' : ''}`}>
        {!isCollapsed ? (
          <>
            <div className="tileset-selector-label">{t('tileset.map_style')}:</div>
            <div className="tileset-buttons">
              {tilesets.map((tileset) => (
                <button
                  key={tileset.id}
                  className={`tileset-button ${selectedTilesetId === tileset.id ? 'active' : ''}`}
                  onClick={() => onTilesetChange(tileset.id)}
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
            <button
              className="collapse-button"
              onClick={() => setIsCollapsed(true)}
              title={t('tileset.collapse')}
            >
              ▼
            </button>
          </>
        ) : (
          <button
            className="expand-button"
            onClick={() => setIsCollapsed(false)}
            title={t('tileset.expand')}
          >
            {t('tileset.map_style')} ▲
          </button>
        )}
      </div>
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
