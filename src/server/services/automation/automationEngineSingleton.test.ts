/**
 * MeshCore message routing into the automation engine (#5759): a reaction row
 * carries a bare emoji as its text, so it never fires a trigger.message.
 */
import { describe, it, expect, vi } from 'vitest';
import { routeEventToEngine, shouldRouteMeshCoreMessageToAutomations } from './automationEngineSingleton.js';
import type { AutomationEngineService } from './automationEngineService.js';
import type { DataEvent } from '../dataEventEmitter.js';

const base = { id: 'm1', fromPublicKey: 'channel-0', fromName: 'Bob', text: 'hello', timestamp: 1, messageType: 'channel' };

function engineStub() {
  const onMeshCoreMessage = vi.fn().mockResolvedValue(undefined);
  return { engine: { onMeshCoreMessage } as unknown as AutomationEngineService, onMeshCoreMessage };
}
const ev = (data: Record<string, unknown>): DataEvent =>
  ({ type: 'meshcore:message', data, sourceId: 'src-1', timestamp: 1 }) as unknown as DataEvent;

describe('shouldRouteMeshCoreMessageToAutomations', () => {
  it('lets an ordinary message in', () => {
    expect(shouldRouteMeshCoreMessageToAutomations({})).toBe(true);
  });
  it('keeps out an ignored message and a reaction row', () => {
    expect(shouldRouteMeshCoreMessageToAutomations({ filtered: 'ignore' })).toBe(false);
    expect(shouldRouteMeshCoreMessageToAutomations({ reactionEmoji: '\u{1F44D}' })).toBe(false);
  });
});

describe('routeEventToEngine meshcore:message', () => {
  it('calls onMeshCoreMessage for an ordinary message', async () => {
    const { engine, onMeshCoreMessage } = engineStub();
    await routeEventToEngine(engine, ev(base));
    expect(onMeshCoreMessage).toHaveBeenCalledTimes(1);
  });

  it('does not call it for a reaction row', async () => {
    const { engine, onMeshCoreMessage } = engineStub();
    await routeEventToEngine(engine, ev({ ...base, text: '\u{1F44D}', reactionEmoji: '\u{1F44D}' }));
    expect(onMeshCoreMessage).not.toHaveBeenCalled();
  });

  it('still routes raw reaction-shaped text when it stayed text (inbound off)', async () => {
    const { engine, onMeshCoreMessage } = engineStub();
    await routeEventToEngine(engine, ev({ ...base, text: '@[Alice]\u{1F44D}\nb45pc4ek' }));
    expect(onMeshCoreMessage).toHaveBeenCalledTimes(1);
  });
});
