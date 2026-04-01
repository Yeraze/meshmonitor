import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCsrfFetch } from './useCsrfFetch';

export interface WidgetRange {
  min: number;
  max: number;
}

export const DEFAULT_GAUGE_RANGES: Record<string, WidgetRange> = {
  batteryLevel: { min: 0, max: 100 },
  temperature: { min: -20, max: 50 },
  humidity: { min: 0, max: 100 },
  voltage: { min: 0, max: 5 },
  pressure: { min: 950, max: 1050 },
};

const DEFAULT_RANGE: WidgetRange = { min: 0, max: 100 };

type WidgetRangeMap = Record<string, WidgetRange>;

function fetchWidgetRanges(): Promise<WidgetRangeMap> {
  return fetch('/api/settings')
    .then(res => (res.ok ? res.json() : {}))
    .then((settings: Record<string, unknown>) => {
      if (!settings.telemetryWidgetRanges) return {};
      try {
        return JSON.parse(settings.telemetryWidgetRanges as string) as WidgetRangeMap;
      } catch {
        return {};
      }
    })
    .catch(() => ({}));
}

export function useWidgetRange(nodeId: string, type: string): [WidgetRange, (r: WidgetRange) => void] {
  const key = `${nodeId}_${type}`;
  const queryClient = useQueryClient();
  const csrfFetch = useCsrfFetch();

  const { data: ranges } = useQuery<WidgetRangeMap>({
    queryKey: ['widgetRanges'],
    queryFn: fetchWidgetRanges,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  const mutation = useMutation({
    mutationFn: async (newRanges: WidgetRangeMap) => {
      const res = await csrfFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telemetryWidgetRanges: JSON.stringify(newRanges) }),
      });
      if (!res.ok) throw new Error(`Failed to save widget range: ${res.status}`);
    },
    onMutate: async (newRanges: WidgetRangeMap) => {
      await queryClient.cancelQueries({ queryKey: ['widgetRanges'] });
      const previous = queryClient.getQueryData<WidgetRangeMap>(['widgetRanges']);
      queryClient.setQueryData<WidgetRangeMap>(['widgetRanges'], newRanges);
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<WidgetRangeMap>(['widgetRanges'], context.previous);
      }
    },
  });

  const range: WidgetRange = ranges?.[key] ?? DEFAULT_GAUGE_RANGES[type] ?? DEFAULT_RANGE;

  const setRange = (r: WidgetRange) => {
    const current = queryClient.getQueryData<WidgetRangeMap>(['widgetRanges']) ?? {};
    mutation.mutate({ ...current, [key]: r });
  };

  return [range, setRange];
}
