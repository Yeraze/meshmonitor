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
