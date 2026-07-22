/**
 * Per-source isolation tests for nodeInfoEnrichmentService (NodeInfo
 * Enrichment epic #3837, Phase 1 WP-A).
 *
 * Unlike `nodeInfoEnrichmentService.test.ts` (which mocks
 * `../../services/database.js` and `./nodeInfoCopyService.js` wholesale to
 * pin the analyze/apply branching logic), this file exercises the REAL
 * singleton `databaseService` against its `:memory:` SQLite backend — the
 * same rationale as `mqttGeoSweepService.perSource.test.ts`. It proves that
 * `applyEnrichment`'s writes land only on the named `targetSourceId` (never
 * the donor, never an unrelated third source) and that `analyzeEnrichment`'s
 * read path respects `allowedSourceIds`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import databaseService from '../../services/database.js';
import { analyzeEnrichment, applyEnrichment } from './nodeInfoEnrichmentService.js';

function seedNode(nodeNum: number, sourceId: string, overrides: Record<string, unknown> = {}) {
  const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
  return databaseService.upsertNodeAsync({
    nodeNum,
    nodeId,
    longName: null,
    shortName: null,
    hwModel: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as any, sourceId);
}

describe('nodeInfoEnrichmentService — per-source isolation', () => {
  // Fresh source triple per test so rows from a prior test can't leak into
  // this one's grouping (the analyze pass groups by nodeNum across ALL
  // sources it can see).
  let SRC_A: string;
  let SRC_B: string;
  let SRC_OTHER: string;
  let testCounter = 0;

  beforeEach(async () => {
    await databaseService.waitForReady();
    const suffix = ++testCounter;
    SRC_A = `enrich-ps-a-${suffix}`;
    SRC_B = `enrich-ps-b-${suffix}`;
    SRC_OTHER = `enrich-ps-other-${suffix}`;
    await databaseService.sources.createSource({ id: SRC_A, name: 'Source A', type: 'meshtastic_tcp', config: {}, enabled: true });
    await databaseService.sources.createSource({ id: SRC_B, name: 'Source B', type: 'meshtastic_tcp', config: {}, enabled: true });
    await databaseService.sources.createSource({ id: SRC_OTHER, name: 'Source Other', type: 'meshtastic_tcp', config: {}, enabled: true });
  });

  afterEach(async () => {
    await databaseService.sources.deleteSource(SRC_A).catch(() => {});
    await databaseService.sources.deleteSource(SRC_B).catch(() => {});
    await databaseService.sources.deleteSource(SRC_OTHER).catch(() => {});
  });

  it('applyEnrichment writes only to targetSourceId; donor row and an unrelated third-source row are untouched', async () => {
    const NODE = 0x30000001;
    const NODE2 = 0x30000002;

    // Node present in both A (full donor) and B (blank target).
    await seedNode(NODE, SRC_A, { longName: 'Full Name', shortName: 'FN', hwModel: 42 });
    await seedNode(NODE, SRC_B, { longName: null, shortName: null, hwModel: null });

    // Unrelated node living only in a third source — must never be touched.
    await seedNode(NODE2, SRC_OTHER, { longName: 'Untouched', shortName: 'UT' });

    const result = await applyEnrichment(
      [{ nodeNum: NODE, targetSourceId: SRC_B, donorSourceId: SRC_A }],
      { pushToNodeDb: false },
    );

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].error).toBeUndefined();
    expect(result.applied[0].copiedFields.sort()).toEqual(['hwModel', 'longName', 'shortName'].sort());

    // Target (B) now has the donor's values.
    const targetRow = await databaseService.nodes.getNode(NODE, SRC_B);
    expect(targetRow?.longName).toBe('Full Name');
    expect(targetRow?.shortName).toBe('FN');
    expect(targetRow?.hwModel).toBe(42);

    // Donor (A) is completely unchanged.
    const donorRow = await databaseService.nodes.getNode(NODE, SRC_A);
    expect(donorRow?.longName).toBe('Full Name');
    expect(donorRow?.shortName).toBe('FN');
    expect(donorRow?.hwModel).toBe(42);

    // Unrelated third-source row for a different nodeNum is untouched.
    const otherRow = await databaseService.nodes.getNode(NODE2, SRC_OTHER);
    expect(otherRow?.longName).toBe('Untouched');
    expect(otherRow?.shortName).toBe('UT');
  });

  it('applyEnrichment never overwrites a non-blank field on the target (fill-blanks-only)', async () => {
    const NODE = 0x30000003;

    await seedNode(NODE, SRC_A, { longName: 'Donor Name', shortName: 'DN', hwModel: 7 });
    await seedNode(NODE, SRC_B, { longName: 'Existing Target Name', shortName: null, hwModel: null });

    const result = await applyEnrichment(
      [{ nodeNum: NODE, targetSourceId: SRC_B, donorSourceId: SRC_A }],
      { pushToNodeDb: false },
    );

    expect(result.applied[0].copiedFields).not.toContain('longName');
    expect(result.applied[0].copiedFields.sort()).toEqual(['hwModel', 'shortName'].sort());

    const targetRow = await databaseService.nodes.getNode(NODE, SRC_B);
    expect(targetRow?.longName).toBe('Existing Target Name'); // untouched
    expect(targetRow?.shortName).toBe('DN');
    expect(targetRow?.hwModel).toBe(7);
  });

  it('analyzeEnrichment(allowedSourceIds) excludes a disallowed source entirely from the read path', async () => {
    const NODE = 0x30000004;

    await seedNode(NODE, SRC_A, { longName: 'Full Name', shortName: 'FN', hwModel: 42 });
    await seedNode(NODE, SRC_B, { longName: null, shortName: null, hwModel: null });

    // Unrestricted: both sources visible, B is a valid enrichment target.
    const full = await analyzeEnrichment([SRC_A, SRC_B]);
    const fullNode = full.nodes.find(n => n.nodeNum === NODE);
    expect(fullNode).toBeDefined();
    expect(fullNode?.targets.some(t => t.targetSourceId === SRC_B)).toBe(true);

    // Restricted to SRC_A only: SRC_B is dropped as both donor and target,
    // so node NODE (which now only has one visible source row) drops out
    // entirely.
    const restricted = await analyzeEnrichment([SRC_A]);
    expect(restricted.nodes.find(n => n.nodeNum === NODE)).toBeUndefined();
  });
});
