/**
 * GeofenceFieldInput (#3653) — visual editor for the `trigger.geofence` region.
 *
 * Wraps the shared {@link GeofenceMapEditor} (the same Leaflet editor the
 * Meshtastic geofence-alert UI uses) with a circle/polygon toggle, and exposes
 * the drawn {@link GeofenceShape} as the automation trigger's `shape` param.
 * Switching shape type clears the current region, mirroring GeofenceTriggersSection.
 *
 * #4722 adds a third mode: instead of drawing, anchor the fence to a waypoint.
 * The stored value is then a `GeofenceWaypointAnchor` rather than a shape, and
 * the engine resolves it to a circle on every check — so moving the waypoint
 * moves the fence with no edit here.
 */
import { useId, useState } from 'react';
import GeofenceMapEditor from '../GeofenceMapEditor';
import GeofenceWaypointPicker from './GeofenceWaypointPicker';
import type { GeofenceShape } from '../auto-responder/types';
import type { SourceOption } from './AutomationBuilder';
import { isWaypointAnchor, type GeofenceWaypointAnchor } from './geofenceAnchor';

type Mode = 'circle' | 'polygon' | 'waypoint';
type Value = GeofenceShape | GeofenceWaypointAnchor | undefined;

export default function GeofenceFieldInput({ value, sources = [], onChange }: {
  value: Value;
  sources?: SourceOption[];
  onChange: (value: Value) => void;
}) {
  const [mode, setMode] = useState<Mode>(
    isWaypointAnchor(value) ? 'waypoint' : ((value as GeofenceShape | undefined)?.type ?? 'circle'),
  );
  // Unique radio-group name so multiple editors on one page don't interfere.
  const radioName = useId();

  const selectMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    onChange(undefined); // clear the old region/anchor so nothing stale is saved
  };

  const anchor = isWaypointAnchor(value) ? value : undefined;
  const drawn = isWaypointAnchor(value) ? undefined : (value as GeofenceShape | undefined);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      <div className="ae-btn-row" role="radiogroup" aria-label="Geofence shape">
        <label className="ae-switch">
          <input type="radio" name={radioName} value="circle"
            checked={mode === 'circle'} onChange={() => selectMode('circle')} /> Circle
        </label>
        <label className="ae-switch">
          <input type="radio" name={radioName} value="polygon"
            checked={mode === 'polygon'} onChange={() => selectMode('polygon')} /> Polygon
        </label>
        <label className="ae-switch">
          <input type="radio" name={radioName} value="waypoint"
            checked={mode === 'waypoint'} onChange={() => selectMode('waypoint')} /> Waypoint
        </label>
      </div>
      {mode === 'waypoint' ? (
        <GeofenceWaypointPicker value={anchor} sources={sources} onChange={onChange} />
      ) : (
        <GeofenceMapEditor shape={drawn ?? null} onShapeChange={onChange} shapeType={mode} />
      )}
    </div>
  );
}
