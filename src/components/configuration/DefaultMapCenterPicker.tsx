import React, { useRef, useEffect } from 'react';
import { MapContainer, TileLayer, useMapEvents, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

export interface DefaultMapCenterPickerProps {
    lat: number | null;
    lon: number | null;
    zoom: number | null;
    onSave: (lat: number, lon: number, zoom: number) => void;
    onClear: () => void;
}

interface PositionRef {
    lat: number;
    lon: number;
    zoom: number;
}

/**
 * Tracks map position via moveend events and updates the shared position ref.
 */
const MapPositionTracker: React.FC<{ positionRef: React.MutableRefObject<PositionRef> }> = ({ positionRef }) => {
    const map = useMapEvents({
        moveend: () => {
            const center = map.getCenter();
            const zoom = map.getZoom();
            positionRef.current = { lat: center.lat, lon: center.lng, zoom };
        },
    });
    return null;
};

/**
 * Sets the initial map view when configured values exist. Runs once on mount.
 */
const MapInitializer: React.FC<{ lat: number; lon: number; zoom: number }> = ({ lat, lon, zoom }) => {
    const map = useMap();
    const initialized = useRef(false);
    useEffect(() => {
        if (!initialized.current) {
            initialized.current = true;
            map.setView([lat, lon], zoom);
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return null;
};

/**
 * A minimap picker component for setting the default map center position.
 * The user pans/zooms to desired position then clicks "Save as Default".
 */
export const DefaultMapCenterPicker: React.FC<DefaultMapCenterPickerProps> = ({
    lat,
    lon,
    zoom,
    onSave,
    onClear,
}) => {
    const isConfigured = lat !== null && lon !== null && zoom !== null;

    // Default position ref starts at current configured values or world view
    const positionRef = useRef<PositionRef>({
        lat: lat ?? 20,
        lon: lon ?? 0,
        zoom: zoom ?? 2,
    });

    const handleSave = () => {
        const { lat: currentLat, lon: currentLon, zoom: currentZoom } = positionRef.current;
        onSave(currentLat, currentLon, currentZoom);
    };

    const initialCenter: [number, number] = isConfigured ? [lat!, lon!] : [20, 0];
    const initialZoom = isConfigured ? zoom! : 2;

    return (
        <div>
            <div style={{ height: '300px', width: '100%' }}>
                <MapContainer
                    center={initialCenter}
                    zoom={initialZoom}
                    style={{ height: '100%', width: '100%' }}
                    scrollWheelZoom={true}
                >
                    <TileLayer
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />
                    <MapPositionTracker positionRef={positionRef} />
                    {isConfigured && (
                        <MapInitializer lat={lat!} lon={lon!} zoom={zoom!} />
                    )}
                </MapContainer>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button className="save-button" onClick={handleSave} style={{ minWidth: 'auto', padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
                    Save as Default
                </button>
                {isConfigured && (
                    <button className="reset-button" onClick={onClear} style={{ minWidth: 'auto', padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
                        Clear
                    </button>
                )}
                <span className="setting-description" style={{ marginLeft: '0.5rem' }}>
                    {isConfigured
                        ? `Default: ${lat!.toFixed(4)}, ${lon!.toFixed(4)} (zoom ${zoom})`
                        : 'No default center configured'}
                </span>
            </div>
        </div>
    );
};

export default DefaultMapCenterPicker;
