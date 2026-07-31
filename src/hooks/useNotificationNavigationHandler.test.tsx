/**
 * @vitest-environment jsdom
 *
 * Tests for useNotificationNavigationHandler's route-awareness (#4463).
 *
 * Covers the two behaviours added when the notification deep link moved from
 * the scope root + hash to a real `/source/:sourceId/<tab>` route:
 *
 * 1. Nothing is applied — and nothing is *cleared* — until the source route
 *    has resolved. `setActiveTab` is a no-op while `useParams().sourceId` is
 *    undefined, so clearing early would drop the navigation permanently.
 * 2. A notification for a different source hands off via the router, and the
 *    navigation is applied only once the route has caught up — never against
 *    whichever source happened to be open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { NotificationNavigationData } from '../utils/notificationUrl';

const mockClearPendingNavigation = vi.fn();
let mockPendingNavigation: NotificationNavigationData | null = null;

vi.mock('./usePushNotificationNavigation', () => ({
  usePushNotificationNavigation: () => ({
    pendingNavigation: mockPendingNavigation,
    clearPendingNavigation: mockClearPendingNavigation,
  }),
}));

import { useNotificationNavigationHandler } from './useNotificationNavigationHandler';

/** Path the router is currently on, kept current by <LocationRecorder />. */
let currentPath = '';

function LocationRecorder() {
  currentPath = useLocation().pathname;
  return null;
}

/**
 * Callbacks that record the route in effect at the moment they were called, so
 * a navigation applied against the *wrong* source is observable.
 */
function makeCallbacks() {
  const pathsWhenCalled: Record<string, string[]> = {
    setActiveTab: [],
    setSelectedChannel: [],
    setSelectedDMNode: [],
  };
  return {
    pathsWhenCalled,
    setActiveTab: vi.fn(() => void pathsWhenCalled.setActiveTab.push(currentPath)),
    setSelectedChannel: vi.fn(() => void pathsWhenCalled.setSelectedChannel.push(currentPath)),
    setSelectedDMNode: vi.fn(() => void pathsWhenCalled.setSelectedDMNode.push(currentPath)),
  };
}

const READY_STATE = {
  connectionStatus: 'connected',
  channels: [{ id: 0 }],
  activeTab: 'nodes',
  selectedChannel: 0,
  selectedDMNode: null,
};

/**
 * Render the hook underneath a route, so `useParams().sourceId` resolves
 * exactly as it does in the real app (App.tsx renders under
 * `source/:sourceId/*`). An `initialPath` of '/' leaves sourceId undefined.
 */
function renderAtPath(initialPath: string, callbacks: ReturnType<typeof makeCallbacks>) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[initialPath]}>
      <LocationRecorder />
      <Routes>
        <Route path="source/:sourceId/*" element={<>{children}</>} />
        <Route path="*" element={<>{children}</>} />
      </Routes>
    </MemoryRouter>
  );

  return renderHook(() => useNotificationNavigationHandler(callbacks, READY_STATE), { wrapper });
}

describe('useNotificationNavigationHandler — route awareness (#4463)', () => {
  beforeEach(() => {
    mockPendingNavigation = null;
    mockClearPendingNavigation.mockClear();
    currentPath = '';
  });

  it('applies a channel navigation when the route source matches', () => {
    mockPendingNavigation = {
      type: 'channel',
      sourceId: 'src-a',
      channelId: 3,
      messageId: 'm1',
    };
    const callbacks = makeCallbacks();

    renderAtPath('/source/src-a/nodes', callbacks);

    expect(callbacks.setActiveTab).toHaveBeenCalledWith('channels');
    expect(callbacks.setSelectedChannel).toHaveBeenCalledWith(3);
    expect(mockClearPendingNavigation).toHaveBeenCalled();
  });

  it('applies a DM navigation when the route source matches', () => {
    mockPendingNavigation = {
      type: 'dm',
      sourceId: 'src-a',
      senderNodeId: '!node123',
      messageId: 'm2',
    };
    const callbacks = makeCallbacks();

    renderAtPath('/source/src-a/nodes', callbacks);

    expect(callbacks.setActiveTab).toHaveBeenCalledWith('messages');
    expect(callbacks.setSelectedDMNode).toHaveBeenCalledWith('!node123');
    expect(mockClearPendingNavigation).toHaveBeenCalled();
  });

  it('still applies navigation for payloads with no sourceId (pre-4.13.4)', () => {
    mockPendingNavigation = { type: 'channel', channelId: 2 };
    const callbacks = makeCallbacks();

    renderAtPath('/source/src-a/nodes', callbacks);

    expect(callbacks.setActiveTab).toHaveBeenCalledWith('channels');
    expect(callbacks.setSelectedChannel).toHaveBeenCalledWith(2);
  });

  it('does not clear the navigation while the source route is unresolved', () => {
    // The regression this guards: setActiveTab is a no-op without a sourceId,
    // so clearing here would lose the notification with no retry.
    mockPendingNavigation = { type: 'channel', sourceId: 'src-a', channelId: 3 };
    const callbacks = makeCallbacks();

    renderAtPath('/', callbacks);

    expect(callbacks.setActiveTab).not.toHaveBeenCalled();
    expect(callbacks.setSelectedChannel).not.toHaveBeenCalled();
    expect(mockClearPendingNavigation).not.toHaveBeenCalled();
  });

  it('routes to the target source before applying a cross-source notification', () => {
    mockPendingNavigation = { type: 'channel', sourceId: 'src-b', channelId: 3 };
    const callbacks = makeCallbacks();

    renderAtPath('/source/src-a/nodes', callbacks);

    // The hand-off completes: the router switches to src-b and only then is
    // the channel applied. Applying it while still on src-a would select
    // channel 3 of the wrong source.
    expect(currentPath).toBe('/source/src-b/channels');
    expect(callbacks.pathsWhenCalled.setSelectedChannel).toEqual(['/source/src-b/channels']);
    expect(callbacks.pathsWhenCalled.setActiveTab).toEqual(['/source/src-b/channels']);
  });

  it('routes to the target source for a cross-source DM', () => {
    mockPendingNavigation = { type: 'dm', sourceId: 'src-b', senderNodeId: '!x' };
    const callbacks = makeCallbacks();

    renderAtPath('/source/src-a/nodes', callbacks);

    expect(currentPath).toBe('/source/src-b/messages');
    expect(callbacks.pathsWhenCalled.setSelectedDMNode).toEqual(['/source/src-b/messages']);
  });

  it('does not lose a cross-source navigation during the hand-off', () => {
    // react-router's pushState does not remount this hook, so clearing before
    // the route catches up would leave nothing to re-read the navigation.
    mockPendingNavigation = { type: 'dm', sourceId: 'src-b', senderNodeId: '!x' };
    const callbacks = makeCallbacks();

    renderAtPath('/source/src-a/nodes', callbacks);

    expect(callbacks.setSelectedDMNode).toHaveBeenCalledWith('!x');
  });
});
