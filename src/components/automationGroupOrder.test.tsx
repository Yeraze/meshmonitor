/**
 * @vitest-environment jsdom
 *
 * Auto Acknowledge and Auto Announce use the same field groups, in the same
 * order, on Meshtastic and MeshCore (#5816). Each section renders its groups
 * as `ConfigGroup`s; `data-config-group` carries the untranslated group key.
 * These tests pin the order and that protocol-only fields sit in the right
 * group.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import AutoAcknowledgeSection from './AutoAcknowledgeSection';
import AutoAnnounceSection from './AutoAnnounceSection';
import { MeshCoreAutoAckSection } from './MeshCore/MeshCoreAutoAckSection';
import { MeshCoreAutoAnnounceSection } from './MeshCore/MeshCoreAutoAnnounceSection';
import { DEFAULT_AUTOACK_MATRIX } from '../utils/autoAckMatrix';
import type { Channel } from '../types/device';

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => csrfFetchMock }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useSaveBar', () => ({ useSaveBar: vi.fn() }));
vi.mock('../hooks/useSourceQuery', () => ({ useSourceQuery: () => '' }));
vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24h', dateFormat: 'YYYY-MM-DD' }),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));
vi.mock('../services/api', () => ({
  default: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}) },
}));

const channels: Channel[] = [
  { id: 0, name: 'Primary', psk: 'x', uplinkEnabled: true, downlinkEnabled: true, createdAt: 0, updatedAt: 0 },
];

const groupOrder = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('[data-config-group]')).map((el) => el.getAttribute('data-config-group'));

/** The group key of the group holding the element with this id. */
const groupOf = (id: string) =>
  document.getElementById(id)?.closest('[data-config-group]')?.getAttribute('data-config-group');

beforeEach(() => {
  csrfFetchMock.mockReset().mockImplementation((url: string) => {
    if (url.includes('/channels/all')) {
      return Promise.resolve({ ok: true, json: async () => [{ id: 0, name: 'Primary' }] });
    }
    if (url.includes('/meshcore/automation/')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { enabled: true, channelIndexes: [0], advertEnabled: true } }),
      });
    }
    return Promise.resolve({ ok: false, json: async () => ({}) });
  });
});

describe('Auto Acknowledge groups (#5816)', () => {
  it('Meshtastic: trigger, where, who, timing, delivery, message, test', () => {
    const noop = vi.fn();
    const { container } = render(
      <AutoAcknowledgeSection
        enabled
        regex="^(test|ping)"
        message="m"
        messageDirect="d"
        channels={channels}
        enabledChannels={[0]}
        skipIncompleteNodes={false}
        ignoredNodes=""
        matrix={DEFAULT_AUTOACK_MATRIX}
        baseUrl=""
        onEnabledChange={noop}
        onRegexChange={noop}
        onMessageChange={noop}
        onMessageDirectChange={noop}
        onChannelsChange={noop}
        onSkipIncompleteNodesChange={noop}
        onIgnoredNodesChange={noop}
        onMatrixChange={noop}
        cooldownSeconds={60}
        onCooldownSecondsChange={noop}
        preSendDelaySeconds={0}
        onPreSendDelaySecondsChange={noop}
        maxAttempts={3}
        onMaxAttemptsChange={noop}
        testMessages="test"
        onTestMessagesChange={noop}
      />,
    );
    expect(groupOrder(container)).toEqual(['trigger', 'where', 'who', 'timing', 'delivery', 'message', 'test']);
    expect(groupOf('autoAckRegex')).toBe('trigger');
    expect(groupOf('autoAckChannel0')).toBe('where');
    expect(groupOf('autoAckSkipIncomplete')).toBe('who');
    expect(groupOf('autoAckIgnoredNodes')).toBe('who');
    expect(groupOf('autoAckMaxResponses')).toBe('timing');
    expect(groupOf('autoAckMaxAttempts')).toBe('timing');
    expect(groupOf('autoAckHopLimit')).toBe('delivery');
    expect(groupOf('autoAckMessage')).toBe('message');
    expect(groupOf('autoAckMessageDirect')).toBe('message');
    expect(groupOf('testMessages')).toBe('test');
  });

  it('MeshCore: trigger, where, who, timing, delivery, message, test', async () => {
    const { container } = render(<MeshCoreAutoAckSection baseUrl="" sourceId="src1" />);
    await waitFor(() => expect(document.getElementById('meshcoreAutoAckChannel0')).not.toBeNull());
    expect(groupOrder(container)).toEqual(['trigger', 'where', 'who', 'timing', 'delivery', 'message', 'test']);
    expect(groupOf('meshcoreAutoAckRegex')).toBe('trigger');
    expect(groupOf('meshcoreAutoAckDM')).toBe('where');
    expect(groupOf('meshcoreAutoAckChannel0')).toBe('where');
    expect(groupOf('meshcoreAutoAckIgnoredNodes')).toBe('who');
    expect(groupOf('meshcoreAutoAckUseDM')).toBe('delivery');
    expect(groupOf('meshcoreAutoAckSplitLongMessages')).toBe('delivery');
    expect(groupOf('meshcoreAutoAckMessage')).toBe('message');
    expect(groupOf('meshcoreAutoAckTestMessages')).toBe('test');
  });
});

