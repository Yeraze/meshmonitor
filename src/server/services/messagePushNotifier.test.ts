/**
 * Shared message push/Apprise notifier (#4593) — extracted from
 * meshtasticManager so MQTT-sourced messages raise alerts too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const broadcast = vi.fn(async () => ({
  webPush: { sent: 1, failed: 0, filtered: 0 },
  apprise: { sent: 0, failed: 0, filtered: 0 },
  total: { sent: 1, failed: 0, filtered: 0 },
}));
const getServiceStatus = vi.fn(() => ({ webPush: true, apprise: false, anyAvailable: true }));

vi.mock('./notificationService.js', () => ({
  notificationService: {
    broadcast: (...a: any[]) => broadcast(...(a as [])),
    getServiceStatus: () => getServiceStatus(),
  },
}));

vi.mock('../../services/database.js', () => ({
  default: {
    nodes: { getNode: vi.fn(async () => ({ nodeNum: 0x0a0b0c0d, nodeId: '!0a0b0c0d', longName: 'Far Node', shortName: 'FAR' })) },
    channels: { getChannelById: vi.fn(async () => null) },
    channelDatabase: { getByIdAsync: vi.fn(async () => ({ id: 3, name: 'LongFast' })) },
    sources: { getSource: vi.fn(async () => ({ id: 'bridge-1', name: 'Public Bridge' })) },
  },
}));

const isOwnNodeNum = vi.fn((_nodeNum?: unknown) => false);
vi.mock('../utils/ownNodes.js', () => ({
  isOwnNodeNum: (n: any) => isOwnNodeNum(n),
  getOwnNodeNums: () => [],
}));

import { sendMessagePushNotification } from './messagePushNotifier.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';

function msg(over: Record<string, any> = {}) {
  return {
    id: 'bridge-1_168627213_42',
    fromNodeNum: 0x0a0b0c0d,
    fromNodeId: '!0a0b0c0d',
    toNodeNum: 0xffffffff,
    channel: 0,
    portnum: 1, // TEXT_MESSAGE_APP
    viaMqtt: true,
    ...over,
  };
}

describe('sendMessagePushNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServiceStatus.mockReturnValue({ webPush: true, apprise: false, anyAvailable: true });
    isOwnNodeNum.mockReturnValue(false);
  });

  it('broadcasts a channel message alert with the resolved source name', async () => {
    await sendMessagePushNotification({
      message: msg(),
      messageText: 'hello mesh',
      isDirectMessage: false,
      sourceId: 'bridge-1',
    });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const [payload, filterCtx] = (broadcast as any).mock.calls[0];
    expect(payload.title).toContain('Far Node');
    expect(payload.body).toBe('hello mesh');
    expect(payload.sourceId).toBe('bridge-1');
    expect(payload.sourceName).toBe('Public Bridge');
    expect(payload.data).toMatchObject({ type: 'channel', sourceId: 'bridge-1', channelId: 0 });
    expect(filterCtx).toMatchObject({ messageText: 'hello mesh', isDirectMessage: false, viaMqtt: true });
  });

  it('names a virtual (channel_database) channel instead of showing its offset id', async () => {
    await sendMessagePushNotification({
      message: msg({ channel: CHANNEL_DB_OFFSET + 3 }),
      messageText: 'hi',
      isDirectMessage: false,
      sourceId: 'bridge-1',
    });

    expect((broadcast as any).mock.calls[0][0].title).toBe('Far Node in LongFast');
  });

  it('titles a DM and carries the sender node id for deep linking', async () => {
    await sendMessagePushNotification({
      message: msg({ toNodeNum: 0x11223344, channel: -1 }),
      messageText: 'psst',
      isDirectMessage: true,
      sourceId: 'bridge-1',
    });

    const payload = (broadcast as any).mock.calls[0][0];
    expect(payload.title).toBe('Direct Message from Far Node');
    expect(payload.data).toMatchObject({ type: 'dm', senderNodeId: '!0a0b0c0d' });
  });

  it('skips when no notification service is configured', async () => {
    getServiceStatus.mockReturnValue({ webPush: false, apprise: false, anyAvailable: false });
    await sendMessagePushNotification({ message: msg(), messageText: 'x', isDirectMessage: false, sourceId: 'bridge-1' });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('skips non-chat portnums', async () => {
    await sendMessagePushNotification({ message: msg({ portnum: 67 }), messageText: 'x', isDirectMessage: false, sourceId: 'bridge-1' });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('skips a message from the source’s own local node', async () => {
    await sendMessagePushNotification({
      message: msg({ fromNodeNum: 0x11223344 }),
      messageText: 'x',
      isDirectMessage: false,
      sourceId: 'tcp-1',
      localNodeNum: 0x11223344,
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('skips a message from one of our own nodes seen through an identity-less source (#4593)', async () => {
    isOwnNodeNum.mockReturnValue(true);
    await sendMessagePushNotification({
      message: msg({ fromNodeNum: 0x11223344 }),
      messageText: 'x',
      isDirectMessage: false,
      sourceId: 'bridge-1',
      localNodeNum: null,
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('never throws when the notification service fails', async () => {
    broadcast.mockRejectedValueOnce(new Error('apprise down') as never);
    await expect(
      sendMessagePushNotification({ message: msg(), messageText: 'x', isDirectMessage: false, sourceId: 'bridge-1' }),
    ).resolves.toBeUndefined();
  });
});
