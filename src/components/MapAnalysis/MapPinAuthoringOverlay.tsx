/**
 * MapPinAuthoringOverlay — the "click the map" hint and the two pin editors
 * for Map Analysis (#5685). State and the network calls live in
 * `usePinAuthoring`; the placement bridge mounts inside the map, in
 * `MapAnalysisCanvas`.
 */
import { useTranslation } from 'react-i18next';
import WaypointEditorModal from '../WaypointEditorModal';
import LocalMarkerEditorModal from '../map/LocalMarkerEditorModal';
import type { PinAuthoring } from './usePinAuthoring';

export default function MapPinAuthoringOverlay({ pins }: { pins: PinAuthoring }) {
  const { t } = useTranslation();
  return (
    <>
      {pins.placing && (
        <div className="waypoint-placement-hint" role="status" data-testid="pin-placement-hint">
          <span>
            {pins.placing === 'waypoint'
              ? t('mapPins.placeWaypointHint', 'Click the map to place the waypoint. Nothing is sent until you save.')
              : t('localMarkers.placeHint', 'Click the map to place the local marker')}
          </span>
          <button type="button" onClick={pins.cancelPlacing}>{t('common.cancel', 'Cancel')}</button>
        </div>
      )}
      <WaypointEditorModal
        isOpen={pins.waypoint.open}
        initial={pins.waypoint.initial}
        channels={pins.waypoint.channels}
        defaultCoords={pins.waypoint.coords}
        selfNodeNum={pins.waypoint.selfNodeNum}
        sendingSource={pins.waypoint.sourceChoice}
        onClose={pins.waypoint.onClose}
        onSave={pins.waypoint.onSave}
      />
      <LocalMarkerEditorModal
        isOpen={pins.marker.open}
        initial={pins.marker.initial}
        defaultCoords={pins.marker.coords}
        storingSource={pins.marker.sourceChoice}
        onClose={pins.marker.onClose}
        onSave={pins.marker.onSave}
      />
    </>
  );
}
