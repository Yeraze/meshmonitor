import React, { useState } from 'react';
import { getAllTilesets, type TilesetId } from '../config/tilesets';
import './TilesetSelector.css';

interface TilesetSelectorProps {
  selectedTilesetId: TilesetId;
  onTilesetChange: (tilesetId: TilesetId) => void;
}

export const TilesetSelector: React.FC<TilesetSelectorProps> = ({
  selectedTilesetId,
  onTilesetChange
}) => {
  const tilesets = getAllTilesets();
  const [isCollapsed, setIsCollapsed] = useState(true);

  return (
    <div className={`tileset-selector ${isCollapsed ? 'collapsed' : ''}`}>
      {!isCollapsed ? (
        <>
          <div className="tileset-selector-label">Map Style:</div>
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
                <div className="tileset-name">{tileset.name}</div>
              </button>
            ))}
          </div>
          <button
            className="collapse-button"
            onClick={() => setIsCollapsed(true)}
            title="Collapse tileset selector"
          >
            ▼
          </button>
        </>
      ) : (
        <button
          className="expand-button"
          onClick={() => setIsCollapsed(false)}
          title="Expand tileset selector"
        >
          Map Style ▲
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
