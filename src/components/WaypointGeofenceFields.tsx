/**
 * Geofence section of the waypoint editor (#5922).
 *
 * Edits firmware Waypoint fields 9-13: a circular radius, a rectangular
 * bounding box, and the enter / exit / favorites-only alert flags. MeshMonitor
 * only stores and sends these; every node that receives the waypoint checks
 * them itself and raises its own alerts.
 */
import { useTranslation } from 'react-i18next';
import BBoxMapEditor, { type BBoxValue } from './BBoxMapEditor';
import { NumberInput } from './common/NumberInput';
import { UiIcon } from './icons';
import type { WaypointBoundingBox } from '../types/waypoint';
import {
  DEFAULT_GEOFENCE_RADIUS_M,
  GEOFENCE_MAX_RADIUS_M,
  GEOFENCE_MIN_RADIUS_M,
  type GeofenceDraft,
  type GeofenceShapeChoice,
} from './waypointGeofenceDraft';
import styles from './WaypointGeofenceFields.module.css';

const toBBoxValue = (b: WaypointBoundingBox | null): BBoxValue | null =>
  b ? { minLat: b.south, maxLat: b.north, minLng: b.west, maxLng: b.east } : null;

const fromBBoxValue = (b: BBoxValue | null): WaypointBoundingBox | null =>
  b ? { west: b.minLng, south: b.minLat, east: b.maxLng, north: b.maxLat } : null;

function formatRadius(m: number): string {
  const km = m / 1000;
  const mi = m / 1609.344;
  return `${km.toFixed(km < 10 ? 2 : 1)} km / ${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
}

export interface WaypointGeofenceFieldsProps {
  value: GeofenceDraft;
  onChange: (next: GeofenceDraft) => void;
  /** The waypoint's position, where the box map opens. */
  center: { lat: number; lon: number } | null;
}

export default function WaypointGeofenceFields({ value, onChange, center }: WaypointGeofenceFieldsProps) {
  const { t } = useTranslation();
  const set = (patch: Partial<GeofenceDraft>) => onChange({ ...value, ...patch });
  const wantsCircle = value.shape === 'circle' || value.shape === 'both';
  const wantsBox = value.shape === 'box' || value.shape === 'both';
  const hasShape = value.shape !== 'none';
  const alerts = value.notifyOnEnter || value.notifyOnExit;

  return (
    <fieldset className={styles.group}>
      <legend>{t('waypoints.geofence.legend', 'Geofence')}</legend>
      <label className={styles.label}>
        {t('waypoints.geofence.shape', 'Shape')}
        <select
          className={styles.input}
          value={value.shape}
          aria-label={t('waypoints.geofence.shape', 'Shape')}
          onChange={(e) => {
            const shape = e.target.value as GeofenceShapeChoice;
            const needsRadius = (shape === 'circle' || shape === 'both') && value.radiusM == null;
            set({ shape, radiusM: needsRadius ? DEFAULT_GEOFENCE_RADIUS_M : value.radiusM });
          }}
        >
          <option value="none">{t('waypoints.geofence.shape_none', 'None')}</option>
          <option value="circle">{t('waypoints.geofence.shape_circle', 'Circle (radius)')}</option>
          <option value="box">{t('waypoints.geofence.shape_box', 'Rectangle (bounding box)')}</option>
          {value.shape === 'both' && (
            <option value="both">{t('waypoints.geofence.shape_both', 'Circle and rectangle')}</option>
          )}
        </select>
        <span className={styles.hint}>
          {t(
            'waypoints.geofence.hint',
            'Sent with the waypoint. Each node that receives it watches the area itself; MeshMonitor raises no alerts.',
          )}
        </span>
      </label>

      {wantsCircle && (
        <label className={styles.label}>
          {t('waypoints.geofence.radius', 'Radius (metres)')}
          <NumberInput
            className={styles.input}
            integer
            min={GEOFENCE_MIN_RADIUS_M}
            max={GEOFENCE_MAX_RADIUS_M}
            step={10}
            value={value.radiusM}
            onChange={(v) => set({ radiusM: v })}
            showReason
          />
          <span className={styles.hint}>
            {value.radiusM != null ? `${formatRadius(value.radiusM)}. ` : ''}
            {t('waypoints.geofence.radius_range', '160 m to 16 km (0.1-10 mi), the range the Apple app offers.')}
          </span>
        </label>
      )}

      {wantsBox && (
        <div className={styles.label} data-testid="waypoint-geofence-box">
          {t('waypoints.geofence.box', 'Bounding box')}
          <BBoxMapEditor
            bbox={toBBoxValue(value.box)}
            onChange={(b) => set({ box: fromBBoxValue(b) })}
            height="220px"
            emptyCenter={center ? [center.lat, center.lon] : undefined}
            emptyZoom={center ? 13 : undefined}
          />
        </div>
      )}

      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={hasShape && value.notifyOnEnter}
          disabled={!hasShape}
          onChange={(e) => set({ notifyOnEnter: e.target.checked })}
        />
        <span>{t('waypoints.geofence.notify_enter', 'Alert when a node enters')}</span>
      </label>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={hasShape && value.notifyOnExit}
          disabled={!hasShape}
          onChange={(e) => set({ notifyOnExit: e.target.checked })}
        />
        <span>{t('waypoints.geofence.notify_exit', 'Alert when a node leaves')}</span>
      </label>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={hasShape && alerts && value.notifyFavoritesOnly}
          disabled={!hasShape || !alerts}
          onChange={(e) => set({ notifyFavoritesOnly: e.target.checked })}
        />
        <span>{t('waypoints.geofence.favorites_only', 'Only for favourite nodes')}</span>
      </label>
      {hasShape && alerts && (
        <span className={styles.warning} role="note">
          <UiIcon name="alert" size={14} />{' '}
          {t(
            'waypoints.geofence.alert_warning',
            'Every node that receives this waypoint alerts its user when a node crosses the edge. A busy area can mean many alerts on many devices. "Only for favourite nodes" limits each device to its own favourites.',
          )}
        </span>
      )}
    </fieldset>
  );
}
