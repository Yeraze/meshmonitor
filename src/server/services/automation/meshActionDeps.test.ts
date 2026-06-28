import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the registry so we can inject fake Meshtastic / MeshCore managers.
const getManager = vi.fn();
vi.mock('../../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: (id: string) => getManager(id) },
}));
// The deps module also imports these at load time; stub to harmless objects.
vi.mock('../../../services/database.js', () => ({ default: {} }));
vi.mock('../appriseNotificationService.js', () => ({ appriseNotificationService: {} }));
vi.mock('../../utils/scriptRunner.js', () => ({ runScript: vi.fn() }));

import { createMeshActionDeps } from './meshActionDeps.js';

describe('createMeshActionDeps sendMessage — MeshCore scope (#3833)', () => {
  beforeEach(() => getManager.mockReset());

  it('forwards scopeOverride to a MeshCore manager (sendMessage signature)', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true);
    getManager.mockReturnValue({ sendMessage }); // MeshCore-shaped manager
    const deps = createMeshActionDeps();

    await deps.sendMessage({ sourceId: 'mc', text: 'hi', channel: 2, scopeOverride: 'paris' });

    // raw.sendMessage(text, toPublicKey=undefined, channelIdx, scopeOverride)
    expect(sendMessage).toHaveBeenCalledWith('hi', undefined, 2, 'paris');
  });

  it('passes an empty-string (unscoped) override through unchanged', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true);
    getManager.mockReturnValue({ sendMessage });
    const deps = createMeshActionDeps();

    await deps.sendMessage({ sourceId: 'mc', text: 'hi', channel: 0, scopeOverride: '' });

    expect(sendMessage).toHaveBeenCalledWith('hi', undefined, 0, '');
  });

  it('drops scopeOverride for a Meshtastic manager (no scope concept)', async () => {
    const sendTextMessage = vi.fn().mockResolvedValue(1);
    getManager.mockReturnValue({ sendTextMessage }); // Meshtastic-shaped manager
    const deps = createMeshActionDeps();

    await deps.sendMessage({ sourceId: 'mt', text: 'hi', channel: 3, scopeOverride: 'paris' });

    // sendTextMessage(text, channel, destination, replyId, emoji) — no scope arg.
    expect(sendTextMessage).toHaveBeenCalledWith('hi', 3, undefined, undefined, 0);
  });
});
