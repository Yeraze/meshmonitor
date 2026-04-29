/**
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';

const mockGetEnvironmentConfig = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    databasePath: ':memory:',
    databasePathProvided: true,
    baseUrl: '/',
    port: 8080,
    debug: false,
    mqttUrl: null,
    mqttUsername: null,
    mqttPassword: null,
    mqttChannelKey: null,
    mqttTopicPrefix: 'msh',
    mqttEnabled: false,
    mapboxToken: null,
    mapTilerKey: null,
    sessionSecret: 'test-secret',
    allowedOrigins: [],
    retroactiveDecryptionBatchSize: 100,
    oidcEnabled: false,
    oidcIssuerUrl: null,
    oidcClientId: null,
    oidcClientSecret: null,
    oidcRedirectUri: null,
    oidcDisplayName: 'OIDC',
  })
);

vi.mock('../server/config/environment.js', () => ({
  getEnvironmentConfig: mockGetEnvironmentConfig,
  resetEnvironmentConfig: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db/repositories/analysis.js', () => ({
  AnalysisRepository: class MockAnalysisRepository {
    getPositions = vi.fn().mockResolvedValue({
      items: [{
        nodeNum: 1,
        sourceId: 's',
        latitude: 0,
        longitude: 0,
        altitude: null,
        timestamp: 0,
      }],
      pageSize: 10,
      hasMore: false,
      nextCursor: null,
    });
  },
}));

import databaseService from './database.js';

describe('databaseService.analysis facade', () => {
  it('exposes analysis.getPositions through the facade', async () => {
    await databaseService.waitForReady();
    // Async repo init may complete slightly after waitForReady on SQLite path
    for (let i = 0; i < 50 && !databaseService.analysisRepo; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(databaseService.analysis).toBeDefined();
    const r = await databaseService.analysis.getPositions({
      sourceIds: ['s'],
      sinceMs: 0,
      pageSize: 10,
    });
    expect(r.items).toHaveLength(1);
  });
});
