import React, { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { Marker, useMap, useMapEvents } from 'react-leaflet';
import { useTranslation } from 'react-i18next';
import 'leaflet/dist/leaflet.css';
import { BaseMap } from './BaseMap';
import mapFrame from './EmbeddedMapFrame.module.css';
import styles from './LocationPinPicker.module.css';
import { UiIcon } from '../icons';
import { hasPinPosition, normalizePinPosition } from './locationPin';

/**
 * Drop-a-pin location picker for a node's own position: click the map or drag
 * the pin, like "Set fixed position" in the Meshtastic iOS app. Used by the
 * Meshtastic fixed position fields and the MeshCore Location section.
 *
 * The picker only reports a new position through `onChange`; the owning form
 * keeps its number inputs and its own Save button, so nothing is sent to the
 * node until the user saves.
 */
export interface LocationPinPickerProps {
  /** Current latitude, or null when the node has no position yet. */
  lat: number | null;
  /** Current longitude, or null when the node has no position yet. */
  lon: number | null;
  onChange: (lat: number, lon: number) => void;
  disabled?: boolean;
  /**
   * Decimal places kept from a click or drag. Meshtastic stores degrees * 1e7
   * (7 places); MeshCore stores degrees * 1e6 (6 places).
   */
  decimals?: number;
  /** data-testid for the map frame. */
  testId?: string;
}

const PIN_ZOOM = 13;
const WORLD_CENTER: [number, number] = [20, 0];
const WORLD_ZOOM = 2;

const ClickToPlace: React.FC<{ onPick: (lat: number, lon: number) => void; disabled: boolean }> = ({ onPick, disabled }) => {
  useMapEvents({
    click: (e) => {
      if (!disabled) onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
};

/** Pans to the pin when it moves off screen, e.g. after typing coordinates. */
const KeepPinInView: React.FC<{ lat: number; lon: number }> = ({ lat, lon }) => {
  const map = useMap();
  useEffect(() => {
    const target = L.latLng(lat, lon);
    if (!map.getBounds().contains(target)) {
      map.setView(target, Math.max(map.getZoom(), PIN_ZOOM));
    }
  }, [map, lat, lon]);
  return null;
};

export const LocationPinPicker: React.FC<LocationPinPickerProps> = ({
  lat,
  lon,
  onChange,
  disabled = false,
  decimals = 7,
  testId = 'location-pin-picker',
}) => {
  const { t } = useTranslation();
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const hasPin = hasPinPosition(lat, lon);

  const pinIcon = useMemo(() => L.divIcon({
    className: styles.pinIcon,
    html: `<div class="${styles.pin}"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 24],
  }), []);

  const pick = (pLat: number, pLon: number) => {
    const [nLat, nLon] = normalizePinPosition(pLat, pLon, decimals);
    setLocateError(null);
    onChange(nLat, nLon);
  };

  const canLocate = typeof navigator !== 'undefined' && !!navigator.geolocation;
  const useMyLocation = () => {
    if (!canLocate) return;
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        pick(pos.coords.latitude, pos.coords.longitude);
      },
      () => {
        setLocating(false);
        setLocateError(t('location_picker.locate_failed', 'Could not get this device\'s location. Allow location access in the browser, or click the map.'));
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  // Mount-time view only; later moves are handled by KeepPinInView so the
  // map doesn't jump while the user is zoomed in and dragging.
  const initialCenter: [number, number] = hasPin ? [lat, lon as number] : WORLD_CENTER;
  const initialZoom = hasPin ? PIN_ZOOM : WORLD_ZOOM;

  return (
    <div className={styles.picker}>
      <div className={`${mapFrame.frame} ${styles.frame}`} data-testid={testId}>
        <BaseMap center={initialCenter} zoom={initialZoom} scrollWheelZoom>
          <ClickToPlace onPick={pick} disabled={disabled} />
          {hasPin && (
            <>
              <Marker
                position={[lat, lon as number]}
                icon={pinIcon}
                draggable={!disabled}
                eventHandlers={{
                  dragend: (e) => {
                    const p = (e.target as L.Marker).getLatLng();
                    pick(p.lat, p.lng);
                  },
                }}
              />
              <KeepPinInView lat={lat} lon={lon as number} />
            </>
          )}
        </BaseMap>
      </div>
      <div className={styles.toolbar}>
        <span className="setting-description">
          {hasPin
            ? t('location_picker.hint_set', 'Click the map or drag the pin to move it. Pin: {{lat}}, {{lon}}', {
                lat: lat.toFixed(5),
                lon: (lon as number).toFixed(5),
              })
            : t('location_picker.hint_unset', 'No position yet. Click the map to drop a pin.')}
        </span>
        {canLocate && (
          <button
            type="button"
            className={styles.locateButton}
            onClick={useMyLocation}
            disabled={disabled || locating}
          >
            <UiIcon name="target" size={14} />
            {locating
              ? t('location_picker.locating', 'Locating…')
              : t('location_picker.use_my_location', 'Use this device\'s location')}
          </button>
        )}
      </div>
      {locateError && <div className={styles.error} role="alert">{locateError}</div>}
    </div>
  );
};

export default LocationPinPicker;
