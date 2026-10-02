/**
 * @vitest-environment jsdom
 *
 * #5520 — stored (shared) translations show to every viewer, anonymous
 * included, without a click and without a provider call; only viewers who can
 * translate get the Translate button / language switch.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChannelsTab from './ChannelsTab';
import apiService from '../services/api';
import { AuthContext } from '../contexts/AuthContext';
import type { MeshMessage } from '../types/message';

vi.mock('../hooks/useServerData', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNodes: () => ({ nodes: [], isLoading: false, error: null }),
}));

vi.mock('../contexts/SettingsContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSettings: () => ({ distanceUnit: 'km' }),
  useNotificationMuteSettings: () => ({
    isChannelMuted: () => false,
    muteChannel: async () => {},
    unmuteChannel: async () => {},
  }),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  const t = (key: string, opts?: Record<string, unknown>) =>
    (opts?.defaultValue as string) ?? (typeof opts === 'string' ? opts : key);
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    useTranslation: createReactI18nextMock(t).useTranslation,
  };
});

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const msg: MeshMessage = {
  id: 'src1_111_5000',
  from: '!aaaaaaaa',
  to: '^all',
  fromNodeId: '!aaaaaaaa',
  toNodeId: '^all',
  text: 'Guten Morgen',
  channel: 0,
  timestamp: new Date('2026-07-21T12:00:00Z'),
};
const untranslated: MeshMessage = { ...msg, id: 'src1_111_5001', text: 'Noch eine' };

type ChannelsTabProps = React.ComponentProps<typeof ChannelsTab>;

function makeProps(): ChannelsTabProps {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    channels: [{ id: 0, name: 'Primary', psk: '', uplinkEnabled: true, downlinkEnabled: true }],
    channelDatabaseEntries: [],
    channelMessages: { 0: [msg, untranslated] },
    messages: [msg, untranslated],
    currentNodeId: '!cccccccc',
    sourceId: 'src1',
    connectionStatus: 'connected',
    selectedChannel: 0,
    setSelectedChannel: noop,
    selectedChannelRef: { current: 0 },
    showMqttMessages: true,
    setShowMqttMessages: noop,
    newMessage: '',
    setNewMessage: noop,
    replyingTo: null,
    setReplyingTo: noop,
    unreadCounts: {},
    setUnreadCounts: noop,
    markMessagesAsRead: noop,
    channelInfoModal: null,
    setChannelInfoModal: noop,
    showPsk: false,
    setShowPsk: noop,
    timeFormat: '24' as const,
    dateFormat: 'MM/DD/YYYY' as const,
    hasPermission: () => true,
    handleSendMessage: asyncNoop,
    handleResendMessage: asyncNoop,
    handleDeleteMessage: asyncNoop,
    handleSendTapback: noop,
    handlePurgeChannelMessages: asyncNoop,
    handleSenderClick: noop,
    shouldShowData: () => true,
    getNodeName: () => 'Alice Node',
    getNodeShortName: () => 'ALC',
    isMqttBridgeMessage: () => false,
    setEmojiPickerMessage: noop,
    channelMessagesContainerRef: { current: null },
  } as unknown as ChannelsTabProps;
}

function renderTab(auth?: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={qc}>
      <ChannelsTab {...makeProps()} />
    </QueryClientProvider>
  );
  return render(auth ? <AuthContext.Provider value={auth as never}>{tree}</AuthContext.Provider> : tree);
}

describe('ChannelsTab stored translations (#5520)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
    vi.spyOn(apiService, 'get').mockImplementation(async (url: string) => {
      if (url === '/api/settings') {
        return { translationEnabled: 'true', translationDefaultLanguage: 'en' } as never;
      }
      return {} as never;
    });
    vi.spyOn(apiService, 'getStoredTranslations').mockResolvedValue({
      [msg.id]: { translatedText: 'Good morning', detectedSourceLanguage: 'de', provider: 'deepl' },
    });
    vi.spyOn(apiService, 'translateMessage');
  });

  it('shows a stored translation to an anonymous viewer without a click, and offers no Translate button', async () => {
    renderTab();

    await waitFor(() => expect(screen.getByText('Good morning')).toBeTruthy());
    // The original text stays visible.
    expect(screen.getByText('Guten Morgen')).toBeTruthy();
    expect(apiService.getStoredTranslations).toHaveBeenCalledWith('src1', expect.any(String), [msg.id, untranslated.id]);
    // Anonymous: no translate controls, and no language switch on the stored one.
    expect(document.querySelector('.translate-button')).toBeNull();
    expect(screen.queryByTestId('inline-target-lang-select')).toBeNull();
    expect(apiService.translateMessage).not.toHaveBeenCalled();
  });

  it('logged-in translators see the stored translation plus Translate controls', async () => {
    renderTab({
      authStatus: { authenticated: true, user: { id: 1, username: 'u' } },
      hasPermission: () => true,
    });

    await waitFor(() => expect(screen.getByText('Good morning')).toBeTruthy());
    expect(document.querySelectorAll('.translate-button').length).toBeGreaterThan(0);
    expect(screen.getByTestId('inline-target-lang-select')).toBeTruthy();
  });

  it('fetches nothing when translation is disabled', async () => {
    vi.spyOn(apiService, 'get').mockResolvedValue({ translationEnabled: 'false' } as never);
    renderTab();
    await waitFor(() => expect(apiService.get).toHaveBeenCalled());
    expect(apiService.getStoredTranslations).not.toHaveBeenCalled();
    expect(screen.queryByText('Good morning')).toBeNull();
  });
});
