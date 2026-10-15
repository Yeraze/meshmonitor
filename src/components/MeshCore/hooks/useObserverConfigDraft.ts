/**
 * The Analyzer Observer's broker list as a SaveBar draft (#5831, part of #5797).
 *
 * The editable part of `sources.config.observer` (enable, region, brokers[])
 * used to live in the Dashboard source modal. It is edited here now, on the
 * MeshCore Configuration page, and saved through the same route the modal
 * used: PUT /api/sources/:id with the source's whole config and a rebuilt
 * `observer` block. The server merges that over the stored config
 * (mergeSourceConfigOnSave), so stored secrets the viewer was not shown stay
 * put, and it calls reconfigureObserver once, so the brokers reconnect once.
 *
 * Broker passwords and the signing key are NOT part of this draft: they keep
 * their own routes and save on their own buttons.
 *
 * The baseline moves only on a save the server accepted, or when the stored
 * block changes (the source list refetches after a save, or someone else
 * edited it). Nothing is written on mount.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDashboardSources } from '../../../hooks/useDashboardData';
import { useSaveBar } from '../../../hooks/useSaveBar';
import apiService, { ApiError } from '../../../services/api';
import { queryClient } from '../../../config/queryClient';
import {
  buildObserverConfig,
  emptyObserverBrokerForm,
  MAX_OBSERVER_BROKERS,
  OBSERVER_BROKER_PRESETS,
  observerBrokerFormFromPreset,
  observerErrorMessageKey,
  observerFormFromConfig,
  type ObserverBrokerForm,
  type ObserverForm,
} from '../observerConfig';

/** The form without the client-only row ids, for change detection. */
function comparable(form: ObserverForm): string {
  return JSON.stringify({
    enabled: form.enabled,
    iataCode: form.iataCode,
    brokers: form.brokers.map(({ id: _id, ...rest }) => rest),
  });
}

interface DraftState {
  draft: ObserverForm;
  baseline: ObserverForm;
  /** JSON of the stored block the baseline came from; null before the source list loads. */
  seenKey: string | null;
}

export interface ObserverConfigDraft {
  /** False until the source list has loaded this source. */
  loaded: boolean;
  draft: ObserverForm;
  hasChanges: boolean;
  isSaving: boolean;
  /** The last validation or save error, ready to show. */
  error: string | null;
  setEnabled: (enabled: boolean) => void;
  setIataCode: (iataCode: string) => void;
  /** Add a row from a preset id (`custom` adds a blank row). No-op at the cap. */
  addBroker: (presetId: string) => void;
  updateBroker: (rowId: string, patch: Partial<ObserverBrokerForm>) => void;
  removeBroker: (rowId: string) => void;
}

export function useObserverConfigDraft(
  sourceId: string,
  options: { canEdit: boolean; sectionName: string },
): ObserverConfigDraft {
  const { t } = useTranslation();
  const { data: sources } = useDashboardSources();
  const source = sources?.find((s) => s.id === sourceId);
  const config = (source?.config ?? undefined) as Record<string, unknown> | undefined;
  const stored = config?.observer;
  const storedKey = source ? JSON.stringify(stored ?? null) : null;

  const [state, setState] = useState<DraftState>(() => {
    const form = observerFormFromConfig(stored);
    return { draft: form, baseline: form, seenKey: storedKey };
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed during render (as useSectionBaseline does) so the render that
  // shows the new stored block never flags it as a change. Unsaved edits
  // survive a background refetch; only the baseline moves under them.
  let current = state;
  if (state.seenKey !== storedKey) {
    const form = observerFormFromConfig(stored);
    const dirty = comparable(state.draft) !== comparable(state.baseline);
    current = { draft: dirty ? state.draft : form, baseline: form, seenKey: storedKey };
    setState(current);
  }

  const dirty = comparable(current.draft) !== comparable(current.baseline);
  const hasChanges = options.canEdit && source !== undefined && dirty;

  const update = useCallback((fn: (form: ObserverForm) => ObserverForm) => {
    setState((s) => ({ ...s, draft: fn(s.draft) }));
  }, []);

  const save = async () => {
    const sent = current.draft;
    const built = buildObserverConfig(sent);
    if (built.error) {
      setError(t(built.error.key, built.error.fallback, built.error.params));
      return;
    }
    if (!source || !built.config) return;
    setIsSaving(true);
    setError(null);
    try {
      await apiService.put(`/api/sources/${sourceId}`, {
        config: { ...(config ?? {}), observer: built.config },
      });
      setState((s) => ({ ...s, baseline: sent }));
      void queryClient.invalidateQueries({ queryKey: ['dashboard', 'sources'] });
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { error?: string; code?: string } | undefined;
        const key = observerErrorMessageKey(err.code ?? body?.code);
        setError(key ? t(key, body?.error ?? err.message) : (body?.error ?? err.message));
      } else {
        setError(t('meshcore.observer.err_network', 'Could not reach MeshMonitor. Check your connection and retry.'));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const dismiss = () => {
    setState((s) => ({ ...s, draft: s.baseline }));
    setError(null);
  };

  useSaveBar({
    id: 'meshcore-observer-config',
    sectionName: options.sectionName,
    hasChanges,
    isSaving,
    onSave: save,
    onDismiss: dismiss,
  });

  return {
    loaded: source !== undefined,
    draft: current.draft,
    hasChanges,
    isSaving,
    error,
    setEnabled: (enabled) => update((f) => ({ ...f, enabled })),
    setIataCode: (iataCode) => update((f) => ({ ...f, iataCode })),
    addBroker: (presetId) =>
      update((f) => {
        if (f.brokers.length >= MAX_OBSERVER_BROKERS) return f;
        const preset = OBSERVER_BROKER_PRESETS.find((p) => p.id === presetId);
        const row = preset ? observerBrokerFormFromPreset(preset) : emptyObserverBrokerForm();
        return { ...f, brokers: [...f.brokers, row] };
      }),
    updateBroker: (rowId, patch) =>
      update((f) => ({
        ...f,
        brokers: f.brokers.map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
      })),
    removeBroker: (rowId) => update((f) => ({ ...f, brokers: f.brokers.filter((row) => row.id !== rowId) })),
  };
}
