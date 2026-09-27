/**
 * Glue between a Map Features panel and `AircraftTrailsLayer` (#5364/#5365
 * Phase 3). Both panels (NodesTab and DashboardMap) call this with the node
 * list they draw markers from, so the trail rules live in one place.
 */
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapContext } from '../../contexts/MapContext';
import { useSettings } from '../../contexts/SettingsContext';
import { useAircraftTrails } from '../../hooks/useAircraftTrails';
import { formatDateTime } from '../../utils/datetime';
import {
  aircraftNodeLabel,
  buildAircraftTrailDescriptors,
  collectVisibleAircraft,
  type AircraftLabelNode,
  type AircraftTrailDescriptor,
  type AircraftTrailViewMode,
  type TrailEligibleNode,
} from './aircraftTrails';

export interface UseAircraftTrailLayerArgs<T extends TrailEligibleNode & AircraftLabelNode> {
  /** The nodes the panel draws markers for, after every map filter. */
  drawnNodes: readonly T[];
  /** Per-source or unified; null turns trails off (no source selected). */
  mode: AircraftTrailViewMode | null;
  /** False where the layer can't render (e.g. the 3D view). */
  available?: boolean;
}

export interface AircraftTrailLayerState {
  trails: AircraftTrailDescriptor[];
  formatTooltip: (label: string, ts: number) => string;
}

const EMPTY: AircraftTrailDescriptor[] = [];

export function useAircraftTrailLayer<T extends TrailEligibleNode & AircraftLabelNode>({
  drawnNodes,
  mode,
  available = true,
}: UseAircraftTrailLayerArgs<T>): AircraftTrailLayerState {
  const { t } = useTranslation();
  const { showAircraftTrails, aircraftTrailHours } = useMapContext();
  const { timeFormat, dateFormat } = useSettings();

  const visible = collectVisibleAircraft(drawnNodes, aircraftNodeLabel);
  // Stable signature so descriptors rebuild only when the drawn aircraft set
  // (or a name) changes, not on every panel render.
  const visibleSig = Array.from(visible, ([num, label]) => `${num}=${label}`).join('|');

  const enabled = showAircraftTrails && available && mode !== null && visible.size > 0;
  const sourceIds = mode?.kind === 'source' ? [mode.sourceId] : null;
  const { data } = useAircraftTrails({ enabled, hours: aircraftTrailHours, sourceIds });

  const modeKey = mode === null ? '' : mode.kind === 'source' ? `source:${mode.sourceId}` : 'unified';
  const trails = useMemo(() => {
    if (!enabled || !data || mode === null) return EMPTY;
    return buildAircraftTrailDescriptors(data, visible, mode);
    // `visible` and `mode` are fresh objects each render; their string
    // signatures stand in for them.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #5365 visibleSig/modeKey are the value signatures of visible/mode
  }, [enabled, data, visibleSig, modeKey]);

  const formatTooltip = useCallback(
    (label: string, ts: number) =>
      t('map.aircraftTrailTooltip', {
        name: label,
        time: formatDateTime(new Date(ts), timeFormat, dateFormat),
        defaultValue: '{{name}} at {{time}}',
      }),
    [t, timeFormat, dateFormat],
  );

  return { trails, formatTooltip };
}
