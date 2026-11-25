/**
 * Walkabout Coverage fetchers (#5891 Phase 1). Spec §2.9.
 * Routes use ok()/fail(), so every fetcher reads `body.data`. `ApiError.code`
 * carries the server's machine code.
 */
import api from './api.js';
import type {
  WalkaboutSessionDto,
  WalkaboutSampleInput,
  WalkaboutSampleResult,
  WalkaboutSkipCounts,
  WalkaboutMapQuery,
  WalkaboutH3Res,
  WalkaboutCellsResult,
  WalkaboutCellNodesResult,
  WalkaboutTrackResult,
} from '../types/walkabout.js';

export interface WalkaboutLiveResult {
  session: WalkaboutSessionDto | null;
  skipped: WalkaboutSkipCounts | null;
}

interface Envelope<T> {
  success: boolean;
  data: T;
}

const base = (sourceId: string) => `/api/sources/${encodeURIComponent(sourceId)}/walkabout/sessions`;

export async function fetchWalkaboutSessions(sourceId: string): Promise<WalkaboutSessionDto[]> {
  const body = await api.get<Envelope<{ sessions: WalkaboutSessionDto[] }>>(base(sourceId));
  return body.data?.sessions ?? [];
}

export async function fetchLiveWalkabout(sourceId: string): Promise<WalkaboutLiveResult> {
  const body = await api.get<Envelope<WalkaboutLiveResult>>(`${base(sourceId)}/live`);
  return { session: body.data?.session ?? null, skipped: body.data?.skipped ?? null };
}

export async function startWalkabout(sourceId: string, name?: string): Promise<WalkaboutSessionDto> {
  const body = await api.post<Envelope<{ session: WalkaboutSessionDto }>>(
    base(sourceId),
    name ? { name } : {},
  );
  return body.data.session;
}

export async function postWalkaboutSamples(
  sourceId: string,
  sessionId: string,
  samples: WalkaboutSampleInput[],
): Promise<WalkaboutSampleResult> {
  const body = await api.post<Envelope<WalkaboutSampleResult>>(
    `${base(sourceId)}/${encodeURIComponent(sessionId)}/samples`,
    { samples },
  );
  return body.data;
}

export async function stopWalkabout(sourceId: string, sessionId: string): Promise<WalkaboutSessionDto> {
  const body = await api.post<Envelope<{ session: WalkaboutSessionDto }>>(
    `${base(sourceId)}/${encodeURIComponent(sessionId)}/stop`,
    {},
  );
  return body.data.session;
}

export async function deleteWalkabout(sourceId: string, sessionId: string): Promise<void> {
  await api.delete(`${base(sourceId)}/${encodeURIComponent(sessionId)}`);
}

// --- Phase 2: map (WALKABOUT_P2_SPEC.md §2.9) ---

/** Pure; used by query keys and fetchers. Never carries a fresh timestamp
 *  unless the caller passed one (range mode, from stable report state). */
export function walkaboutMapParams(q: WalkaboutMapQuery): Record<string, string> {
  const p: Record<string, string> = {};
  if (q.kind === 'window') p.window = q.window;
  else if (q.kind === 'session') p.sessionId = q.sessionId;
  else {
    p.since = String(q.sinceMs);
    p.until = String(q.untilMs);
  }
  if (q.node) p.node = q.node;
  return p;
}

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();
const walkaboutRoot = (sourceId: string) => `/api/sources/${encodeURIComponent(sourceId)}/walkabout`;

export async function fetchWalkaboutCells(
  sourceId: string,
  q: WalkaboutMapQuery,
  res: WalkaboutH3Res,
): Promise<WalkaboutCellsResult> {
  const body = await api.get<Envelope<WalkaboutCellsResult>>(
    `${walkaboutRoot(sourceId)}/cells?${qs({ ...walkaboutMapParams(q), res: String(res) })}`,
  );
  return body.data;
}

export async function fetchWalkaboutCellNodes(
  sourceId: string,
  q: WalkaboutMapQuery,
  cell: string,
): Promise<WalkaboutCellNodesResult> {
  const body = await api.get<Envelope<WalkaboutCellNodesResult>>(
    `${walkaboutRoot(sourceId)}/cell-nodes?${qs({ ...walkaboutMapParams(q), cell })}`,
  );
  return body.data;
}

export async function fetchWalkaboutTrack(sourceId: string, sessionId: string): Promise<WalkaboutTrackResult> {
  const body = await api.get<Envelope<WalkaboutTrackResult>>(
    `${base(sourceId)}/${encodeURIComponent(sessionId)}/track`,
  );
  return body.data;
}
