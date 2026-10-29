import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordOwnTelemetryRequest,
  isAnswerToOwnTelemetryRequest,
  resetOwnTelemetryRequestsForTests,
  OWN_TELEMETRY_REQUEST_TTL_MS,
  OWN_TELEMETRY_REQUEST_MAX,
} from './ownTelemetryRequests.js';

describe('ownTelemetryRequests (trigger.telemetry loop guard)', () => {
  beforeEach(() => resetOwnTelemetryRequestsForTests());

  it('recognises a reply to a request we sent', () => {
    recordOwnTelemetryRequest(4242, 1_000);
    expect(isAnswerToOwnTelemetryRequest(4242, 2_000)).toBe(true);
  });

  it('ignores unknown, zero and missing request ids', () => {
    recordOwnTelemetryRequest(4242, 1_000);
    expect(isAnswerToOwnTelemetryRequest(999, 2_000)).toBe(false);
    expect(isAnswerToOwnTelemetryRequest(0, 2_000)).toBe(false);
    expect(isAnswerToOwnTelemetryRequest(undefined, 2_000)).toBe(false);
    recordOwnTelemetryRequest(0, 1_000);
    expect(isAnswerToOwnTelemetryRequest(0, 2_000)).toBe(false);
  });

  it('forgets a request after the TTL', () => {
    recordOwnTelemetryRequest(7, 1_000);
    expect(isAnswerToOwnTelemetryRequest(7, 1_000 + OWN_TELEMETRY_REQUEST_TTL_MS)).toBe(true);
    expect(isAnswerToOwnTelemetryRequest(7, 1_001 + OWN_TELEMETRY_REQUEST_TTL_MS)).toBe(false);
  });

  it('stays bounded, dropping the oldest ids first', () => {
    for (let i = 1; i <= OWN_TELEMETRY_REQUEST_MAX + 10; i++) recordOwnTelemetryRequest(i, 1_000);
    expect(isAnswerToOwnTelemetryRequest(1, 1_000)).toBe(false);
    expect(isAnswerToOwnTelemetryRequest(OWN_TELEMETRY_REQUEST_MAX + 10, 1_000)).toBe(true);
  });
});
