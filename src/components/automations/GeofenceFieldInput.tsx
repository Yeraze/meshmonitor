/**
 * GeofenceFieldInput (#3653) — visual editor for the `trigger.geofence` region.
 *
 * Wraps the shared {@link GeofenceMapEditor} (the same Leaflet editor the
 * Meshtastic geofence-alert UI uses) with a circle/polygon toggle, and exposes
 * the drawn {@link GeofenceShape} as the automation trigger's `shape` param.
 * Switching shape type clears the current region, mirroring GeofenceTriggersSection.
 */
import { useId, useState } from 'react';
import GeofenceMapEditor from '../GeofenceMapEditor';
import type { GeofenceShape } from '../auto-responder/types';

export default function GeofenceFieldInput({ value, onChange }: {
  value: GeofenceShape | undefined;
  onChange: (shape: GeofenceShape | undefined) => void;
}) {
  const [shapeType, setShapeType] = useState<'circle' | 'polygon'>(value?.type ?? 'circle');
  // Unique radio-group name so multiple editors on one page don't interfere.
  const radioName = useId();

  const selectType = (type: 'circle' | 'polygon') => {
    if (type === shapeType) return;
    setShapeType(type);
    onChange(undefined); // clear the old region so a stale shape isn't saved
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      <div className="ae-btn-row" role="radiogroup" aria-label="Geofence shape">
        <label className="ae-switch">
          <input type="radio" name={radioName} value="circle"
            checked={shapeType === 'circle'} onChange={() => selectType('circle')} /> Circle
        </label>
        <label className="ae-switch">
          <input type="radio" name={radioName} value="polygon"
            checked={shapeType === 'polygon'} onChange={() => selectType('polygon')} /> Polygon
        </label>
      </div>
      <GeofenceMapEditor shape={value ?? null} onShapeChange={onChange} shapeType={shapeType} />
    </div>
  );
}
