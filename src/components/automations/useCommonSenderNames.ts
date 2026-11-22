import { useEffect, useState } from 'react';
import apiService from '../../services/api';

interface UsableNamesResponse {
  data?: { enabled?: boolean; allowedNames?: unknown; firmwareSupported?: boolean };
}

/** Names allowed on all of the given MeshCore sources. */
export function useCommonSenderNames(sourceIds: string[]): string[] {
  const [names, setNames] = useState<string[]>([]);
  const key = sourceIds.join('|');
  useEffect(() => {
    let cancelled = false;
    if (sourceIds.length === 0) { setNames([]); return; }
    void Promise.all(sourceIds.map(async (id): Promise<string[]> => {
      try {
        const r = await apiService.get<UsableNamesResponse>(`/api/sources/${encodeURIComponent(id)}/meshcore/sender-names`);
        const d = r?.data;
        return d?.enabled && d.firmwareSupported && Array.isArray(d.allowedNames)
          ? d.allowedNames.filter((n): n is string => typeof n === 'string')
          : [];
      } catch {
        return [];
      }
    })).then((lists) => {
      if (cancelled) return;
      const [first, ...rest] = lists;
      setNames((first ?? []).filter((n) => rest.every((l) => l.includes(n))));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #6341 `key` stands for the id list; the array identity changes every render
  }, [key]);
  return names;
}
