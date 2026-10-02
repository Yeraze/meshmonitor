/**
 * SettingsContext mute load/save is per source (#5487).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, act, waitFor } from '@testing-library/react';

// Mock CsrfContext
vi.mock('./CsrfContext', () => ({
  useCsrf: () => ({
    token: 'test-csrf-token',
    getToken: () => 'test-csrf-token',
    fetchToken: vi.fn().mockResolvedValue('test-csrf-token'),
  }),
}));

// Mock api service
const mockApi = vi.hoisted(() => ({
  getBaseUrl: vi.fn(),
  getConfig: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock('../services/api', () => ({ default: mockApi }));

// Mock logger
vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock i18n
vi.mock('../config/i18n', () => ({
  default: {
    changeLanguage: vi.fn().mockResolvedValue(undefined),
    language: 'en',
  },
}));

// Mock tilesets
vi.mock('../config/tilesets', () => ({
  DEFAULT_TILESET_ID: 'osm',
  type: 'TilesetId',
}));

// Mock overlayColors
vi.mock('../config/overlayColors', () => ({
  getSchemeForTileset: vi.fn().mockReturnValue('default'),
  getOverlayColors: vi.fn().mockReturnValue({
    primary: '#ff0000',
    secondary: '#00ff00',
  }),
}));

// Mock EmojiPickerModal
vi.mock('../components/EmojiPickerModal/EmojiPickerModal', () => ({
  DEFAULT_TAPBACK_EMOJIS: ['👍', '❤️', '😂'],
}));

// Mock themeValidation
vi.mock('../utils/themeValidation', () => ({
  OPTIONAL_THEME_COLORS: [],
}));

// Mock temperature util
vi.mock('../utils/temperature', () => ({
  type: 'TemperatureUnit',
}));

global.fetch = vi.fn().mockImplementation(() => Promise.resolve({ ok: true, json: async () => ({}) })) as any;

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

/** Server rows by sourceId; '' is the default row. */
let rows: Record<string, Record<string, unknown>> = {};

function installApi() {
  mockApi.getBaseUrl.mockResolvedValue('');
  mockApi.getConfig.mockResolvedValue({});
  mockApi.get.mockImplementation(async (url: string) => {
    const m = url.match(/sourceId=([^&]+)/);
    const sid = m ? decodeURIComponent(m[1]) : '';
    if (rows[sid]) return { ...rows[sid], sourceFallback: false };
    return { ...(rows[''] ?? { mutedChannels: [], mutedDMs: [] }), sourceFallback: sid !== '' };
  });
  // The server merges a POST onto the stored row (partial update).
  mockApi.post.mockImplementation(async (_url: string, body: Record<string, unknown>) => {
    const { sourceId, ...fields } = body;
    const sid = (sourceId as string) ?? '';
    rows[sid] = { ...(rows[sid] ?? {}), ...fields };
    return { success: true };
  });
}

async function renderWith(sourceId: string | null, sourceType: string | null) {
  const { SettingsProvider, useSettings } = await import('./SettingsContext');
  const { SourceProvider } = await import('./SourceContext');
  const ctx: { current: any } = { current: null };
  const Consumer = () => {
    ctx.current = useSettings();
    return null;
  };
  const tree = (sid: string | null, type: string | null) => (
    <SourceProvider sourceId={sid} sourceType={type}>
      <SettingsProvider>
        <Consumer />
      </SettingsProvider>
    </SourceProvider>
  );
  let utils: ReturnType<typeof render>;
  await act(async () => {
    utils = render(tree(sourceId, sourceType));
  });
  return { ctx, rerender: (sid: string | null, type: string | null) => utils.rerender(tree(sid, type)) };
}

