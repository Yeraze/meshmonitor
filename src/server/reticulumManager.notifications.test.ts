/**
 * ReticulumManager notification wiring (#6341 P3): inbound DMs and
 * new-destination alerts. Link alerts get their own cases in this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnnounceMessage, LxmfMessageEvent } from './reticulumProtocol.js';

const upsertDestination = vi.hoisted(() => vi.fn());
const upsertMessage = vi.hoisted(() => vi.fn());
const getMessage = vi.hoisted(() => vi.fn());
const getDestination = vi.hoisted(() => vi.fn());
const dispatch = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const alert = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const emitReticulumMessage = vi.hoisted(() => vi.fn());
const isOwn = vi.hoisted(() => vi.fn().mockReturnValue(false));

vi.mock('../services/database.js', () => ({
  default: {
    reticulum: { upsertDestination, upsertMessage, getMessage, getDestination },
    settings: {
      getSettingForSource: vi.fn().mockResolvedValue(null),
      setSourceSetting: vi.fn().mockResolvedValue(undefined),
    },
  },
}));
vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: { emitReticulumMessage },
}));
vi.mock('./utils/ownNodes.js', () => ({ isOwnReticulumAddress: isOwn }));
vi.mock('./services/messagePushNotifier.js', () => ({ dispatchMessageNotification: dispatch }));
vi.mock('./services/reticulumNewDestinationAlert.js', () => ({
  maybeAlertReticulumNewDestination: alert,
}));

import { ReticulumManager } from './reticulumManager.js';

const FROM = 'ABCDEF0123456789ABCDEF0123456789';

function lxmf(over: Partial<LxmfMessageEvent> = {}): LxmfMessageEvent {
  return {
    v: 1, type: 'lxmf_message', ts: 1_700_000_000_000, hash: 'h1',
    from: FROM, to: 'self', title: null, content: 'hi', fields: {}, method: 'direct',
    signatureValidated: true, ratcheted: false, rssi: null, snr: null, q: null,
    ...over,
  } as unknown as LxmfMessageEvent;
}

function announce(over: Partial<AnnounceMessage> = {}): AnnounceMessage {
  return {
    v: 1, type: 'announce', ts: 1, destinationHash: 'dd', identityHash: null,
    appName: 'lxmf', aspects: ['delivery'], displayName: 'Dee', appDataB64: null,
    hops: 1, nextHopInterface: null, rssi: null, snr: null, q: null, isPathResponse: null,
    ...over,
  } as AnnounceMessage;
}

describe('ReticulumManager notifications (#6341 P3)', () => {
  beforeEach(() => {
    for (const m of [upsertDestination, upsertMessage, getMessage, getDestination, dispatch, alert, emitReticulumMessage, isOwn]) m.mockReset();
    dispatch.mockResolvedValue(undefined);
    alert.mockResolvedValue(undefined);
    isOwn.mockReturnValue(false);
    upsertMessage.mockResolvedValue({ inserted: true });
    upsertDestination.mockResolvedValue({ inserted: true });
    getMessage.mockResolvedValue({ id: 'src-a_h1', fromHash: FROM, content: 'hi' });
    getDestination.mockResolvedValue({ displayName: 'Carol\u0000x' });
  });

  it('an inbound DM carries muteKey, nav sender, sanitised name and sourceId', async () => {
    const m = new ReticulumManager('src-a');
    // @ts-expect-error - private handler
    await m.handleLxmfMessage(lxmf());
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'src-a',
      messageId: 'src-a_h1',
      isDirectMessage: true,
      channelId: -1,
      senderName: 'Carol',
      senderShortName: 'ABCDEF01…',
      senderNavId: FROM,
      muteKey: FROM.toLowerCase(),
      text: 'hi',
      dedupKey: null,
    }));
    expect(emitReticulumMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back to the short hash when the sender has no name', async () => {
    getDestination.mockResolvedValue(null);
    const m = new ReticulumManager('src-a');
    // @ts-expect-error - private handler
    await m.handleLxmfMessage(lxmf());
    expect(dispatch.mock.calls[0][0].senderName).toBe('ABCDEF01…');
  });

  it('a re-delivery neither notifies nor emits', async () => {
    upsertMessage.mockResolvedValue({ inserted: false });
    const m = new ReticulumManager('src-a');
    // @ts-expect-error - private handler
    await m.handleLxmfMessage(lxmf());
    expect(dispatch).not.toHaveBeenCalled();
    expect(emitReticulumMessage).not.toHaveBeenCalled();
  });

  it('a self-origin message is stored but not notified or emitted', async () => {
    isOwn.mockReturnValue(true);
    const m = new ReticulumManager('src-a');
    // @ts-expect-error - private handler
    await m.handleLxmfMessage(lxmf());
    expect(upsertMessage).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(emitReticulumMessage).not.toHaveBeenCalled();
  });

  it('an announce passes its inserted flag and source to the alert', async () => {
    const m = new ReticulumManager('src-a');
    // @ts-expect-error - private handler
    await m.handleAnnounce(announce());
    expect(alert).toHaveBeenCalledWith(
      expect.anything(), 'src-a',
      { destinationHash: 'dd', appName: 'lxmf', aspects: 'delivery', displayName: 'Dee', hops: 1 },
      true,
    );
    upsertDestination.mockResolvedValue({ inserted: false });
    // @ts-expect-error - private handler
    await m.handleAnnounce(announce());
    expect(alert.mock.calls[1][3]).toBe(false);
  });

  it('each manager owns its own alert tracker', async () => {
    const a = new ReticulumManager('src-a');
    const b = new ReticulumManager('src-b');
    // @ts-expect-error - private handler
    await a.handleAnnounce(announce());
    // @ts-expect-error - private handler
    await b.handleAnnounce(announce());
    expect(alert.mock.calls[0][0]).not.toBe(alert.mock.calls[1][0]);
    expect(alert.mock.calls[1][1]).toBe('src-b');
  });
});
