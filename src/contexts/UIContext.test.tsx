import { describe, it, expect } from 'vitest';
import type { TabType, SortField, SortDirection } from '../types/ui';

describe('UIContext Types', () => {
  it('should support TabType values', () => {
    const nodesTab: TabType = 'nodes';
    const channelsTab: TabType = 'channels';
    const messagesTab: TabType = 'messages';
    const settingsTab: TabType = 'settings';
    const infoTab: TabType = 'info';
    const dashboardTab: TabType = 'dashboard';

    expect(nodesTab).toBe('nodes');
    expect(channelsTab).toBe('channels');
    expect(messagesTab).toBe('messages');
    expect(settingsTab).toBe('settings');
    expect(infoTab).toBe('info');
    expect(dashboardTab).toBe('dashboard');
  });

  it('should support showMqttMessages boolean type', () => {
    const show: boolean = true;
    const hide: boolean = false;

    expect(show).toBe(true);
    expect(hide).toBe(false);
  });

  it('should support error string or null type', () => {
    const errorMessage: string | null = 'Connection failed';
    const noError: string | null = null;

    expect(errorMessage).toBe('Connection failed');
    expect(noError).toBeNull();
  });

  it('should support tracerouteLoading string or null type', () => {
    const loading: string | null = '!12345678';
    const notLoading: string | null = null;

    expect(loading).toBe('!12345678');
    expect(notLoading).toBeNull();
  });

  it('should support nodeFilter string type', () => {
    const filter: string = 'test';
    const noFilter: string = '';

    expect(filter).toBe('test');
    expect(noFilter).toBe('');
  });

  it('should support SortField values', () => {
    const longName: SortField = 'longName';
    const shortName: SortField = 'shortName';
    const id: SortField = 'id';
    const lastHeard: SortField = 'lastHeard';
    const snr: SortField = 'snr';
    const battery: SortField = 'battery';
    const hwModel: SortField = 'hwModel';
    const hops: SortField = 'hops';

    expect(longName).toBe('longName');
    expect(shortName).toBe('shortName');
    expect(id).toBe('id');
    expect(lastHeard).toBe('lastHeard');
    expect(snr).toBe('snr');
    expect(battery).toBe('battery');
    expect(hwModel).toBe('hwModel');
    expect(hops).toBe('hops');
  });

  it('should support SortDirection values', () => {
    const asc: SortDirection = 'asc';
    const desc: SortDirection = 'desc';

    expect(asc).toBe('asc');
    expect(desc).toBe('desc');
  });

  it('should support showStatusModal boolean type', () => {
    const show: boolean = true;
    const hide: boolean = false;

    expect(show).toBe(true);
    expect(hide).toBe(false);
  });

  it('should support systemStatus any type', () => {
    const status: any = {
      uptime: 3600,
      memoryUsage: 0.75,
      version: '1.0.0'
    };
    const noStatus: any = null;

    expect(status).toBeDefined();
    expect(status.uptime).toBe(3600);
    expect(noStatus).toBeNull();
  });

  it('should support nodePopup object or null type', () => {
    const popup: {nodeId: string, position: {x: number, y: number}} | null = {
      nodeId: '!12345678',
      position: { x: 100, y: 200 }
    };
    const noPopup: {nodeId: string, position: {x: number, y: number}} | null = null;

    expect(popup).toBeDefined();
    expect(popup?.nodeId).toBe('!12345678');
    expect(popup?.position.x).toBe(100);
    expect(popup?.position.y).toBe(200);
    expect(noPopup).toBeNull();
  });

  it('should support sorting configuration', () => {
    interface SortConfig {
      field: SortField;
      direction: SortDirection;
    }

    const sortByName: SortConfig = {
      field: 'longName',
      direction: 'asc'
    };

    const sortBySignal: SortConfig = {
      field: 'snr',
      direction: 'desc'
    };

    expect(sortByName.field).toBe('longName');
    expect(sortByName.direction).toBe('asc');
    expect(sortBySignal.field).toBe('snr');
    expect(sortBySignal.direction).toBe('desc');
  });

  it('should support node filtering and sorting workflow', () => {
    let filter: string = '';
    let sortField: SortField = 'longName';
    let sortDirection: SortDirection = 'asc';

    // User types filter
    filter = 'base';
    expect(filter).toBe('base');

    // User changes sort field
    sortField = 'lastHeard';
    expect(sortField).toBe('lastHeard');

    // User toggles sort direction
    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    expect(sortDirection).toBe('desc');

    // User clears filter
    filter = '';
    expect(filter).toBe('');
  });
});