describe('Auto Announce groups (#5816)', () => {
  it('Meshtastic: when, where, message, extras', () => {
    const noop = vi.fn();
    const { container } = render(
      <AutoAnnounceSection
        enabled
        intervalHours={6}
        message="hello"
        channelIndexes={[0]}
        announceOnStart={false}
        useSchedule={false}
        schedule="0 */6 * * *"
        channels={channels}
        baseUrl=""
        onEnabledChange={noop}
        onIntervalChange={noop}
        onMessageChange={noop}
        onChannelIndexesChange={noop}
        onAnnounceOnStartChange={noop}
        onUseScheduleChange={noop}
        onScheduleChange={noop}
      />,
    );
    expect(groupOrder(container)).toEqual(['when', 'where', 'message', 'extras']);
    expect(groupOf('announceOnStart')).toBe('when');
    expect(groupOf('useSchedule')).toBe('when');
    expect(groupOf('announceInterval')).toBe('when');
    expect(groupOf('announce-channel-0')).toBe('where');
    expect(groupOf('autoAnnounceHopLimit')).toBe('where');
    expect(groupOf('announceMessage')).toBe('message');
  });

  it('MeshCore: when, where, message, extras', async () => {
    const { container } = render(<MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" />);
    await waitFor(() => expect(document.getElementById('meshcoreAnnounceChannel0')).not.toBeNull());
    expect(groupOrder(container)).toEqual(['when', 'where', 'message', 'extras']);
    expect(groupOf('meshcoreAnnounceInterval')).toBe('when');
    expect(groupOf('meshcoreAnnounceChannel0')).toBe('where');
    expect(groupOf('meshcoreAnnounceMessage')).toBe('message');
  });

  it('both protocols offer token-insert buttons in the message group', async () => {
    const noop = vi.fn();
    const { container: mt } = render(
      <AutoAnnounceSection
        enabled
        intervalHours={6}
        message="hello"
        channelIndexes={[0]}
        announceOnStart={false}
        useSchedule={false}
        schedule="0 */6 * * *"
        channels={channels}
        baseUrl=""
        onEnabledChange={noop}
        onIntervalChange={noop}
        onMessageChange={noop}
        onChannelIndexesChange={noop}
        onAnnounceOnStartChange={noop}
        onUseScheduleChange={noop}
        onScheduleChange={noop}
      />,
    );
    const { container: mc } = render(<MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" />);
    await waitFor(() => expect(document.getElementById('meshcoreAnnounceChannel0')).not.toBeNull());
    for (const root of [mt, mc]) {
      const group = root.querySelector('[data-config-group="message"]') as HTMLElement;
      const labels = Array.from(group.querySelectorAll('button')).map((b) => b.textContent);
      expect(labels).toContain('+ {VERSION}');
      expect(labels).toContain('+ {DURATION}');
    }
  });
});
