import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { simulateAutomation } from './automationSimulator.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { buildMeshBeaconContext } from './triggerContext.js';
import type { AutomationGraph } from '../../../types/automation.js';

/**
 * `trigger.meshBeacon` (#3854) — the context shape and the match filter.
 *
 * The engine's live filter (AutomationEngineService.onMeshBeacon) and the
 * simulator's preview filter are separate implementations of the same rule, so
 * these cases run through the simulator to keep the two honest: a divergence
 * means the Test panel lies about what will fire.
 */
describe('buildMeshBeaconContext', () => {
  it('carries the beacon text and subject node', () => {
    const ctx = buildMeshBeaconContext(42, 'Welcome to the mesh', {}, 'default', 5);
    expect(ctx.triggerType).toBe('trigger.meshBeacon');
    expect(ctx.subjectNodeNum).toBe(42);
    expect(ctx.fields).toMatchObject({ nodeNum: 42, message: 'Welcome to the mesh' });
  });

  it('reports hasOffer=false for a text-only beacon', () => {
    expect(buildMeshBeaconContext(42, 'hello', {}, 'default', 5).fields.hasOffer).toBe(false);
  });

  it('reports hasOffer=true for each kind of offer', () => {
    expect(buildMeshBeaconContext(1, '', { channelName: 'LongFast' }, null, 0).fields.hasOffer).toBe(true);
    expect(buildMeshBeaconContext(1, '', { region: 1 }, null, 0).fields.hasOffer).toBe(true);
    // preset 0 (LONG_FAST) is a real offer — it must not read as absent.
    expect(buildMeshBeaconContext(1, '', { preset: 0 }, null, 0).fields.hasOffer).toBe(true);
  });
});

describe('trigger.meshBeacon match filter', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let varsRepo: AutomationVariablesRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    varsRepo = new AutomationVariablesRepository(t.db, 'sqlite');
  });
  afterEach(() => db.close());

  const graphWith = (params: Record<string, unknown>): AutomationGraph => ({
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.meshBeacon', params },
      { id: 'a', type: 'action.nothing', params: {} },
    ],
    edges: [{ from: 't', to: 'a' }],
  });

  const run = (params: Record<string, unknown>, event: Record<string, unknown>) =>
    simulateAutomation({
      graph: graphWith(params),
      varsRepo,
      event: { kind: 'meshBeacon', nodeNum: 42, ...event } as any,
    });

  it('fires on any beacon when no filter is set', async () => {
    expect((await run({}, { message: 'anything' })).matched).toBe(true);
  });

  it('matches the text filter case-insensitively', async () => {
    expect((await run({ messageContains: 'WELCOME' }, { message: 'Welcome aboard' })).matched).toBe(true);
    expect((await run({ messageContains: 'welcome' }, { message: 'Goodbye' })).matched).toBe(false);
  });

  it('treats an empty text filter as "any"', async () => {
    expect((await run({ messageContains: '' }, { message: 'whatever' })).matched).toBe(true);
  });

  it('requireOffer rejects a text-only beacon', async () => {
    expect((await run({ requireOffer: true }, { message: 'just text' })).matched).toBe(false);
  });

  it('requireOffer accepts a beacon advertising a channel', async () => {
    expect((await run(
      { requireOffer: true },
      { message: 'join us', offerChannelName: 'LongFast' },
    )).matched).toBe(true);
  });

  it('applies both filters together', async () => {
    // Offer present but text does not match → no fire.
    expect((await run(
      { requireOffer: true, messageContains: 'join' },
      { message: 'hello there', offerChannelName: 'LongFast' },
    )).matched).toBe(false);

    expect((await run(
      { requireOffer: true, messageContains: 'join' },
      { message: 'come join us', offerChannelName: 'LongFast' },
    )).matched).toBe(true);
  });
});
