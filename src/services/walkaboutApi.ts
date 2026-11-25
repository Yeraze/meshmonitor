/**
 * Walkabout Coverage fetchers (#5891 Phase 1). Spec §2.9.
 * Routes use ok()/fail(), so every fetcher reads `body.data`. `ApiError.code`
 * carries the server's machine code. WP0 SKELETON: bodies land in WP4.
 */
import type {
  WalkaboutSessionDto,
  WalkaboutSampleInput,
  WalkaboutSampleResult,
  WalkaboutSkipCounts,
} from '../types/walkabout.js';

const NOT_IMPLEMENTED = 'not implemented';

export interface WalkaboutLiveResult {
  session: WalkaboutSessionDto | null;
  skipped: WalkaboutSkipCounts | null;
}

export async function fetchWalkaboutSessions(_sourceId: string): Promise<WalkaboutSessionDto[]> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function fetchLiveWalkabout(_sourceId: string): Promise<WalkaboutLiveResult> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function startWalkabout(_sourceId: string, _name?: string): Promise<WalkaboutSessionDto> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function postWalkaboutSamples(
  _sourceId: string,
  _sessionId: string,
  _samples: WalkaboutSampleInput[],
): Promise<WalkaboutSampleResult> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function stopWalkabout(_sourceId: string, _sessionId: string): Promise<WalkaboutSessionDto> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function deleteWalkabout(_sourceId: string, _sessionId: string): Promise<void> {
  throw new Error(NOT_IMPLEMENTED);
}
