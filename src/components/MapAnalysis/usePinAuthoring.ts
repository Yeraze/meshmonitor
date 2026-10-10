/**
 * usePinAuthoring — add, edit and delete map pins from Map Analysis (#5685).
 *
 * Two kinds of pin share one placement flow:
 *  - an on-air WAYPOINT, which the chosen source's radio broadcasts on Save;
 *  - a LOCAL MARKER (#5686), which is stored only and never transmitted.
 *
 * Map Analysis overlays many sources, so nothing here assumes an "active"
 * source: a new pin asks which source it belongs to, and an existing pin acts
 * on its own source. Picking the spot and opening the editor send nothing. The
 * one network write per action happens in `saveWaypoint` / `deleteWaypoint`,
 * and the server sends one broadcast for it, the same as the Nodes map.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { usePinSources, type PinSource } from '../../hooks/usePinSources';
import { useSourceStatuses } from '../../hooks/useDashboardData';
import { useSourceChannels } from '../../hooks/useSourceChannels';
import { createWaypoint, updateWaypoint, deleteWaypoint } from '../../hooks/useWaypoints';
import { createMapMarker, updateMapMarker, deleteMapMarker } from '../../hooks/useMapMarkers';
import type { Waypoint, WaypointInput } from '../../types/waypoint';
import type { MapMarker, MapMarkerInput } from '../../types/mapMarker';
import type { WaypointPopupActions } from '../map/layers/WaypointsLayer';
import type { MapMarkerPopupActions } from '../map/layers/MapMarkersLayer';
import type { PinSourceChoice } from '../map/PinSourcePicker';

type Coords = { lat: number; lon: number };

interface EditorState<T> {
  open: boolean;
  initial: T | null;
  coords: Coords | null;
  sourceId: string | null;
}

const CLOSED = { open: false, initial: null, coords: null, sourceId: null };

/**
 * The source a new pin starts on. One candidate: that one. Several: the only
 * one inside the map's source filter, if the filter leaves exactly one.
 * Otherwise none, and the user must choose.
 */
