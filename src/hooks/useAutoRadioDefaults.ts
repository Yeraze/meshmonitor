/**
 * Auto-frequency / RX-sensitivity defaults for the Terrain Link Profile tool
 * (epic #4111, Phase 3, WP-2). Derives a suggested center frequency + RX
 * sensitivity + a human-readable provenance string from the picked endpoint
 * pair's per-source `radio` summary (the public, non-secret field added to
 * `GET /api/sources` in WP-1 — see `src/types/elevation.ts`
 * `SourceRadioSummary` and `src/hooks/useDashboardData.ts`
 * `DashboardSource.radio`).
 *
 * Prefers endpoint A when both are resolvable node endpoints (spec
 * LINK_PROFILE_POLISH_SPEC.md §2.9). Returns all-null when neither endpoint
 * is a node with a matching, radio-reporting source — the drawer then keeps
 * its documented 915 MHz / −129 dBm defaults. No network fetch of its own;
 * reuses the already-polled `useDashboardSources()` query.
 *
 * WP-2 follow-up (browser-validation fix): a unified-merged node's bare
 * `sourceId` is whichever source most recently reported it (see
 * `mergeNodeRecords` in `useDashboardData.ts`), which for a multi-source node
 * is frequently a radio-less MQTT bridge. `LinkEndpoint.sourceIds` carries
 * the node's FULL source membership (newest-first, primary `sourceId`
 * first) — we walk endpoint A's full list, then endpoint B's, and seed from
 * the first source in that order that actually reports a `radio.frequencyMhz`.
 */
import { useMemo } from 'react';
import { useDashboardSources } from './useDashboardData';
import { rxSensitivityForModemPreset } from '../utils/linkBudget';
import type { LinkEndpoint } from '../utils/linkProfile';

export interface AutoRadioDefaults {
  freqMhz: number | null;
  rxSensitivityDbm: number | null;
  /** e.g. "from Home Base (US)"; null whenever freqMhz is null. */
  provenance: string | null;
}

const EMPTY_DEFAULTS: AutoRadioDefaults = { freqMhz: null, rxSensitivityDbm: null, provenance: null };

/** Every source id that reported this endpoint's node, primary first, truthy-filtered. Empty for non-node endpoints. */
function candidateSourceIds(endpoint?: LinkEndpoint): string[] {
  if (!endpoint?.isNode) return [];
  const ids = endpoint.sourceIds ?? [endpoint.sourceId];
  return ids.filter((id): id is string => !!id);
}

export function useAutoRadioDefaults(a?: LinkEndpoint, b?: LinkEndpoint): AutoRadioDefaults {
  const { data: sources } = useDashboardSources();

  // Computed outside the memo (plain, cheap array ops) and reduced to stable
  // string keys so the memo's dependency array doesn't churn on `a`/`b`
  // object identity or need to read `a`/`b` directly (exhaustive-deps stays
  // satisfied with primitive deps — no suppression).
  const aIdsKey = candidateSourceIds(a).join(',');
  const bIdsKey = candidateSourceIds(b).join(',');

  return useMemo((): AutoRadioDefaults => {
    if (!sources) return EMPTY_DEFAULTS;

    const orderedIds = [...(aIdsKey ? aIdsKey.split(',') : []), ...(bIdsKey ? bIdsKey.split(',') : [])];
    for (const id of orderedIds) {
      const source = sources.find(s => s.id === id);
      const radio = source?.radio;
      if (!source || !radio || radio.frequencyMhz == null) continue;

      const rxSensitivityDbm =
        radio.modemPreset != null ? rxSensitivityForModemPreset(radio.modemPreset) : null;
      const provenance = `from ${source.name}${radio.regionName ? ` (${radio.regionName})` : ''}`;
      return { freqMhz: radio.frequencyMhz, rxSensitivityDbm, provenance };
    }

    return EMPTY_DEFAULTS;
  }, [sources, aIdsKey, bIdsKey]);
}