describe('SettingsContext — per-source mutes (#5487)', () => {
  beforeEach(() => {
    rows = {};
    vi.clearAllMocks();
    installApi();
  });

  it('loads mutes with the active sourceId', async () => {
    rows['A'] = { mutedChannels: [{ channelId: 2, muteUntil: null }], mutedDMs: [] };
    const { ctx } = await renderWith('A', 'meshtastic_tcp');
    await waitFor(() => expect(ctx.current.isChannelMuted(2)).toBe(true));
    expect(mockApi.get).toHaveBeenCalledWith('/api/push/preferences?sourceId=A');
  });

  it('saves a channel mute by posting only the channel list, so the server keeps the rest', async () => {
    rows['A'] = { enableWebPush: false, mutedChannels: [], mutedDMs: [{ nodeUuid: '!aaaa', muteUntil: null }] };
    const { ctx } = await renderWith('A', 'meshtastic_tcp');
    await waitFor(() => expect(ctx.current.isDMMuted('!aaaa')).toBe(true));

    // A DM mute added elsewhere (another tab) after this provider loaded.
    rows['A'] = { ...rows['A'], mutedDMs: [{ nodeUuid: '!aaaa', muteUntil: null }, { nodeUuid: '!bbbb', muteUntil: null }] };
    const getsBefore = mockApi.get.mock.calls.length;

    await act(async () => {
      await ctx.current.muteChannel(3, null);
    });
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    const body = mockApi.post.mock.calls[0][1];
    // Only the list it changes: no DM list, no other settings, no defaults.
    expect(body).toEqual({ sourceId: 'A', mutedChannels: [{ channelId: 3, muteUntil: null }] });
    // No client-side read-modify-write.
    expect(mockApi.get.mock.calls.length).toBe(getsBefore);
    expect(rows['A'].mutedDMs).toHaveLength(2);
    expect(rows['A'].enableWebPush).toBe(false);
  });

  it('saves a DM mute by posting only the DM list', async () => {
    rows['A'] = { mutedChannels: [{ channelId: 1, muteUntil: null }], mutedDMs: [] };
    const { ctx } = await renderWith('A', 'meshtastic_tcp');
    await waitFor(() => expect(ctx.current.isChannelMuted(1)).toBe(true));

    await act(async () => {
      await ctx.current.muteDM('!cccc', null);
    });
    const body = mockApi.post.mock.calls[0][1];
    expect(body).toEqual({ sourceId: 'A', mutedDMs: [{ nodeUuid: '!cccc', muteUntil: null }] });
    expect(rows['A'].mutedChannels).toEqual([{ channelId: 1, muteUntil: null }]);
  });

  it('reverts the toggle when the save fails', async () => {
    rows['A'] = { mutedChannels: [], mutedDMs: [] };
    const { ctx } = await renderWith('A', 'meshtastic_tcp');
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    mockApi.post.mockRejectedValueOnce(new Error('500'));
    await act(async () => {
      await ctx.current.muteChannel(3, null);
    });
    expect(ctx.current.isChannelMuted(3)).toBe(false);
  });

  it('reloads mutes when the source changes', async () => {
    rows['A'] = { mutedChannels: [{ channelId: 1, muteUntil: null }], mutedDMs: [] };
    rows['B'] = { mutedChannels: [], mutedDMs: [] };
    const { ctx, rerender } = await renderWith('A', 'meshtastic_tcp');
    await waitFor(() => expect(ctx.current.isChannelMuted(1)).toBe(true));
    await act(async () => {
      rerender('B', 'meshtastic_tcp');
    });
    await waitFor(() => expect(ctx.current.isChannelMuted(1)).toBe(false));
  });

  it('a Meshtastic source with no row still sees the default-row mutes', async () => {
    rows[''] = { mutedChannels: [{ channelId: 1, muteUntil: null }], mutedDMs: [] };
    const { ctx } = await renderWith('A', 'meshtastic_tcp');
    await waitFor(() => expect(ctx.current.isChannelMuted(1)).toBe(true));
  });

  it('a MeshCore source ignores default-row (Meshtastic) mutes and saves only its own', async () => {
    rows[''] = { mutedChannels: [{ channelId: 1, muteUntil: null }], mutedDMs: [{ nodeUuid: '!aaaa', muteUntil: null }] };
    const { ctx } = await renderWith('MC', 'meshcore');
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    expect(ctx.current.isChannelMuted(1)).toBe(false);

    await act(async () => {
      await ctx.current.muteChannel(4, null);
    });
    const body = mockApi.post.mock.calls[0][1];
    expect(body.sourceId).toBe('MC');
    // The server, not the client, keeps the '' row's Meshtastic DM mutes off a
    // MeshCore source's first row; the client sends only the channel list.
    expect(body).toEqual({ sourceId: 'MC', mutedChannels: [{ channelId: 4, muteUntil: null }] });
  });
});