export function preselectPinSource(candidates: PinSource[], filter: string[]): string | null {
  if (candidates.length === 1) return candidates[0].id;
  if (filter.length === 0) return null;
  const inFilter = candidates.filter((c) => filter.includes(c.id));
  return inFilter.length === 1 ? inFilter[0].id : null;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function usePinAuthoring(active2D: boolean) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { config, pinPlaceMode, setPinPlaceMode } = useMapAnalysisCtx();
  const { waypointSources, markerSources } = usePinSources();
  const statuses = useSourceStatuses(waypointSources.map((s) => s.id));

  const [waypointEditor, setWaypointEditor] = useState<EditorState<Waypoint>>(CLOSED);
  const [markerEditor, setMarkerEditor] = useState<EditorState<MapMarker>>(CLOSED);

  const placing = active2D ? pinPlaceMode : null;

  // Placement belongs to the 2D map. Leaving it for 3D drops the armed tool
  // instead of leaving it to fire on the way back.
  useEffect(() => {
    if (!active2D && pinPlaceMode) setPinPlaceMode(null);
  }, [active2D, pinPlaceMode, setPinPlaceMode]);

  // Esc cancels placement (the editors' own Esc is handled by Modal).
  useEffect(() => {
    if (!placing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinPlaceMode(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placing, setPinPlaceMode]);

  const cancelPlacing = useCallback(() => setPinPlaceMode(null), [setPinPlaceMode]);

  /** The map click that picks the spot. Opens an editor; sends nothing. */
  const pickSpot = useCallback(
    (lat: number, lon: number) => {
      const kind = pinPlaceMode;
      setPinPlaceMode(null);
      if (kind === 'waypoint') {
        setWaypointEditor({
          open: true, initial: null, coords: { lat, lon },
          sourceId: preselectPinSource(waypointSources, config.sources),
        });
      } else if (kind === 'marker') {
        setMarkerEditor({
          open: true, initial: null, coords: { lat, lon },
          sourceId: preselectPinSource(markerSources, config.sources),
        });
      }
    },
    [pinPlaceMode, setPinPlaceMode, waypointSources, markerSources, config.sources],
  );

  const localNodeNum = useCallback(
    (sourceId: string | null): number | null => {
      if (!sourceId) return null;
      const n = statuses.get(sourceId)?.nodeNum;
      return typeof n === 'number' ? n : null;
    },
    // `statuses` is a fresh Map each render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #5685 keyed on contents, as useOwnNodePositions does
    [[...statuses].map(([id, s]) => `${id}:${s?.nodeNum ?? ''}`).join('|')],
  );

  // ----- Waypoints -----

  const removeWaypoint = useCallback(
    async (wp: Waypoint, sourceName: string) => {
      const label = wp.name || `Waypoint ${wp.waypointId}`;
      const question = t(
        'mapPins.confirmDeleteWaypoint',
        'Delete "{{label}}"? This will be broadcast to the mesh.\n\nSending source: {{source}}',
        { label, source: sourceName },
      );
      if (!window.confirm(question)) return;
      try {
        await deleteWaypoint(wp.sourceId, wp.waypointId);
        void qc.invalidateQueries({ queryKey: ['waypoints', wp.sourceId] });
      } catch (err) {
        window.alert(t('mapPins.deleteWaypointFailed', 'Failed to delete waypoint: {{error}}', {
          error: errorText(err, 'unknown error'),
        }));
      }
    },
    [qc, t],
  );

  /**
   * Popup actions for one source's waypoints. Only a source that can send, and
   * that the user may write to, gets any: an edit saved on an MQTT or MeshCore
   * source would change the stored row and never reach the mesh.
   */
  const waypointActionsFor = useCallback(
    (source: { id: string; name?: string }): WaypointPopupActions | undefined => {
      if (!waypointSources.some((s) => s.id === source.id)) return undefined;
      const self = localNodeNum(source.id);
      return {
        canEdit: true,
        canDelete: true,
        lockedToOther: (wp) => Boolean(wp.lockedTo && self != null && Number(wp.lockedTo) !== self),
        lockedTitle: t('mapPins.lockedToOther', 'Locked to another node. Only that node can change it.'),
        onEdit: (wp) => setWaypointEditor({ open: true, initial: wp, coords: null, sourceId: wp.sourceId }),
        onDelete: (wp) => { void removeWaypoint(wp, source.name ?? source.id); },
      };
    },
    [waypointSources, localNodeNum, removeWaypoint, t],
  );

  const waypointSourceId = waypointEditor.initial?.sourceId ?? waypointEditor.sourceId;
  const { channels: waypointChannels } = useSourceChannels(waypointEditor.open ? waypointSourceId : null);

  const hidden = useCallback(
    (sourceId: string | null) =>
      Boolean(sourceId) && config.sources.length > 0 && !config.sources.includes(sourceId as string),
    [config.sources],
  );

  const waypointSourceChoice: PinSourceChoice = useMemo(() => {
    const editing = waypointEditor.initial;
    if (editing) {
      const known = waypointSources.find((s) => s.id === editing.sourceId);
      return { options: [known ?? { id: editing.sourceId, name: editing.sourceId }], value: editing.sourceId };
    }
    return {
      options: waypointSources,
      value: waypointEditor.sourceId,
      onChange: (id: string) => setWaypointEditor((prev) => ({ ...prev, sourceId: id })),
      hiddenByFilter: hidden(waypointEditor.sourceId),
    };
  }, [waypointEditor.initial, waypointEditor.sourceId, waypointSources, hidden]);

  /** The one place a waypoint write leaves the browser. */
  const saveWaypoint = useCallback(
    async (input: WaypointInput) => {
      const editing = waypointEditor.initial;
      const sourceId = editing?.sourceId ?? waypointEditor.sourceId;
      if (!sourceId) throw new Error(t('mapPins.chooseSourceFirst', 'Choose a source first'));
      if (editing) await updateWaypoint(sourceId, editing.waypointId, input);
      else await createWaypoint(sourceId, input);
      void qc.invalidateQueries({ queryKey: ['waypoints', sourceId] });
    },
    [waypointEditor.initial, waypointEditor.sourceId, qc, t],
  );

  const closeWaypointEditor = useCallback(() => setWaypointEditor((prev) => ({ ...prev, open: false })), []);

  // ----- Local markers (never transmitted) -----

  const markerActionsFor = useCallback(
    (source: { id: string; name?: string }): MapMarkerPopupActions | undefined => {
      if (!markerSources.some((s) => s.id === source.id)) return undefined;
      return {
        canEdit: true,
        onEdit: (m) => setMarkerEditor({ open: true, initial: m, coords: null, sourceId: m.sourceId }),
        onDelete: (m) => {
          if (!window.confirm(t('localMarkers.confirmDelete', 'Delete local marker "{{label}}"?', { label: m.label }))) return;
          deleteMapMarker(m.sourceId, m.id)
            .then(() => qc.invalidateQueries({ queryKey: ['mapMarkers', m.sourceId] }))
            .catch((err: unknown) => window.alert(errorText(err, 'Failed to delete marker')));
        },
      };
    },
    [markerSources, qc, t],
  );

  const markerSourceChoice: PinSourceChoice = useMemo(() => {
    const editing = markerEditor.initial;
    if (editing) {
      const known = markerSources.find((s) => s.id === editing.sourceId);
      return { options: [known ?? { id: editing.sourceId, name: editing.sourceId }], value: editing.sourceId };
    }
    return {
      options: markerSources,
      value: markerEditor.sourceId,
      onChange: (id: string) => setMarkerEditor((prev) => ({ ...prev, sourceId: id })),
      hiddenByFilter: hidden(markerEditor.sourceId),
    };
  }, [markerEditor.initial, markerEditor.sourceId, markerSources, hidden]);

  const saveMarker = useCallback(
    async (input: MapMarkerInput) => {
      const editing = markerEditor.initial;
      const sourceId = editing?.sourceId ?? markerEditor.sourceId;
      if (!sourceId) throw new Error(t('mapPins.chooseSourceFirst', 'Choose a source first'));
      if (editing) await updateMapMarker(sourceId, editing.id, input);
      else await createMapMarker(sourceId, input);
      void qc.invalidateQueries({ queryKey: ['mapMarkers', sourceId] });
    },
    [markerEditor.initial, markerEditor.sourceId, qc, t],
  );

  const closeMarkerEditor = useCallback(() => setMarkerEditor((prev) => ({ ...prev, open: false })), []);

  return {
    placing,
    pickSpot,
    cancelPlacing,
    waypointActionsFor,
    markerActionsFor,
    waypoint: {
      open: waypointEditor.open,
      initial: waypointEditor.initial,
      coords: waypointEditor.coords,
      channels: waypointChannels,
      selfNodeNum: localNodeNum(waypointSourceId),
      sourceChoice: waypointSourceChoice,
      onSave: saveWaypoint,
      onClose: closeWaypointEditor,
    },
    marker: {
      open: markerEditor.open,
      initial: markerEditor.initial,
      coords: markerEditor.coords,
      sourceChoice: markerSourceChoice,
      onSave: saveMarker,
      onClose: closeMarkerEditor,
    },
  };
}

export type PinAuthoring = ReturnType<typeof usePinAuthoring>;
