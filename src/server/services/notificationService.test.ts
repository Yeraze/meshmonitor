import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./pushNotificationService.js', () => ({
  pushNotificationService: {
    isAvailable: vi.fn(),
    broadcastWithFiltering: vi.fn(),
    broadcastToPreferenceUsers: vi.fn(),
  },
}));

vi.mock('./appriseNotificationService.js', () => ({
  appriseNotificationService: {
    isAvailable: vi.fn(),
    broadcastWithFiltering: vi.fn(),
    broadcastToPreferenceUsers: vi.fn(),
  },
  AppriseNotificationPayload: {},
}));

vi.mock('./desktopNotificationService.js', () => ({
  desktopNotificationService: {
    isAvailable: vi.fn(),
    broadcastWithFiltering: vi.fn(),
    broadcastToPreferenceUsers: vi.fn(),
  },
}));

vi.mock('../../../utils/nodeHelpers.js', () => ({
  getHardwareModelName: vi.fn((hwModel: number) => `HW${hwModel}`),
}));

import { notificationService } from './notificationService.js';
import { pushNotificationService } from './pushNotificationService.js';
import { appriseNotificationService } from './appriseNotificationService.js';
import { desktopNotificationService } from './desktopNotificationService.js';

const mockPush = pushNotificationService as any;
const mockApprise = appriseNotificationService as any;
const mockDesktop = desktopNotificationService as any;

const defaultFilterContext = {
  messageText: 'Hello',
  channelId: 1,
  isDirectMessage: false,
  viaMqtt: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPush.isAvailable.mockReturnValue(true);
  mockApprise.isAvailable.mockReturnValue(true);
  mockDesktop.isAvailable.mockReturnValue(false);
  mockPush.broadcastWithFiltering.mockResolvedValue({ sent: 1, failed: 0, filtered: 0 });
  mockApprise.broadcastWithFiltering.mockResolvedValue({ sent: 1, failed: 0, filtered: 0 });
  mockDesktop.broadcastWithFiltering.mockResolvedValue({ sent: 0, failed: 0, filtered: 0 });
  mockPush.broadcastToPreferenceUsers.mockResolvedValue(undefined);
  mockApprise.broadcastToPreferenceUsers.mockResolvedValue(undefined);
  mockDesktop.broadcastToPreferenceUsers.mockResolvedValue(undefined);
});

// ─── broadcast ────────────────────────────────────────────────────────────────

describe('notificationService.broadcast', () => {
  it('calls both push and apprise when available', async () => {
    const result = await notificationService.broadcast(
      { title: 'Test', body: 'Hello' },
      defaultFilterContext
    );
    expect(mockPush.broadcastWithFiltering).toHaveBeenCalledOnce();
    expect(mockApprise.broadcastWithFiltering).toHaveBeenCalledOnce();
    expect(result.webPush.sent).toBe(1);
    expect(result.apprise.sent).toBe(1);
  });

  it('sums totals from all services', async () => {
    mockPush.broadcastWithFiltering.mockResolvedValue({ sent: 3, failed: 1, filtered: 0 });
    mockApprise.broadcastWithFiltering.mockResolvedValue({ sent: 2, failed: 0, filtered: 1 });

    const result = await notificationService.broadcast(
      { title: 'Test', body: 'Hello' },
      defaultFilterContext
    );
    expect(result.total.sent).toBe(5);
    expect(result.total.failed).toBe(1);
    expect(result.total.filtered).toBe(1);
  });

  it('skips push when not available', async () => {
    mockPush.isAvailable.mockReturnValue(false);

    const result = await notificationService.broadcast(
      { title: 'Test', body: 'Hello' },
      defaultFilterContext
    );
    expect(mockPush.broadcastWithFiltering).not.toHaveBeenCalled();
    expect(result.webPush.sent).toBe(0);
    expect(result.apprise.sent).toBe(1);
  });

  it('skips apprise when not available', async () => {
    mockApprise.isAvailable.mockReturnValue(false);

    const result = await notificationService.broadcast(
      { title: 'Test', body: 'Hello' },
      defaultFilterContext
    );
    expect(mockApprise.broadcastWithFiltering).not.toHaveBeenCalled();
    expect(result.apprise.sent).toBe(0);
  });

  it('handles push broadcast failure gracefully', async () => {
    mockPush.broadcastWithFiltering.mockRejectedValue(new Error('Push error'));

    const result = await notificationService.broadcast(
      { title: 'Test', body: 'Hello' },
      defaultFilterContext
    );
    expect(result.webPush.sent).toBe(0);
    expect(result.webPush.failed).toBe(0);
    expect(result.apprise.sent).toBe(1); // apprise still works
  });

  it('handles apprise broadcast failure gracefully', async () => {
    mockApprise.broadcastWithFiltering.mockRejectedValue(new Error('Apprise error'));

    const result = await notificationService.broadcast(
      { title: 'Test', body: 'Hello' },
      defaultFilterContext
    );
    expect(result.apprise.sent).toBe(0);
    expect(result.webPush.sent).toBe(1); // push still works
  });

  it('passes payload and filter context to push service', async () => {
    const payload = { title: 'Alert', body: 'Node offline', type: 'warning' as const };
    await notificationService.broadcast(payload, defaultFilterContext);
    expect(mockPush.broadcastWithFiltering).toHaveBeenCalledWith(payload, defaultFilterContext);
  });
});

