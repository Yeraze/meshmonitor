/**
 * GET /api/messages/export — row cap (#5517). The cap is lowered to 2 here so
 * the test does not need 100,000 rows; the route must stop at the cap and end
 * the file with the truncation marker, and must NOT add the marker when the
 * data fits exactly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../utils/messageCsv.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCsv.js')>();
  return { ...actual, MESSAGE_EXPORT_MAX_ROWS: 2 };
});

import messageExportRoutes from './messageExportRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('GET /api/messages/export — row cap', () => {
  let harness: RouteTestHarness;

  const seed = async (n: number) => {
    for (let i = 1; i <= n; i++) {
      await harness.db.messages.insertMessage(
        {
          id: `${harness.sourceA}_${0x0d000002}_${i}`,
          fromNodeNum: 0x0d000002,
          toNodeNum: 0xffffffff,
          fromNodeId: '!0d000002',
          toNodeId: '!ffffffff',
          text: `row ${i}`,
          channel: 0,
          portnum: 1,
          timestamp: 1_760_000_000_000 + i,
          createdAt: 1_760_000_000_000 + i,
        } as never,
        harness.sourceA,
      );
    }
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', messageExportRoutes) });
  });

  afterEach(async () => {
    await harness.db.messages.deleteAllMessages(harness.sourceA);
    await harness.cleanup();
  });

  it('stops at the cap and ends with the truncation marker', async () => {
    await seed(3);
    const agent = await harness.loginAs(harness.admin);
    const lines = (await agent.get('/export')).text.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(4); // header + 2 rows + marker
    expect(lines[1]).toContain('row 1');
    expect(lines[2]).toContain('row 2');
    expect(lines[3]).toMatch(/^TRUNCATED: export stopped at 2 rows/);
  });

  it('adds no marker when the rows fit exactly', async () => {
    await seed(2);
    const agent = await harness.loginAs(harness.admin);
    const text = (await agent.get('/export')).text;
    expect(text).not.toContain('TRUNCATED');
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(3);
  });
});
