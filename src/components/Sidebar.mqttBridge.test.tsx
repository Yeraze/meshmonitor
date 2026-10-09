/**
 * @vitest-environment jsdom
 *
 * The per-source sidebar on an MQTT bridge after the #5683 follow-up: the
 * bridge's "Configuration" entry is gone (its page is a section of Settings),
 * and the Settings entry opens for the grant that section needs too, so the
 * viewer who reached the bridge setup through the old tab still reaches it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import Sidebar from './Sidebar';
import type { ResourceType } from '../types/permission';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../contexts/SettingsContext', () => ({ useNodeListStyle: () => 'monochrome' }));

const setActiveTab = vi.fn();
const baseProps = {
  activeTab: 'nodes' as const,
  setActiveTab,
  isAdmin: false,
  isAuthenticated: true,
  unreadCounts: {},
  unreadCountsData: null,
  onMessagesClick: vi.fn(),
  onChannelsClick: vi.fn(),
  baseUrl: '',
};

/** Exactly these grants. `settings` is per-source (#4416): only an anySource ask passes. */
const viewer = (...grants: string[]) => (
  resource: ResourceType,
  action: 'read' | 'write',
  opts?: { sourceId?: string | null; anySource?: boolean },
): boolean => {
  if (resource === 'settings' && !opts?.anySource) return false;
  return grants.includes(`${resource}:${action}`);
};

const item = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-source-nav-item="${id}"]`);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Sidebar on an MQTT bridge (#5683 follow-up)', () => {
  it('has no bridge "Configuration" entry and no Device Configuration entry', () => {
    const { container } = render(
      <Sidebar {...baseProps} mqttReadOnly hasPermission={viewer('settings:read', 'sources:read', 'configuration:read')} />);
    expect(item(container, 'mqtt-config')).toBeNull();
    expect(item(container, 'configuration')).toBeNull();
    expect(item(container, 'settings')).not.toBeNull();
  });

  it('shows Settings for sources:read alone: the bridge setup lives there', () => {
    const { container } = render(
      <Sidebar {...baseProps} mqttReadOnly hasPermission={viewer('sources:read')} />);
    const settings = item(container, 'settings');
    expect(settings).not.toBeNull();
    fireEvent.click(settings!);
    expect(setActiveTab).toHaveBeenCalledWith('settings');
  });

  it('the footer gear follows the same rule, and stays "Settings" on a source', () => {
    const { container } = render(
      <Sidebar {...baseProps} mqttReadOnly hasPermission={viewer('sources:read')} />);
    const gear = container.querySelector<HTMLElement>('[data-source-nav-footer] button[title="source.sidebar.settings"]');
    expect(gear).not.toBeNull();
    fireEvent.click(gear!);
    expect(setActiveTab).toHaveBeenCalledWith('settings');
    expect(container.querySelector('[title="nav.global_settings"]')).toBeNull();
  });

  it('hides Settings with neither settings:read nor sources:read', () => {
    const { container } = render(
      <Sidebar {...baseProps} mqttReadOnly hasPermission={viewer('nodes:read')} />);
    expect(item(container, 'settings')).toBeNull();
    expect(container.querySelector('[data-source-nav-footer] button[title="source.sidebar.settings"]')).toBeNull();
  });

  it('sources:read does not open Settings on a source that is not a bridge', () => {
    for (const props of [{}, { hideDeviceConfig: true }]) {
      const { container, unmount } = render(
        <Sidebar {...baseProps} {...props} hasPermission={viewer('sources:read')} />);
      expect(item(container, 'settings')).toBeNull();
      unmount();
    }
  });

  it('settings:read still opens Settings on every source type', () => {
    for (const props of [{}, { mqttReadOnly: true }, { hideDeviceConfig: true }]) {
      const { container, unmount } = render(
        <Sidebar {...baseProps} {...props} hasPermission={viewer('settings:read')} />);
      expect(item(container, 'settings')).not.toBeNull();
      unmount();
    }
  });
});