// ─── getServiceStatus ─────────────────────────────────────────────────────────

describe('notificationService.getServiceStatus', () => {
  it('returns true for webPush and apprise when both available', () => {
    const status = notificationService.getServiceStatus();
    expect(status.webPush).toBe(true);
    expect(status.apprise).toBe(true);
    expect(status.anyAvailable).toBe(true);
  });

  it('returns false for webPush when not available', () => {
    mockPush.isAvailable.mockReturnValue(false);
    const status = notificationService.getServiceStatus();
    expect(status.webPush).toBe(false);
    expect(status.anyAvailable).toBe(true); // apprise still available
  });

  it('returns anyAvailable=false when both unavailable', () => {
    mockPush.isAvailable.mockReturnValue(false);
    mockApprise.isAvailable.mockReturnValue(false);
    const status = notificationService.getServiceStatus();
    expect(status.anyAvailable).toBe(false);
  });
});

// ─── notifyNewNode ────────────────────────────────────────────────────────────

describe('notificationService.notifyNewNode', () => {
  it('calls broadcastToPreferenceUsers on push and apprise', async () => {
    await notificationService.notifyNewNode('!abc123', 'Test Node', 'TN', 100, 1, 'src1', 'Source One');
    expect(mockPush.broadcastToPreferenceUsers).toHaveBeenCalledWith(
      'notifyOnNewNode',
      expect.objectContaining({ title: expect.stringContaining('🆕 New Node Discovered') }),
      undefined,
      'src1'
    );
    expect(mockApprise.broadcastToPreferenceUsers).toHaveBeenCalledWith(
      'notifyOnNewNode',
      expect.objectContaining({ title: expect.stringContaining('🆕 New Node Discovered') }),
      undefined,
      'src1'
    );
  });

  it('includes hops away in body when provided', async () => {
    await notificationService.notifyNewNode('!abc123', 'Test Node', 'TN', 100, 2, 'src1', 'Source One');
    expect(mockPush.broadcastToPreferenceUsers).toHaveBeenCalledWith(
      'notifyOnNewNode',
      expect.objectContaining({ body: expect.stringContaining('2 hops') }),
      undefined,
      'src1'
    );
  });

  it('uses singular hop when hopsAway is 1', async () => {
    await notificationService.notifyNewNode('!abc123', 'Test Node', 'TN', 100, 1, 'src1', 'Source One');
    expect(mockPush.broadcastToPreferenceUsers).toHaveBeenCalledWith(
      'notifyOnNewNode',
      expect.objectContaining({ body: expect.stringContaining('1 hop away') }),
      undefined,
      'src1'
    );
  });

  it('omits hops text when hopsAway is undefined', async () => {
    await notificationService.notifyNewNode('!abc123', 'Test Node', 'TN', 100, undefined, 'src1', 'Source One');
    const call = mockPush.broadcastToPreferenceUsers.mock.calls[0];
    expect(call[1].body).not.toContain('hop');
  });

  it('does not throw on broadcast error', async () => {
    mockPush.broadcastToPreferenceUsers.mockRejectedValue(new Error('Push error'));
    await expect(
      notificationService.notifyNewNode('!abc123', 'Test Node', 'TN', undefined, undefined, 'src1', 'Source One')
    ).resolves.toBeUndefined();
  });
});

