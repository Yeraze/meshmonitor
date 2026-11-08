import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { NodeFilters } from '../types/ui';
import { normalizeNodeFilters } from '../utils/nodeAdvancedFilter';
import { logger } from '../utils/logger';

function readFilters(storageKey: string): NodeFilters {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) return normalizeNodeFilters(JSON.parse(saved));
  } catch (e) {
    logger.error('Failed to parse saved node filters:', e);
  }
  return normalizeNodeFilters(null);
}

/** Node filters persisted to localStorage under `storageKey` (#6259). */
export function usePersistedNodeFilters(storageKey: string): [NodeFilters, Dispatch<SetStateAction<NodeFilters>>] {
  const [filters, setFilters] = useState<NodeFilters>(() => readFilters(storageKey));
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(filters));
    } catch {
      // storage unavailable: keep in-memory state
    }
  }, [storageKey, filters]);
  return [filters, setFilters];
}
