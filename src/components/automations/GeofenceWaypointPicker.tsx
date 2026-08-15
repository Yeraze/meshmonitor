/**
 * GeofenceWaypointPicker (#4722) — pick the waypoint a geofence follows.
 *
 * Anchoring to a waypoint rather than drawing a region means the fence moves
 * when the waypoint does, with no edit to the automation. The source is chosen
 * explicitly because waypoints are per-source while automations are global (see
 * `geofenceAnchor.ts`), so a fence has to name which source's waypoint it means.
 */
import { useEffect, useState } from 'react';
import apiService from '../../services/api';
import type { SourceOption } from './AutomationBuilder';
import { isCompleteAnchor, type GeofenceWaypointAnchor } from './geofenceAnchor';

interface WaypointRow {
  waypointId: number;
  name?: string;
  latitude?: number;
  longitude?: number;
}

const DEFAULT_RADIUS_KM = 0.5;

export default function GeofenceWaypointPicker({ value, sources, onChange }: {
  value: Partial<GeofenceWaypointAnchor> | undefined;
  sources: SourceOption[];
  onChange: (anchor: GeofenceWaypointAnchor | undefined) => void;
}) {
  const [waypoints, setWaypoints] = useState<WaypointRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const sourceId = value?.sourceId ?? '';
  const radiusKm = value?.radiusKm ?? DEFAULT_RADIUS_KM;

  // Reload whenever the chosen source changes. A source with no waypoints is a
  // normal state, not an error — it just leaves nothing to anchor to.
  useEffect(() => {
    if (!sourceId) { setWaypoints([]); setLoadError(null); return; }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    apiService.get<unknown>(`/api/sources/${encodeURIComponent(sourceId)}/waypoints`)
      .then((body) => {
        if (cancelled) return;
        // The endpoint returns a bare array on some paths and an enveloped
        // `{ data }` on others (see useWaypoints), so accept both.
        const rows = Array.isArray(body)
          ? body
          : Array.isArray((body as { data?: unknown })?.data)
            ? (body as { data: unknown[] }).data
            : [];
        setWaypoints(rows as WaypointRow[]);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setWaypoints([]);
        setLoadError(e instanceof Error ? e.message : 'Failed to load waypoints');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sourceId]);

  /** Emit only a complete anchor; a half-filled one would never fire. */
  const emit = (next: Partial<GeofenceWaypointAnchor>) => {
    const merged = { type: 'waypoint' as const, sourceId, radiusKm, waypointId: value?.waypointId, ...next };
    onChange(isCompleteAnchor(merged) ? (merged as GeofenceWaypointAnchor) : undefined);
  };

  const label = (w: WaypointRow) => {
    const name = (w.name ?? '').trim();
    return name ? `${name} (#${w.waypointId})` : `Waypoint #${w.waypointId}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <label className="ae-field-label" htmlFor="ae-wp-source">Source</label>
      <select
        id="ae-wp-source"
        className="ae-select"
        value={sourceId}
        onChange={(e) => {
          // Changing source invalidates the waypoint id — ids are only unique
          // within a source, so keeping it would point at a different place.
          onChange(undefined);
          emit({ sourceId: e.target.value, waypointId: undefined });
        }}
      >
        <option value="">— select source —</option>
        {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>

      <label className="ae-field-label" htmlFor="ae-wp-id">Waypoint</label>
      <select
        id="ae-wp-id"
        className="ae-select"
        value={value?.waypointId ?? ''}
        disabled={!sourceId || loading}
        onChange={(e) => emit({ waypointId: e.target.value === '' ? undefined : Number(e.target.value) })}
      >
        <option value="">{loading ? 'loading…' : '— select waypoint —'}</option>
        {waypoints.map((w) => <option key={w.waypointId} value={w.waypointId}>{label(w)}</option>)}
      </select>
      {loadError && <div className="ae-error-list">{loadError}</div>}
      {!loading && !loadError && sourceId && waypoints.length === 0 && (
        <div className="ae-muted">This source has no waypoints to anchor to.</div>
      )}

      <label className="ae-field-label" htmlFor="ae-wp-radius">Radius (km)</label>
      <input
        id="ae-wp-radius"
        className="ae-input"
        type="number"
        min="0"
        step="0.1"
        value={radiusKm}
        onChange={(e) => emit({ radiusKm: e.target.value === '' ? undefined : Number(e.target.value) })}
      />
      <div className="ae-help-text">
        The fence follows the waypoint — move the waypoint and the region moves with it.
        If the waypoint is deleted or expires, the rule stops firing rather than falling back to another region.
      </div>
    </div>
  );
}