// ─── notifyTraceroute ─────────────────────────────────────────────────────────

describe('notificationService.notifyTraceroute', () => {
  it('calls broadcastToPreferenceUsers with traceroute preference', async () => {
    await notificationService.notifyTraceroute('!aaa', '!bbb', 'Direct', 'src1', 'Source One');
    expect(mockPush.broadcastToPreferenceUsers).toHaveBeenCalledWith(
      'notifyOnTraceroute',
      expect.objectContaining({ title: expect.stringContaining('Traceroute') }),
      undefined,
      'src1'
    );
  });

  it('includes node IDs in the notification title', async () => {
    await notificationService.notifyTraceroute('!aaa', '!bbb', 'Direct', 'src1', 'Source One');
    expect(mockPush.broadcastToPreferenceUsers).toHaveBeenCalledWith(
      'notifyOnTraceroute',
      expect.objectContaining({ title: expect.stringContaining('🗺️ Traceroute: !aaa → !bbb') }),
      undefined,
      'src1'
    );
  });

  it('uses route text as body', async () => {
    await notificationService.notifyTraceroute('!aaa', '!bbb', 'Via relay node', 'src1', 'Source One');
    expect(mockPush.broadcastToPreferenceUsers).toHaveBeenCalledWith(
      'notifyOnTraceroute',
      expect.objectContaining({ body: expect.stringContaining('Via relay node') }),
      undefined,
      'src1'
    );
  });

  it('does not throw on broadcast error', async () => {
    mockApprise.broadcastToPreferenceUsers.mockRejectedValue(new Error('Apprise error'));
    await expect(
      notificationService.notifyTraceroute('!aaa', '!bbb', 'Direct', 'src1', 'Source One')
    ).resolves.toBeUndefined();
  });
});

// ─── broadcastToPreferenceUsers ───────────────────────────────────────────────

describe('notificationService.broadcastToPreferenceUsers', () => {
  it('calls all sub-services with the preference key', async () => {
    await notificationService.broadcastToPreferenceUsers(
      'notifyOnInactiveNode',
      { title: 'Inactive', body: 'Node offline', sourceId: 'src1', sourceName: 'Source One' }
    );
    expect(mockPush.broadcastToPreferenceUsers).toHaveBeenCalledWith(
      'notifyOnInactiveNode',
      expect.objectContaining({ title: 'Inactive' }),
      undefined,
      'src1'
    );
    expect(mockApprise.broadcastToPreferenceUsers).toHaveBeenCalledWith(
      'notifyOnInactiveNode',
      expect.objectContaining({ title: 'Inactive' }),
      undefined,
      'src1'
    );
  });

  it('passes targetUserId when specified', async () => {
    await notificationService.broadcastToPreferenceUsers(
      'notifyOnServerEvents',
      { title: 'Server', body: 'Event', sourceId: 'src1', sourceName: 'Source One' },
      42
    );
    expect(mockPush.broadcastToPreferenceUsers).toHaveBeenCalledWith(
      'notifyOnServerEvents',
      expect.any(Object),
      42,
      'src1'
    );
  });
});
