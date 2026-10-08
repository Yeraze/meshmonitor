import { describe, it, expect } from 'vitest';
import { MESHCORE_VIEWS, resolveMeshCoreView, visibleMeshCoreViews, type MeshCoreView } from './meshCoreViewAccess';

const views = (grants: string[], opts: { isAuthenticated?: boolean; showInfo?: boolean } = {}): MeshCoreView[] =>
  visibleMeshCoreViews({
    canRead: (resource) => grants.includes(resource),
    isAuthenticated: opts.isAuthenticated ?? false,
    showInfo: opts.showInfo,
  });

describe('visibleMeshCoreViews (#5666)', () => {
  it('no grant: the Nodes shell and Node Info only', () => {
    expect(views([])).toEqual(['nodes', 'info']);
  });

  // The grant set from #5666: connection, nodes and channel_0, no settings.
  it('the anonymous viewer from #5666 gets no Settings tab', () => {
    const got = views(['connection', 'nodes', 'channel_0']);
    expect(got).toEqual(['nodes', 'channels', 'info']);
    expect(got).not.toContain('settings');
  });

  it.each([
    ['settings', 'settings'],
    ['configuration', 'configuration'],
    ['automation', 'automations'],
    ['packetmonitor', 'packets'],
    ['dashboard', 'telemetry'],
  ] as const)('%s:read opens the %s tab, and nothing else', (resource, view) => {
    expect(views([resource])).toEqual(MESHCORE_VIEWS.filter((v) => v === 'nodes' || v === 'info' || v === view));
  });

  it('messages:read opens Channels, Rooms and Node Details', () => {
    expect(views(['messages'])).toEqual(['nodes', 'channels', 'rooms', 'dms', 'info']);
  });

  it.each(['channel_0', 'channel_3', 'channel_7'])('%s:read opens Channels, but not Rooms or Node Details', (resource) => {
    expect(views([resource])).toEqual(['nodes', 'channels', 'info']);
  });

  it('nodes:read and connection:read open no tab of their own', () => {
    expect(views(['nodes', 'connection'])).toEqual(['nodes', 'info']);
  });

  it('Notifications needs a signed-in user, not a grant', () => {
    expect(views([], { isAuthenticated: true })).toEqual(['nodes', 'info', 'notifications']);
    expect(views(['settings', 'configuration'])).not.toContain('notifications');
  });

  it('Info is dropped without a source context', () => {
    expect(views([], { showInfo: false })).toEqual(['nodes']);
  });

  it('every grant, signed in: every tab, in nav order', () => {
    const all = ['messages', 'dashboard', 'packetmonitor', 'configuration', 'automation', 'settings'];
    expect(views(all, { isAuthenticated: true })).toEqual([...MESHCORE_VIEWS]);
  });
});

describe('resolveMeshCoreView', () => {
  it('keeps a tab the viewer may open', () => {
    expect(resolveMeshCoreView('settings', ['nodes', 'settings'])).toBe('settings');
  });

  it.each(MESHCORE_VIEWS.filter((v) => v !== 'nodes'))('falls back to Nodes for a hidden %s tab', (view) => {
    expect(resolveMeshCoreView(view, ['nodes'])).toBe('nodes');
  });
});
