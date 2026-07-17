# Link Profile Polish — Implementation Spec (Terrain Link Profile Epic #4111, Phase 3, final)

**Branch:** `feature/link-profile-polish` (worktree `../meshmonitor-link-profile-polish`, based on `origin/main` incl. Phases 1+2 — merged PRs #4143 elevation backend + #4147 link-profile tool).

**Scope:** Frontend polish + one minimal, additive, non-secret backend field. Per-source frequency + RX-sensitivity auto-detection, DEM void handling, edge-case UX, map path verdict coloring, elevation-source settings UI, and user docs.

**Exit criteria (from epic):** frequency auto-populates per source; graceful degradation on missing data; docs published; full Vitest suite green; `npm run lint:ci` exits 0; merged.

---

## 0. Key decisions (read first)

1. **Auto-frequency mechanism = one minimal public backend field, not per-endpoint gated fetches.**
   The Map Analysis page is anonymous/public. The only per-source radio config reachable today is
   permission-gated: `GET /api/config/current` requires `configuration:read` (server.ts:4243) and
   `GET /api/sources/:id/meshcore/status` requires `connection:read` (meshcoreRoutes.ts:314). Neither
   is readable anonymously, and MeshCore has **no** ApiService client method at all. Rather than wire
   two divergent gated fetches (one needing a brand-new MeshCore client method) and accept "anonymous
   users never get auto-freq", we add **one additive, non-secret `radio` summary field to the already
   public `GET /api/sources` list** (`sourceRoutes.ts:242`, `optionalAuth`). Center frequency / region
   is inherently public RF information (it is broadcast over the air and printed on every node's config
   screen), so exposing it on the public sources payload carries no secret. The frontend already fetches
   this list via `useDashboardSources()` (used by `useAnalysisNodes`), so the client cost is ~0.
   - **Rejected alternative (no-backend, gated fetches):** does not satisfy "frequency auto-populates
     per source" on the tool's own public home; needs a new MeshCore client method anyway; splits into
     two permission paths that both 403 for the common anonymous embed viewer. Documented here so the
     orchestrator may downgrade to it if they explicitly prefer zero backend delta — in that case
     auto-freq works only for signed-in users with `configuration:read`/`connection:read` and the
     `radio` field / its route test are dropped.

2. **RX sensitivity is computed, not a magic table.** Meshtastic modem preset → (SF, BW) → sensitivity
   via the standard Semtech LoRa link-budget formula `S = -174 + 10·log10(BW_Hz) + NF + SNR_min(SF)`
   (NF ≈ 6 dB for SX1262). This is defensible, unit-testable, and avoids transcription errors. The
   editable number input stays; a preset dropdown is **out of scope** (cheap-only clause not met — the
   value already auto-seeds from the picked node).

3. **DEM void clamp lives in the backend provider** (cleanest — benefits `/profile` and `/test` and any
   future consumer). Terrarium bathymetry/void pixels decode to extreme negatives (−12000 m observed
   over Lake Pontchartrain). Values `< -500 m` (and a defensive `> 9000 m`) become `null` at the
   provider boundary. A defensive chart-domain guard in the drawer is redundant once the backend nulls
   them, so we add only a one-line comment there, not new logic.

4. **Map path verdict coloring reuses the existing Polyline.** `LinkProfileController` already draws a
   static amber `<Polyline pathOptions={{ color: '#f59e0b', weight: 3 }}>` (controller L158-168). We lift
   the computed verdict into `MapAnalysisContext`, the drawer writes it, and the Canvas passes it down as
   a prop so the controller stays prop-driven/testable.

5. **Edge-case UX is mostly already scaffolded.** The drawer already branches on `isLoading`,
   `isElevationDisabled`, generic `error`, and `allTerrainNull` (L175-185). Phase 3 only *refines* the
   generic error branch into friendly per-code messages (`IDENTICAL_POINTS`, `PATH_TOO_LONG`,
   `INVALID_COORDINATES`) — the server already rejects same-point picks with `IDENTICAL_POINTS`.

6. **Manual edit always wins.** Auto-seed writes `freqMhz`/`rxSensitivityDbm` only when (a) a *new*
   endpoint pair is picked and (b) the user has not manually edited that field for the current pair.

---

## 1. Reuse inventory (verified against the tree)

| Need | Reuse (file:line) |
|---|---|
| Region → center MHz math | `src/utils/loraFrequency.ts` `calculateLoRaFrequency(region, channelNum, overrideFrequency, frequencyOffset, bandwidth?, channelName?, modemPreset?)` — honors `overrideFrequency`, returns a **string** ("906.875 MHz"/"Unknown"). Region bounds table + DJB2 slot math already correct. Add a **numeric** sibling. |
| Modem preset enum → name/params | `loraFrequency.ts` `MODEM_PRESET_CHANNEL_NAMES` (0-13); `src/components/configuration/constants.ts` `MODEM_PRESET_OPTIONS` (SF/BW per preset in `params`). |
| Live per-source LoRa config (server) | `manager.getCurrentConfig().deviceConfig.lora` → `{ region, modemPreset, channelNum, overrideFrequency, frequencyOffset, bandwidth }` (meshtasticManager.ts:4737-4755). Reachable server-side via `resolveSourceManager(sourceId)`. |
| MeshCore per-source freq (server) | `isMeshCoreManager(m)` → `m.localNode?.radioFreq` (meshcoreManager.ts:328/5011). |
| Public sources list handler | `src/server/routes/sourceRoutes.ts:242` `router.get('/', optionalAuth(), …)`. |
| Sources list (frontend) | `useDashboardSources()` in `src/hooks/useDashboardData.ts` (already used by `useAnalysisNodes`). |
| Node → sourceId/nodeNum/isMeshCore | `AnalysisNode.node` (`NodeRecord`) has `sourceId?`, `nodeNum`, `isMeshCore?` (`useAnalysisNodes.ts`). Currently dropped when building `linkEndpointCandidates` from `measurePoints`. |
| Link-budget math | `src/utils/linkBudget.ts` `computeLinkBudget`, `fsplDb`, constants. |
| Verdict labels/colors | Currently **local** to `LinkProfileDrawer.tsx` (`VERDICT_LABEL`, `VERDICT_COLOR`). Promote to `src/utils/linkProfile.ts`. |
| Endpoint picker + Polyline | `src/components/MapAnalysis/LinkProfileController.tsx` (Polyline L158-168). |
| Transient tool state | `MapAnalysisContext.tsx` (`linkProfileMode`, `linkEndpoints`, setters). |
| Elevation provider decode | `src/server/services/elevationProvider.ts` (`decodeTerrariumTile`, `TerrariumTileProvider.sample`, `JsonPointProvider.fetchBatch`). |
| Elevation `/test` route | `elevationRoutes.ts:82` `POST /test` (`settings:write`), body `{ url, lat?, lng? }`, returns envelope `ok(res, TestResult)` where `TestResult = { success, detectedType, sampleElevation, latencyMs, httpStatus?, error? }`. **No client method yet.** |
| ApiService envelope unwrap | `api.getElevationProfile` (api.ts:1550) — the `.data` unwrap precedent. |
| Secret-URL settings UI precedent | `SettingsTab.tsx` Apprise API Server: plain-text `<input id="appriseApiServerUrl" autoComplete="off">` (L1979-1992) + Test button (L1998) calling `csrfFetch(.../test-apprise)` (L761) + colored result span (L2007-2015). `elevationSourceUrl` is in `SECRET_SETTINGS_KEYS` but `stripSecretSettings` returns the **unmasked** value to admins — identical handling to Apprise. |
| Settings save pattern | `SettingsTab` `handleSave` (L607) posts a body of `localFoo` values to `/api/settings` (L658-660); dep array at L729 lists every `localFoo`. `elevationEnabled`/`elevationSourceUrl` are already in `VALID_SETTINGS_KEYS` (Phase 1) — no constants change. |
| Availability gate (frontend) | `useElevationEnabled()` already reads `elevationEnabled` from public `/api/settings`. |
| Route test harness | `createRouteTestApp()` per CLAUDE.md (for the sources-radio route test). |
| Docs | `docs/features/map-analysis.md`, `docs/features/settings.md`, `docs/features/maps.md`, `docs/.vitepress/config.mts` sidebar, `README.md` "Key Features" (L243), `CHANGELOG.md` (Keep-a-Changelog). |

---

## 2. File-by-file changes

### Backend + shared pure utils

#### 2.1 `src/utils/loraFrequency.ts` (EDIT — add numeric export)
```ts
/**
 * Numeric center frequency (MHz) for a Meshtastic LoRa config, or null when it
 * can't be computed (region unset/unknown, invalid channel). Honors
 * overrideFrequency (delegates to calculateLoRaFrequency, which already does).
 */
export function loRaCenterFrequencyMhz(
  region: number,
  channelNum: number,
  overrideFrequency: number,
  frequencyOffset: number,
  bandwidth = 250,
  channelName?: string,
  modemPreset?: number,
): number | null {
  const s = calculateLoRaFrequency(region, channelNum, overrideFrequency, frequencyOffset, bandwidth, channelName, modemPreset);
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : null;
}
```
Reuses the battle-tested string function so the region table/DJB2 math is not duplicated. Also export a
region-code → short name map for provenance display, or reuse `REGION_OPTIONS` label prefix:
```ts
/** RegionCode → short name (e.g. 1 → "US"), for provenance hints. Values mirror config.proto. */
export const REGION_SHORT_NAME: Record<number, string> = { 1: 'US', 2: 'EU_433', 3: 'EU_868', /* … */ };
```
(Transcribe from the existing `regionFrequencyBounds` comments in this file; keep it a thin lookup.)

#### 2.2 `src/utils/linkBudget.ts` (EDIT — RX sensitivity from SF/BW/preset)
```ts
/** Demodulator SNR floor (dB) per LoRa spreading factor (Semtech SX1262 datasheet Table). */
export const LORA_SNR_LIMIT_DB: Record<number, number> = { 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

/** SX1262 receiver noise figure (dB). */
export const DEFAULT_NOISE_FIGURE_DB = 6;

/**
 * LoRa receiver sensitivity (dBm): S = -174 + 10·log10(BW_Hz) + NF + SNR_min(SF).
 * Standard thermal-noise link-budget formula; documented so values are derived, not magic.
 */
export function loRaSensitivityDbm(spreadingFactor: number, bandwidthKhz: number, noiseFigureDb = DEFAULT_NOISE_FIGURE_DB): number | null {
  const snr = LORA_SNR_LIMIT_DB[spreadingFactor];
  if (snr === undefined || bandwidthKhz <= 0) return null;
  return -174 + 10 * Math.log10(bandwidthKhz * 1000) + noiseFigureDb + snr;
}

/** Meshtastic modem-preset enum → (SF, BW kHz). Mirrors MODEM_PRESET_OPTIONS params. */
export const MODEM_PRESET_PARAMS: Record<number, { sf: number; bwKhz: number }> = {
  0: { sf: 11, bwKhz: 250 },  // LONG_FAST
  1: { sf: 12, bwKhz: 125 },  // LONG_SLOW
  /* … transcribe all 0-13 from src/components/configuration/constants.ts MODEM_PRESET_OPTIONS … */
};

/** RX sensitivity (dBm) for a Meshtastic modem preset, or null if unknown. */
export function rxSensitivityForModemPreset(modemPreset: number, noiseFigureDb = DEFAULT_NOISE_FIGURE_DB): number | null {
  const p = MODEM_PRESET_PARAMS[modemPreset];
  return p ? loRaSensitivityDbm(p.sf, p.bwKhz, noiseFigureDb) : null;
}
```

#### 2.3 `src/utils/linkProfile.ts` (EDIT — shared verdict styling + endpoint radio identity)
- Extend `LinkEndpoint`:
```ts
export interface LinkEndpoint {
  id: string; lat: number; lng: number; label?: string; isNode: boolean;
  sourceId?: string;   // #4111 P3: source that reported the node endpoint (for auto-freq)
  nodeNum?: number;    // #4111 P3
  isMeshCore?: boolean;// #4111 P3
}
```
- Move `VERDICT_LABEL` and `VERDICT_COLOR` here as exported consts (react-free module both the drawer and
  controller import):
```ts
export const VERDICT_LABEL: Record<LinkVerdict, string> = { clear: 'Clear', marginal: 'Marginal', obstructed: 'Obstructed' };
export const VERDICT_COLOR: Record<LinkVerdict, string> = { clear: '#22c55e', marginal: '#f59e0b', obstructed: '#ef4444' };
```
  Drawer imports them instead of its local copies (delete the local consts).

#### 2.4 `src/server/services/elevationProvider.ts` (EDIT — DEM void clamp)
```ts
/** Below this metres a Terrarium/DEM sample is a void/bathymetry artifact, not real terrain (#4111 P3). */
const MIN_VALID_ELEVATION_M = -500;
const MAX_VALID_ELEVATION_M = 9000;
function sanitizeElevation(v: number | null): number | null {
  if (v == null || !Number.isFinite(v) || v < MIN_VALID_ELEVATION_M || v > MAX_VALID_ELEVATION_M) return null;
  return v;
}
```
Apply `sanitizeElevation(...)` at every point the providers produce an elevation:
- `TerrariumTileProvider.sample` — wrap the decoded per-pixel value before it enters the result array
  and before it is written to `tileCache`/returned.
- `JsonPointProvider.fetchBatch` — wrap `items[j]?.elevation ?? null` before caching/returning.
Keep it a single shared helper so both providers agree. Void samples continue to surface as `elevation: null`
(the service and `analyzeLinkProfile` already exclude nulls from verdict/worst).

#### 2.5 `src/server/routes/sourceRoutes.ts` (EDIT — additive public `radio` summary)
In the `router.get('/', optionalAuth(), …)` handler (L242), for each source object returned, attach:
```ts
radio: computeSourceRadioSummary(sourceId) // : SourceRadioSummary | null
```
Add a local helper (near the top of the file, server-only, imports the pure client util — pure TS, already
imported server-side elsewhere, e.g. `elevationService` imports `../../utils/distance.js`):
```ts
import { loRaCenterFrequencyMhz, REGION_SHORT_NAME } from '../../utils/loraFrequency.js';
import { isMeshtasticManager, isMeshCoreManager } from '../sourceManagerTypes.js';

interface SourceRadioSummary {
  frequencyMhz: number | null;
  regionName?: string;   // meshtastic only
  modemPreset?: number;  // meshtastic only (drives RX-sensitivity auto-seed)
}

function computeSourceRadioSummary(sourceId: string): SourceRadioSummary | null {
  const mgr = sourceManagerRegistry.getManager(sourceId);
  if (!mgr) return null;
  if (isMeshtasticManager(mgr)) {
    const lora = mgr.getCurrentConfig()?.deviceConfig?.lora;
    if (!lora) return null;
    const freq = loRaCenterFrequencyMhz(
      Number(lora.region ?? 0), Number(lora.channelNum ?? 0),
      Number(lora.overrideFrequency ?? 0), Number(lora.frequencyOffset ?? 0),
      Number(lora.bandwidth ?? 250), undefined, Number(lora.modemPreset ?? 0),
    );
    return { frequencyMhz: freq, regionName: REGION_SHORT_NAME[Number(lora.region ?? 0)], modemPreset: Number(lora.modemPreset ?? 0) };
  }
  if (isMeshCoreManager(mgr)) {
    const f = mgr.localNode?.radioFreq;
    return { frequencyMhz: typeof f === 'number' && Number.isFinite(f) ? f : null };
  }
  return null; // MQTT / bridge sources have no local radio
}
```
Wrap the whole thing in `try/catch → null` so a manager that throws from `getCurrentConfig()` can never
break the sources list. **Permission reasoning:** `radio` is a public center frequency / region name —
non-secret RF info broadcast over the air; safe on the existing `optionalAuth` payload. No new route,
no secret exposure, additive only.

#### 2.6 `src/types/elevation.ts` (EDIT — test-result mirror)
```ts
/** Mirror of elevationService `TestResult` for the settings Test button (#4111 P3). */
export interface ElevationTestResult {
  success: boolean;
  detectedType: string;
  sampleElevation: number | null;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}
```

#### 2.7 `src/services/api.ts` (EDIT — elevation test method)
```ts
async testElevationSource(url: string, probe?: { lat: number; lng: number }): Promise<ElevationTestResult> {
  const res = await this.post<{ success: boolean; data: ElevationTestResult }>(
    '/api/elevation/test',
    probe ? { url, lat: probe.lat, lng: probe.lng } : { url },
  );
  return res.data; // unwrap envelope (same gotcha as getElevationProfile)
}
```
(Also extend the frontend sources type used by `useDashboardSources` to carry the optional
`radio?: SourceRadioSummary` — define `SourceRadioSummary` client-side in `src/types/elevation.ts` or a
`src/types/source.ts`; keep it a pure interface.)

### Frontend — auto-detect + edge UX

#### 2.8 `src/components/MapAnalysis/MapAnalysisCanvas.tsx` (EDIT)
Build `linkEndpointCandidates` from `analysisNodes` (not `measurePoints`) so radio identity survives:
```ts
const linkEndpointCandidates: LinkEndpoint[] = useMemo(
  () => analysisNodes.map((a) => ({
    id: a.key, lat: a.latLng[0], lng: a.latLng[1],
    label: a.node.shortName ?? undefined, isNode: true,
    sourceId: a.node.sourceId, nodeNum: a.node.nodeNum, isMeshCore: a.node.isMeshCore ?? false,
  })),
  [analysisNodes],
);
```
Pass the verdict to the controller (read from context — see 2.11):
```tsx
<LinkProfileController active={linkProfileMode} points={linkEndpointCandidates}
  endpoints={linkEndpoints} onPick={setLinkEndpoints} onExit={() => setLinkProfileMode(false)}
  verdict={linkVerdict} />
```

#### 2.9 `src/hooks/useAutoRadioDefaults.ts` (NEW)
```ts
/**
 * Derives auto-seed frequency + RX sensitivity + provenance for a picked endpoint
 * pair from the public per-source `radio` summary (GET /api/sources). Prefers a
 * node endpoint (A first, then B). Returns nulls when neither endpoint is a node
 * with a resolvable radio — the drawer then keeps the 915 MHz / -129 dBm defaults.
 */
export interface AutoRadioDefaults {
  freqMhz: number | null;
  rxSensitivityDbm: number | null;
  provenance: string | null; // e.g. "from Home Base (US)"
}
export function useAutoRadioDefaults(a?: LinkEndpoint, b?: LinkEndpoint): AutoRadioDefaults;
```
Implementation: `const { data: sources } = useDashboardSources();` find the source whose `id` matches the
chosen node endpoint's `sourceId`; read `source.radio`. `freqMhz = radio.frequencyMhz`;
`rxSensitivityDbm = radio.modemPreset != null ? rxSensitivityForModemPreset(radio.modemPreset) : null`;
`provenance = radio.frequencyMhz != null ? \`from ${source.name}${radio.regionName ? ` (${radio.regionName})` : ''}\` : null`.
No new fetch — reuses the cached sources query. Memoize on `[sources, a?.sourceId, a?.isNode, b?.sourceId, b?.isNode]`.

#### 2.10 `src/components/MapAnalysis/LinkProfileDrawer.tsx` (EDIT)
- Import shared `VERDICT_LABEL`/`VERDICT_COLOR` from `../../utils/linkProfile` (drop local copies).
- Auto-seed with manual-override-wins:
```ts
const auto = useAutoRadioDefaults(endpointA, endpointB);
const [freqEdited, setFreqEdited] = useState(false);
const [rxEdited, setRxEdited] = useState(false);
const pairKey = `${endpointA?.id ?? ''}|${endpointB?.id ?? ''}`;
// Reset "edited" flags when a NEW pair is picked.
useEffect(() => { setFreqEdited(false); setRxEdited(false); }, [pairKey]);
// Seed when not manually edited for this pair.
useEffect(() => { if (!freqEdited && auto.freqMhz != null) setFreqMhz(auto.freqMhz); }, [pairKey, auto.freqMhz, freqEdited]);
useEffect(() => { if (!rxEdited && auto.rxSensitivityDbm != null) setRxSensitivityDbm(auto.rxSensitivityDbm); }, [pairKey, auto.rxSensitivityDbm, rxEdited]);
```
  In the frequency input `onChange`, also `setFreqEdited(true)`; same for RX sensitivity → `setRxEdited(true)`.
  (Keep the existing `if (!Number.isNaN(v)) setFreqMhz(v)` guard.) Exhaustive-deps: list `pairKey`,
  `auto.freqMhz`/`auto.rxSensitivityDbm`, and the edited flags exactly as above — no suppressions.
- Provenance hint: under the Frequency input, render when `auto.provenance && !freqEdited`:
  `<span className="link-profile-provenance">{auto.provenance}</span>`.
- Write verdict to context (see 2.11): `useEffect(() => { setLinkVerdict(analysis?.verdict ?? null); }, [analysis?.verdict, setLinkVerdict]);`
  and clear on unmount: `useEffect(() => () => setLinkVerdict(null), [setLinkVerdict]);`
- Refine the generic `error` branch (L181-185) into friendly messages by `error.code`:
  `IDENTICAL_POINTS` → "Pick two different points."; `PATH_TOO_LONG` → "That link is too long to profile
  (max 500 km)."; `INVALID_COORDINATES` → "One of the points has invalid coordinates."; else the existing
  generic text. `ELEVATION_DISABLED` and `allTerrainNull` branches already exist — leave the all-null copy
  (e.g. "No terrain data along this path (open water or a DEM gap).").

#### 2.11 `src/components/MapAnalysis/MapAnalysisContext.tsx` (EDIT)
Add transient verdict slice:
```ts
linkVerdict: LinkVerdict | null;
setLinkVerdict: (v: LinkVerdict | null) => void;
```
`const [linkVerdict, setLinkVerdict] = useState<LinkVerdict | null>(null);` — provide in the context value.
(Import `LinkVerdict` type from `../../utils/linkProfile`.)

#### 2.12 `src/components/MapAnalysis/LinkProfileController.tsx` (EDIT — verdict color + antimeridian)
- Add `verdict?: LinkVerdict | null` to `LinkProfileControllerProps`; color the Polyline:
```tsx
pathOptions={{ color: verdict ? VERDICT_COLOR[verdict] : '#f59e0b', weight: 3 }}
```
  (Import `VERDICT_COLOR` from `../../utils/linkProfile`.)
- Antimeridian: when both endpoints exist, normalize endpoint B's longitude to the same 360° window as A
  before building the Polyline `positions`, so a link crossing ±180 draws the short way:
```ts
const bLngUnwrapped = endpointB ? endpointB.lng + 360 * Math.round((endpointA.lng - endpointB.lng) / 360) : undefined;
```
  Use `[endpointB.lat, bLngUnwrapped]` for the Polyline position only (leave the endpoint CircleMarker and
  the API call at the true lng). Small, self-contained; backend distance/interpolation already correct.

### Frontend — elevation-source settings UI

#### 2.13 `src/components/SettingsTab.tsx` (EDIT — Elevation / Terrain section, admin-gated)
Mirror the Apprise API Server pattern exactly (plain-text input + Test button + result span):
- Local state near the other `local*` fields:
  `const [localElevationEnabled, setLocalElevationEnabled] = useState(false);`
  `const [localElevationSourceUrl, setLocalElevationSourceUrl] = useState('');`
  `const [elevationTestResult, setElevationTestResult] = useState<{ ok: boolean; message: string } | null>(null);`
  `const [elevationTesting, setElevationTesting] = useState(false);`
- Load on mount inside the existing settings-fetch effect (alongside `setLocalAppriseApiServerUrl`), reading
  `settings.elevationEnabled` (string `'true'`/`'false'`) and `settings.elevationSourceUrl` (admins receive
  the unmasked value — `stripSecretSettings` returns the full map to admins).
- **`handleSave` (L607):** add `elevationEnabled: localElevationEnabled ? 'true' : 'false'` and
  `elevationSourceUrl: localElevationSourceUrl.trim()` to the POST body (near L660), and add
  `localElevationEnabled`, `localElevationSourceUrl` to the **dependency array at L729** (the documented
  gotcha — without this the save uses stale values).
- Test handler (uses ApiService, not raw fetch — new component code must not use raw `fetch`):
```ts
const handleTestElevation = useCallback(async () => {
  setElevationTesting(true); setElevationTestResult(null);
  try {
    const r = await api.testElevationSource(localElevationSourceUrl.trim());
    setElevationTestResult(r.success
      ? { ok: true, message: t('settings.elevation_test_success', 'OK — {{type}}, {{elev}} m in {{ms}} ms', { type: r.detectedType, elev: r.sampleElevation ?? 'n/a', ms: r.latencyMs }) }
      : { ok: false, message: r.error ?? 'Test failed' });
  } catch (e) {
    setElevationTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
  } finally { setElevationTesting(false); }
}, [localElevationSourceUrl, t]);
```
- Section JSX (place within the Maps/tileset area, `isAdmin`-gated like Apprise): an enable checkbox bound
  to `localElevationEnabled`; a text input `id="elevationSourceUrl"` (`autoComplete="off"`, placeholder
  showing the default terrarium template, helper text "Leave empty to use the default public AWS Terrarium
  source"); a "Test" button (`onClick={handleTestElevation}`, disabled while `elevationTesting`) and the
  colored `elevationTestResult` span. Register the section id in the settings-section list/nav array (mirror
  how `'settings-apprise-server'` is registered at L99/L1140) if the tab uses a section index.

---

## 3. Test plan (Vitest; route changes via `createRouteTestApp`)

| File | Assertions |
|---|---|
| `src/utils/loraFrequency.test.ts` (extend) | `loRaCenterFrequencyMhz`: US LongFast default → ~906.875; `overrideFrequency` set → that value; region 0/unknown → `null`; `REGION_SHORT_NAME[1]==='US'`. |
| `src/utils/linkBudget.test.ts` (extend) | `loRaSensitivityDbm(11,250)` ≈ −126.5 (±0.5); monotonic: higher SF ⇒ lower (more negative) sensitivity; narrower BW ⇒ lower; unknown SF/BW≤0 → `null`. `rxSensitivityForModemPreset(0)` finite; unknown preset → `null`. |
| `src/server/services/elevationProvider.test.ts` (extend) | Synthesized Terrarium pixel decoding to −12000 m ⇒ sample `null`; a >9000 m pixel ⇒ `null`; a valid 0 m ocean pixel and a +100 m pixel pass through unchanged. JSON provider: a `-9999`-style value ⇒ `null`. |
| `src/server/routes/sourceRoutes.*.test.ts` (new or extend, harness) | `GET /api/sources` (anonymous) includes `radio` per source: meshtastic mock manager → `{ frequencyMhz, regionName, modemPreset }`; meshcore mock → `{ frequencyMhz }` from `radioFreq`; MQTT/no-manager → `radio: null`; a manager whose `getCurrentConfig` throws ⇒ list still returns 200 with `radio: null`. |
| `src/services/api.test.ts` (extend, if present) | `testElevationSource` posts `{ url }` (or `{ url, lat, lng }`) and returns the unwrapped `.data`. |
| `src/hooks/useAutoRadioDefaults.test.tsx` (new) | Node endpoint with matching source radio → `{ freqMhz, rxSensitivityDbm, provenance }`; arbitrary (non-node) endpoints → all null; A preferred over B; missing `radio` → nulls; `modemPreset` absent → `rxSensitivityDbm: null` but `freqMhz` still set. |
| `src/components/MapAnalysis/LinkProfileDrawer.test.tsx` (extend) | Auto-seed sets freq + RX from mocked `useAutoRadioDefaults`; editing the freq input sets `freqEdited` so a re-render does **not** overwrite the user value; picking a new pair (changed `pairKey`) re-seeds; provenance hint renders when not edited and hides after edit; error branch renders the friendly `IDENTICAL_POINTS`/`PATH_TOO_LONG` copy by `error.code`. |
| `src/components/MapAnalysis/LinkProfileController.test.tsx` (extend) | Polyline `pathOptions.color` follows `verdict` (clear→green, marginal→amber, obstructed→red); `verdict` null → amber default; antimeridian pair (179 → −179) yields an unwrapped B-lng within 180° of A (no long-way line). |
| `src/components/SettingsTab.*.test.tsx` (extend/new) | Elevation enable + URL persist into the save POST body; Test button calls `api.testElevationSource` and renders the success/failure span; `handleSave` dep-array regression guard (edited value is included in the payload). |

Run the **full** suite (`npx vitest run`) + `npm run lint:ci` + `npm run build` before PR (per CLAUDE.md). No standalone scripts.

---

## 4. Work packages (Sonnet-sized, dependency-ordered)

### WP-1 — Backend field + shared math (no UI) *(start immediately)*
Files: 2.1 loraFrequency numeric + region names; 2.2 linkBudget RX-sensitivity; 2.3 linkProfile
(LinkEndpoint fields + promote VERDICT_* consts); 2.4 elevationProvider void clamp; 2.5 sourceRoutes
`radio` summary; 2.6 types; 2.7 ApiService `testElevationSource`. Tests: loraFrequency, linkBudget,
elevationProvider, sourceRoutes (harness), api client.
**Acceptance:** `GET /api/sources` returns per-source `radio` (meshtastic/meshcore/null) anonymously and
never 500s on a throwing manager; DEM void samples become `null`; new pure-math functions covered; drawer
still compiles against the moved VERDICT_* exports; full suite + `lint:ci` green.

### WP-2 — Auto-frequency + RX + drawer edge UX *(depends WP-1)*
Files: 2.8 Canvas candidates carry radio identity; 2.9 `useAutoRadioDefaults`; 2.10 drawer auto-seed +
override-wins + provenance + refined error messages. Tests: `useAutoRadioDefaults`, drawer.
**Acceptance:** picking a node endpoint auto-populates frequency (+ RX where a modem preset is known) with a
"from <source> (<region>)" hint; manual edits stick and win; a fresh pair re-seeds; anonymous/no-radio and
arbitrary-point endpoints gracefully keep 915 MHz / −129 dBm; `IDENTICAL_POINTS`/`PATH_TOO_LONG`/
`INVALID_COORDINATES`/all-null render friendly copy; exhaustive-deps clean, no suppressions.

### WP-3 — Map path verdict coloring + antimeridian + settings UI *(depends WP-1; parallel with WP-2)*
Files: 2.11 context verdict slice; 2.8 Canvas passes `verdict` (coordinate with WP-2 on the Canvas edit —
land WP-2's Canvas change first or merge carefully); 2.12 controller color + lng unwrap; 2.13 SettingsTab
elevation section. Tests: controller color/antimeridian, SettingsTab.
**Acceptance:** after analysis the picked path line turns green/amber/red by verdict and reverts to amber
when cleared; an antimeridian link draws the short way; admins can enable elevation, set/clear a custom
source URL (unmasked, saved via the settings POST with the dep-array fix), and the Test button reports
detected type + sample elevation + latency; `useElevationEnabled` continues to gate the toolbar button.

### WP-4 — Documentation *(use the `meshmonitor-docs-writer` agent; depends WP-1..3 for accurate copy)*
- `docs/features/map-analysis.md`: new "Link Profile / Terrain planning" section — how to open the tool,
  pick two nodes or arbitrary points, read the terrain/LOS/Fresnel chart + budget verdict, per-source
  frequency auto-detection with manual override, and graceful degradation (open water / no config).
- `docs/features/settings.md` (and/or `maps.md`): document the admin Elevation source setting (enable
  toggle, custom source URL as a server-side secret, Test button) and that the default is the public AWS
  Terrarium DEM with all fetches server-proxied via `safeFetch`.
- `docs/.vitepress/config.mts`: ensure `map-analysis` is in the Features sidebar (add if missing).
- `README.md` "Key Features" (L243): one bullet for terrain link profiling.
- `CHANGELOG.md`: add an entry under the next version (Keep-a-Changelog "Added" — per-source auto-frequency,
  terrain link profile polish, elevation-source settings + Test; "Fixed" — DEM void/bathymetry artifacts).
- `CLAUDE.md` / a dev-note: record the two Phase-3 invariants — (a) the public `GET /api/sources` `radio`
  summary is intentionally non-secret (RF center freq/region is public); (b) DEM values `< -500 m` are
  nulled at the provider boundary.
**Acceptance:** docs build (VitePress) clean; feature reachable from the sidebar; CHANGELOG + README updated.

---

## 5. Invariants honored / non-goals

- **Minimal, additive backend.** One new non-secret field on an existing public payload + a provider clamp
  + a client-method wrapper for the already-existing `/test` route. No new routes, no migration, no schema,
  no secret exposure. `elevationEnabled`/`elevationSourceUrl` keys already exist (Phase 1).
- **No raw `fetch()` in components/pages** — the settings Test button uses `ApiService.testElevationSource`.
  (`api.getCurrentConfig`'s raw `fetch` is pre-existing service-layer code, out of scope.)
- **No `any`, TS strict, exhaustive-deps** — auto-seed effects list exact deps; no suppressions. ESLint
  ratchet must not grow (`npm run lint:ci` exit 0).
- **Manual override always wins**; auto-seed is per-pair and one-shot.
- **Elevation is source-agnostic geometry** — no `sourceId` scoping on elevation data (Phase-1 rationale
  unchanged); the new `radio` summary is *read from* per-source managers but is not stored.
- **Node GPS altitude still unused** (Phase-2 datum-mismatch decision unchanged).
- **Out of scope:** RX-sensitivity preset dropdown; MeshCore RX-sensitivity derivation from sf/bw; the
  no-backend gated-fetch alternative (documented in §0.1 as rejected); GPS-altitude AGL datum work.
