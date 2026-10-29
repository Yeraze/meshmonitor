/**
 * @vitest-environment jsdom
 *
 * The per-source app's tabs are lazy chunks (appTabs.ts). Each tab module is
 * stubbed here, with a counter on its factory, so the test sees exactly which
 * chunk a preload or a render asks for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import RouteLoading from './components/RouteLoading/RouteLoading';

const loaded = vi.hoisted(() => new Set<string>());
const stub = (name: string) => {
  loaded.add(name);
  return { default: () => <div>{name} body</div> };
};

vi.mock('./components/InfoTab', () => stub('InfoTab'));
vi.mock('./components/SettingsTab', () => stub('SettingsTab'));
vi.mock('./components/ConfigurationTab', () => stub('ConfigurationTab'));
vi.mock('./components/MQTT/MqttBridgeConfigurationView', () => stub('MqttBridgeConfigurationView'));
vi.mock('./components/NotificationsTab', () => stub('NotificationsTab'));
vi.mock('./components/UsersTab', () => stub('UsersTab'));
vi.mock('./components/AuditLogTab', () => stub('AuditLogTab'));
vi.mock('./components/SecurityTab', () => {
  loaded.add('SecurityTab');
  return { SecurityTab: () => <div>SecurityTab body</div> };
});
vi.mock('./components/AdminCommandsTab', () => stub('AdminCommandsTab'));
vi.mock('./components/Dashboard', () => stub('Dashboard'));
vi.mock('./components/NodesTab', () => stub('NodesTab'));
vi.mock('./components/MessagesTab', () => stub('MessagesTab'));
vi.mock('./components/ChannelsTab', () => stub('ChannelsTab'));
vi.mock('./components/PacketMonitorPanel', () => stub('PacketMonitorPanel'));
vi.mock('./components/MQTT/MqttPacketMonitorView', () => stub('MqttPacketMonitorView'));
vi.mock('./components/AutomationTab', () => stub('AutomationTab'));

// Imported after the mocks are registered.
const tabs = await import('./appTabs');

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('appTabs', () => {
  beforeEach(() => {
    loaded.clear();
  });

  it('renders a lazy tab through Suspense, showing the pane placeholder first', async () => {
    const { ChannelsTab } = tabs;
    render(
      <Suspense fallback={<RouteLoading variant="pane" />}>
        <ChannelsTab />
      </Suspense>,
    );
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(await screen.findByText('ChannelsTab body')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('unwraps a named export (SecurityTab)', async () => {
    const { SecurityTab } = tabs;
    render(
      <Suspense fallback={null}>
        <SecurityTab onTabChange={() => {}} onSelectDMNode={() => {}} />
      </Suspense>,
    );
    expect(await screen.findByText('SecurityTab body')).toBeTruthy();
  });

  it('preloads only the tab named by the route splat', async () => {
    tabs.preloadAppTabForPath('messages/!abcd');
    await settle();
    expect([...loaded]).toEqual(['MessagesTab']);
  });

  it('preloads the index tab (nodes) for an empty splat', async () => {
    tabs.preloadAppTabForPath('');
    tabs.preloadAppTabForPath(undefined);
    await settle();
    expect([...loaded]).toEqual(['NodesTab']);
  });

  it('ignores ids that are not tab routes', async () => {
    tabs.preloadAppTab('config-search');
    tabs.preloadAppTab('search');
    await settle();
    expect(loaded.size).toBe(0);
  });
});
