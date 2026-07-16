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

export function useAutoRadioDefaults(a?: LinkEndpoint, b?: LinkEndpoint): AutoRadioDefaults {
  const { data: sources } = useDashboardSources();

  return useMemo((): AutoRadioDefaults => {
    const candidateSourceId =
      a?.isNode && a.sourceId ? a.sourceId : b?.isNode && b.sourceId ? b.sourceId : undefined;
    if (!candidateSourceId || !sources) return EMPTY_DEFAULTS;

    const source = sources.find(s => s.id === candidateSourceId);
    const radio = source?.radio;
    if (!source || !radio || radio.frequencyMhz == null) return EMPTY_DEFAULTS;

    const rxSensitivityDbm =
      radio.modemPreset != null ? rxSensitivityForModemPreset(radio.modemPreset) : null;
    const provenance = `from ${source.name}${radio.regionName ? ` (${radio.regionName})` : ''}`;

    return { freqMhz: radio.frequencyMhz, rxSensitivityDbm, provenance };
  }, [sources, a?.sourceId, a?.isNode, b?.sourceId, b?.isNode]);
}
