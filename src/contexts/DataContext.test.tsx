/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DeviceInfo, Channel } from '../types/device';
import type { MeshMessage } from '../types/message';
import type { ConnectionStatus } from '../types/ui';
import { DataProvider, useData } from './DataContext';

// Pin test for #3962 5.4 PR8: DataContext no longer exposes nodes/channels
// (or their setters) at all — see the header comment in DataContext.tsx.
// A type-level assertion is enough since removing them is a compile-time
// change: if any of these keys reappear on DataContextType, `never` no
// longer satisfies the constraint and this file fails to build.
type DataContextValue = ReturnType<typeof useData>;
type RemovedKeys = 'nodes' | 'setNodes' | 'channels' | 'setChannels';
type _AssertRemoved = Extract<keyof DataContextValue, RemovedKeys> extends never ? true : never;
const _assertRemoved: _AssertRemoved = true;
void _assertRemoved;

describe('DataContext value memoization (#3962 Phase 5.2)', () => {
  it('returns a referentially stable value across an unrelated parent re-render', () => {
    const { result, rerender } = renderHook(() => useData(), {
      wrapper: ({ children }) => <DataProvider>{children}</DataProvider>,
    });

    const firstValue = result.current;

    // Re-render the tree without changing any DataContext state.
    rerender();

    expect(result.current).toBe(firstValue);
  });

  it('produces a new value when a piece of state actually changes', () => {
    const { result } = renderHook(() => useData(), {
      wrapper: ({ children }) => <DataProvider>{children}</DataProvider>,
    });

    const firstValue = result.current;

    // nodes/setNodes were removed from DataContext (#3962 5.4 PR8) — this
    // used to exercise the memoization via setNodes; connectionStatus is
    // the closest remaining DataContext-owned piece of state (see the
    // header comment in DataContext.tsx for why it, unlike nodes/channels,
    // stays here rather than moving to the poll cache).
    act(() => {
      result.current.setConnectionStatus('connected');
    });

    expect(result.current).not.toBe(firstValue);
    expect(result.current.connectionStatus).toBe('connected');
  });
});

describe('DataContext Types', () => {
  // nodes/channels were removed from DataContext (#3962 5.4 PR8) — they were
  // pure poll-cache mirrors, so they moved to useNodes()/useChannels()
  // (see src/hooks/useServerData.test.ts) rather than staying here. The
  // DeviceInfo/Channel "type structure" tests below build local mock
  // objects and never touch useData(), so they remain valid unchanged.
  it('should have correct DeviceInfo array type structure', () => {
    const mockNodes: DeviceInfo[] = [
      {
        nodeNum: 305419896,
        user: {
          id: '!12345678',
          longName: 'Test Node',
          shortName: 'TST1',
          role: 'CLIENT'
        },
        position: {
          latitude: 40.7128,
          longitude: -74.0060,
          altitude: 10
        },
        hopsAway: 0
      }
    ];

    expect(mockNodes).toHaveLength(1);
    expect(mockNodes[0].nodeNum).toBe(305419896);
    expect(mockNodes[0].user?.longName).toBe('Test Node');
    expect(mockNodes[0].position?.latitude).toBe(40.7128);
  });

  it('should have correct Channel array type structure', () => {
    const mockChannels: Channel[] = [
      {
        id: 0,
        name: 'LongFast',
        psk: 'AQ==',
        uplinkEnabled: true,
        downlinkEnabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    expect(mockChannels).toHaveLength(1);
    expect(mockChannels[0].id).toBe(0);
    expect(mockChannels[0].name).toBe('LongFast');
    expect(mockChannels[0].uplinkEnabled).toBe(true);
  });

  it('should have correct MeshMessage array type structure', () => {
    const mockMessages: MeshMessage[] = [
      {
        id: '1',
        from: '!12345678',
        to: '!87654321',
        fromNodeId: '!12345678',
        toNodeId: '!87654321',
        channel: 0,
        text: 'Test message',
        timestamp: new Date()
      }
    ];

    expect(mockMessages).toHaveLength(1);
    expect(mockMessages[0].from).toBe('!12345678');
    expect(mockMessages[0].text).toBe('Test message');
  });

  it('should have correct ConnectionStatus type values', () => {
    const connected: ConnectionStatus = 'connected';
    const connecting: ConnectionStatus = 'connecting';
    const disconnected: ConnectionStatus = 'disconnected';

    expect(connected).toBe('connected');
    expect(connecting).toBe('connecting');
    expect(disconnected).toBe('disconnected');
  });

  it('should support channelMessages object type', () => {
    const mockChannelMessages: {[key: number]: MeshMessage[]} = {
      0: [
        {
          id: '1',
          from: '!12345678',
          to: '^all',
          fromNodeId: '!12345678',
          toNodeId: '^all',
          channel: 0,
          text: 'Channel message',
          timestamp: new Date()
        }
      ],
      1: []
    };

    expect(mockChannelMessages[0]).toHaveLength(1);
    expect(mockChannelMessages[0][0].text).toBe('Channel message');
    expect(mockChannelMessages[1]).toHaveLength(0);
  });

  // nodesWithTelemetry/nodesWithWeatherTelemetry/nodesWithEstimatedPosition/
  // nodesWithPKC were removed from DataContext (#3962 5.4 PR2) — they are
  // now sourced directly from the poll cache via useTelemetryNodes()
  // (see src/hooks/useServerData.test.ts).

  // messages/channelMessages (+ their pagination state) were removed from
  // DataContext (#3962 5.4 PR7) — they were never pure poll-cache mirrors,
  // so they moved to useMessagingView rather than a selector (see
  // src/hooks/useMessagingView.test.ts). The MeshMessage/channelMessages
  // "type structure" tests above build local mock objects and never touch
  // useData(), so they remain valid unchanged.

  it('should support deviceInfo any type', () => {
    const mockDeviceInfo: any = {
      myNodeNum: 305419896,
      firmwareVersion: '2.1.0',
      region: 'US'
    };

    expect(mockDeviceInfo).toBeDefined();
    expect(mockDeviceInfo.myNodeNum).toBe(305419896);
    expect(mockDeviceInfo.firmwareVersion).toBe('2.1.0');
  });

  it('should support deviceConfig any type', () => {
    const mockDeviceConfig: any = {
      device: {
        role: 'CLIENT'
      },
      lora: {
        region: 'US'
      }
    };

    expect(mockDeviceConfig).toBeDefined();
    expect(mockDeviceConfig.device.role).toBe('CLIENT');
    expect(mockDeviceConfig.lora.region).toBe('US');
  });

  it('should support currentNodeId string type', () => {
    const nodeId: string = '!12345678';
    const emptyNodeId: string = '';

    expect(nodeId).toBe('!12345678');
    expect(emptyNodeId).toBe('');
  });

  it('should support nodeAddress string type', () => {
    const address: string = '192.168.1.100';
    const loadingAddress: string = 'Loading...';

    expect(address).toBe('192.168.1.100');
    expect(loadingAddress).toBe('Loading...');
  });
});
