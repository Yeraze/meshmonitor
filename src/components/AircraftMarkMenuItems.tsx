/**
 * Node Details Actions menu entries for the manual aircraft mark (#5715):
 * "Mark as not aircraft", "Mark as aircraft", "Clear aircraft override".
 *
 * Shown only on a source aircraft detection runs on (not MeshCore or
 * Reticulum) and only to a user with `nodes:write` on that source; the
 * server checks the same permission. Database-only: nothing is sent to the
 * mesh. On success the poll cache is patched at once and refetched, so the
 * classifier's follow-up verdict lands without waiting for the next poll.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { DeviceInfo } from '../types/device';
import { useAuth } from '../contexts/AuthContext';
import { useSource } from '../contexts/SourceContext';
import { useToast } from './ToastContainer';
import apiService from '../services/api';
import { setNodeFieldInCache } from '../hooks/useServerData';
import { sourcePollQueryKey } from '../hooks/usePoll';
import { UiIcon } from './icons';
import { AIRCRAFT_EXCLUDED_SOURCE_TYPES, aircraftMarkActions } from '../utils/aircraftClassification';

type Mode = 'not_aircraft' | 'aircraft' | 'clear';

interface Props {
  node: DeviceInfo;
  /** Called after a click, whatever the outcome (closes the menu). */
  onDone: () => void;
}

/** Shape of the all-sources mark response (#6046). */
interface MarkSource {
  sourceId: string;
  sourceName: string;
}
interface AllSourcesMarkResponse {
  success: boolean;
  data?: { applied?: MarkSource[]; skipped?: (MarkSource & { code: string; message: string })[] };
}

const AircraftMarkMenuItems: React.FC<Props> = ({ node, onDone }) => {
  const { t } = useTranslation();
  const { hasPermission, authStatus } = useAuth();
  const { sourceId, sourceType } = useSource();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // Opt-in: apply the mark to every source that carries the node (#6046).
  const [allSources, setAllSources] = useState(false);

  if (!sourceId) return null;
  if (sourceType && AIRCRAFT_EXCLUDED_SOURCE_TYPES.has(sourceType)) return null;
  if (!hasPermission('nodes', 'write', { sourceId })) return null;

  const actions = aircraftMarkActions(node);
  if (!actions.notAircraft && !actions.aircraft && !actions.clear) return null;

  const baseToast = (mode: Mode): string =>
    mode === 'not_aircraft'
      ? t('aircraft_mark.toast_not_aircraft', 'Marked as not aircraft')
      : mode === 'aircraft'
        ? t('aircraft_mark.toast_aircraft', 'Marked as aircraft')
        : t('aircraft_mark.toast_cleared', 'Aircraft override cleared');

  const run = async (mode: Mode) => {
    if (busy) return;
    setBusy(true);
    try {
      const body = allSources
        ? { sourceId, nodeNum: node.nodeNum, mode, allSources: true }
        : { sourceId, nodeNum: node.nodeNum, mode };
      const resp = await apiService.post<AllSourcesMarkResponse>('/api/aircraft/mark', body);
      const now = Date.now();
      const by = authStatus?.user?.id ?? null;
      const patch: Partial<DeviceInfo> =
        mode === 'not_aircraft'
          ? { likelyAircraft: false, aircraftManualMark: 'not_aircraft', aircraftManualMarkAt: now, aircraftManualMarkBy: by, aircraftFixedAt: now }
          : mode === 'aircraft'
            ? { likelyAircraft: true, aircraftManualMark: 'aircraft', aircraftManualMarkAt: now, aircraftManualMarkBy: by, aircraftFixedAt: null }
            : { aircraftManualMark: null, aircraftManualMarkAt: null, aircraftManualMarkBy: null, aircraftFixedAt: null };
      setNodeFieldInCache(queryClient, sourceId, node.nodeNum, patch);
      void queryClient.invalidateQueries({ queryKey: sourcePollQueryKey(sourceId) });
      if (allSources) {
        const applied = resp?.data?.applied ?? [];
        const skipped = resp?.data?.skipped ?? [];
        // The applied list names which sources now carry the mark; skipped
        // names the ones the user cannot write (or that can't take it).
        const appliedMsg = t('aircraft_mark.toast_all_applied', '{{base}} on {{count}} source(s): {{names}}', {
          base: baseToast(mode),
          count: applied.length,
          names: applied.map((s) => s.sourceName).join(', '),
        });
        if (skipped.length > 0) {
          showToast(
            t('aircraft_mark.toast_all_skipped', '{{applied}}. Skipped {{count}}: {{names}}', {
              applied: appliedMsg,
              count: skipped.length,
              names: skipped.map((s) => s.sourceName).join(', '),
            }),
            'warning',
          );
        } else {
          showToast(appliedMsg, 'success');
        }
      } else {
        showToast(baseToast(mode), 'success');
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      showToast(
        code === 'AIRCRAFT_NO_POSITION'
          ? t('aircraft_mark.error_no_position', 'This node has no known position, so it cannot be marked as not aircraft.')
          : code === 'AIRCRAFT_DETECTION_DISABLED'
            ? t('aircraft_mark.error_detection_disabled', 'Aircraft detection is off for this source.')
            : t('aircraft_mark.error_generic', 'Could not update the aircraft mark.'),
        'error',
      );
    } finally {
      setBusy(false);
      onDone();
    }
  };

  return (
    <>
      <label className="actions-menu-item" data-testid="aircraft-mark-all-sources">
        <input
          type="checkbox"
          checked={allSources}
          disabled={busy}
          onChange={(e) => setAllSources(e.target.checked)}
          data-testid="aircraft-mark-all-sources-checkbox"
        />
        {t('aircraft_mark.apply_all_sources', 'Apply to all sources')}
      </label>
      {actions.notAircraft && (
        <button className="actions-menu-item" disabled={busy} onClick={() => void run('not_aircraft')} data-testid="aircraft-mark-not-aircraft">
          <UiIcon name="aircraft" /> {t('aircraft_mark.mark_not_aircraft', 'Mark as not aircraft')}
        </button>
      )}
      {actions.aircraft && (
        <button className="actions-menu-item" disabled={busy} onClick={() => void run('aircraft')} data-testid="aircraft-mark-aircraft">
          <UiIcon name="aircraft" /> {t('aircraft_mark.mark_aircraft', 'Mark as aircraft')}
        </button>
      )}
      {actions.clear && (
        <button className="actions-menu-item" disabled={busy} onClick={() => void run('clear')} data-testid="aircraft-mark-clear">
          <UiIcon name="aircraft" /> {t('aircraft_mark.clear', 'Clear aircraft override')}
        </button>
      )}
    </>
  );
};

export default AircraftMarkMenuItems;
