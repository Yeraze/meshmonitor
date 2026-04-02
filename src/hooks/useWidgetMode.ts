import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCsrfFetch } from './useCsrfFetch';

export type WidgetMode = 'chart' | 'gauge' | 'numeric';

type WidgetModeMap = Record<string, WidgetMode>;

function fetchWidgetModes(baseUrl: string): Promise<WidgetModeMap> {
  return fetch(`${baseUrl}/api/settings`)
    .then(res => (res.ok ? res.json() : {}))
    .then((settings: Record<string, unknown>) => {
      if (!settings.telemetryWidgetModes) return {};
      try {
        return JSON.parse(settings.telemetryWidgetModes as string) as WidgetModeMap;
      } catch {
        return {};
      }
    })
    .catch(() => ({}));
}

export function useWidgetMode(nodeId: string, type: string, baseUrl = ''): [WidgetMode, (m: WidgetMode) => void] {
  const key = `${nodeId}_${type}`;
  const queryClient = useQueryClient();
  const csrfFetch = useCsrfFetch();

  const { data: modes } = useQuery<WidgetModeMap>({
    queryKey: ['widgetModes'],
    queryFn: () => fetchWidgetModes(baseUrl),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  const mutation = useMutation({
    mutationFn: async (newModes: WidgetModeMap) => {
      const res = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telemetryWidgetModes: JSON.stringify(newModes) }),
      });
      if (!res.ok) throw new Error(`Failed to save widget mode: ${res.status}`);
    },
    onMutate: async (newModes: WidgetModeMap) => {
      await queryClient.cancelQueries({ queryKey: ['widgetModes'] });
      const previous = queryClient.getQueryData<WidgetModeMap>(['widgetModes']);
      queryClient.setQueryData<WidgetModeMap>(['widgetModes'], newModes);
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<WidgetModeMap>(['widgetModes'], context.previous);
      }
    },
  });

  const mode: WidgetMode = modes?.[key] ?? 'chart';

  const setMode = (m: WidgetMode) => {
    const current = queryClient.getQueryData<WidgetModeMap>(['widgetModes']) ?? {};
    mutation.mutate({ ...current, [key]: m });
  };

  return [mode, setMode];
}
