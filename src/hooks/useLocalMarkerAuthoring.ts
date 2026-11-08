/**
 * useLocalMarkerAuthoring — create / edit / delete state for local map markers
 * (#5686), shared by every map that offers them (NodesTab, MeshCoreMap).
 *
 * Local markers are planning notes that are never transmitted. `canWrite` is
 * the caller's per-source `waypoints:write` grant. The map still draws the
 * markers itself (`LocalMarkers`), this hook only owns authoring.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapMarkers } from './useMapMarkers';
import type { MapMarker, MapMarkerInput } from '../types/mapMarker';

export interface LocalMarkerEditorState {
  open: boolean;
  initial: MapMarker | null;
  defaultCoords: { lat: number; lon: number } | null;
  close: () => void;
  save: (input: MapMarkerInput) => Promise<void>;
}

export interface LocalMarkerAuthoring {
  placing: boolean;
  setPlacing: (placing: boolean) => void;
  pickSpot: (lat: number, lon: number) => void;
  actions: {
    canEdit: boolean;
    onEdit: (m: MapMarker) => void;
    onDelete: (m: MapMarker) => void;
  };
  editor: LocalMarkerEditorState;
}

export function useLocalMarkerAuthoring(
  sourceId: string | null | undefined,
  canWrite: boolean,
): LocalMarkerAuthoring {
  const { t } = useTranslation();
  // Mutations only: `LocalMarkers` runs its own list query.
  const markerApi = useMapMarkers(sourceId, false);
  const [placing, setPlacing] = useState(false);
  const [open, setOpen] = useState(false);
  const [initial, setInitial] = useState<MapMarker | null>(null);
  const [defaultCoords, setDefaultCoords] = useState<{ lat: number; lon: number } | null>(null);

  const pickSpot = useCallback((lat: number, lon: number) => {
    setPlacing(false);
    setInitial(null);
    setDefaultCoords({ lat, lon });
    setOpen(true);
  }, []);

  const actions = useMemo(() => ({
    canEdit: canWrite,
    onEdit: (m: MapMarker) => {
      setInitial(m);
      setDefaultCoords(null);
      setOpen(true);
    },
    onDelete: (m: MapMarker) => {
      if (!window.confirm(t('localMarkers.confirmDelete', 'Delete local marker "{{label}}"?', { label: m.label }))) return;
      markerApi.remove(m.id).catch((err: unknown) => {
        window.alert(err instanceof Error ? err.message : 'Failed to delete marker');
      });
    },
  }), [canWrite, markerApi, t]);

  const save = useCallback(async (input: MapMarkerInput) => {
    if (initial) await markerApi.update({ id: initial.id, input });
    else await markerApi.create(input);
  }, [initial, markerApi]);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!placing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPlacing(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placing]);

  return {
    placing,
    setPlacing,
    pickSpot,
    actions,
    editor: { open, initial, defaultCoords, close, save },
  };
}
