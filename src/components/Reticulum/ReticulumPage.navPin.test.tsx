/**
 * @vitest-environment jsdom
 *
 * ReticulumPage — Pin sidebar parity with the Meshtastic and MeshCore sidebars
 * (#6118, applying the #5481 approach): one global `sidebar-pinned` key, the
 * nav starts expanded when pinned, and an unpinned nav collapses after a nav
 * click. Harness mirrors MeshCorePage.navPin.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('./hooks/useReticulum', () => ({
  useReticulum: () => ({
    status: { connected: true, mode: 'own', destinationCount: 0, interfaceCount: 0 },
    destinations: [],
    interfaces: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    toggleFavorite: vi.fn(),
    conversations: [],
    conversationsLoading: false,
    activePeerHash: null,
    messages: [],
    messagesLoading: false,
    hasMoreMessages: false,
    loadConversation: vi.fn(),
    loadMoreMessages: vi.fn(),
    sendMessage: vi.fn(),
    identity: null,
    paths: [],
    probeResult: null,
    probingHash: null,
    probe: vi.fn(),
    remoteStatus: null,
    remoteStatusLoading: false,
    queryRemoteStatus: vi.fn(),
  }),
}));

vi.mock('./ReticulumSubToolbar', () => ({
  ReticulumSubToolbar: (props: {
    expanded: boolean;
    pinned?: boolean;
    onSelect: (v: string) => void;
    onToggleExpanded: () => void;
    onTogglePin?: () => void;
  }) => (
    <div data-testid="nav" data-expanded={String(props.expanded)} data-pinned={String(props.pinned)}>
      <button type="button" onClick={() => props.onSelect('interfaces')}>select</button>
      <button type="button" onClick={props.onToggleExpanded}>toggle</button>
      <button type="button" onClick={props.onTogglePin}>pin</button>
    </div>
  ),
}));

vi.mock('./ReticulumDestinationsView', () => ({ ReticulumDestinationsView: () => null }));
vi.mock('./ReticulumInterfacesView', () => ({ ReticulumInterfacesView: () => null }));
vi.mock('./ReticulumDmsView', () => ({ ReticulumDmsView: () => null }));
vi.mock('./ReticulumInfoView', () => ({ ReticulumInfoView: () => null }));
vi.mock('./ReticulumSettingsView', () => ({ ReticulumSettingsView: () => null }));
vi.mock('./ReticulumMap', () => ({ ReticulumMap: () => null }));
vi.mock('./ReticulumConfigurationView', () => ({ ReticulumConfigurationView: () => null }));
vi.mock('./ReticulumPathsView', () => ({ ReticulumPathsView: () => null }));

import { ReticulumPage } from './ReticulumPage';

const nav = () => screen.getByTestId('nav');

describe('ReticulumPage — Pin sidebar (#6118)', () => {
  beforeEach(() => localStorage.clear());

  it('starts collapsed and collapses again after a nav click when unpinned', () => {
    render(<ReticulumPage baseUrl="" sourceId="src-1" />);
    expect(nav().dataset.expanded).toBe('false');
    fireEvent.click(screen.getByText('toggle'));
    expect(nav().dataset.expanded).toBe('true');
    fireEvent.click(screen.getByText('select'));
    expect(nav().dataset.expanded).toBe('false');
  });

  it('pinning expands the nav, stores the shared key, and keeps it open on nav clicks', () => {
    render(<ReticulumPage baseUrl="" sourceId="src-1" />);
    fireEvent.click(screen.getByText('pin'));
    expect(nav().dataset.pinned).toBe('true');
    expect(nav().dataset.expanded).toBe('true');
    expect(localStorage.getItem('sidebar-pinned')).toBe('true');
    fireEvent.click(screen.getByText('select'));
    expect(nav().dataset.expanded).toBe('true');
  });

  it('starts expanded when the shared pin is already set (e.g. from a Meshtastic source)', () => {
    localStorage.setItem('sidebar-pinned', 'true');
    render(<ReticulumPage baseUrl="" sourceId="src-1" />);
    expect(nav().dataset.pinned).toBe('true');
    expect(nav().dataset.expanded).toBe('true');
  });

  it('unpinning stores false and lets the next nav click collapse', () => {
    localStorage.setItem('sidebar-pinned', 'true');
    render(<ReticulumPage baseUrl="" sourceId="src-1" />);
    fireEvent.click(screen.getByText('pin'));
    expect(localStorage.getItem('sidebar-pinned')).toBe('false');
    fireEvent.click(screen.getByText('select'));
    expect(nav().dataset.expanded).toBe('false');
  });
});
