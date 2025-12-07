import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAllTilesets, type TilesetId } from '../config/tilesets';
import { useSettings } from '../contexts/SettingsContext';
import './TilesetSelector.css';

interface TilesetSelectorProps {
  selectedTilesetId: TilesetId;
  onTilesetChange: (tilesetId: TilesetId) => void;
}

export const TilesetSelector: React.FC<TilesetSelectorProps> = ({
  selectedTilesetId,
  onTilesetChange
}) => {
  const { t } = useTranslation();
  const { customTilesets } = useSettings();
  const tilesets = getAllTilesets(customTilesets);
  const [isCollapsed, setIsCollapsed] = useState(true);

  return (
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
