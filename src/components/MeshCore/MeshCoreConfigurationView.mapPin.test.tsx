/**
 * @vitest-environment jsdom
 *
 * MeshCore Location map pin: the Location section shows a map; a dropped pin
 * fills the latitude/longitude fields, and Save location sends those values
 * through setCoords. Nothing is sent until Save is pressed.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

let authPermission: (resource: string, action: string) => boolean = () => true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (r: string, a: string) => authPermission(r, a) }),
}));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

let pickerProps: { lat: number | null; lon: number | null; onChange: (lat: number, lon: number) => void; disabled?: boolean; decimals?: number } | null = null;
vi.mock('../map/LocationPinPicker', () => ({
  LocationPinPicker: (props: any) => {
    pickerProps = props;
    return <div data-testid={props.testId} />;
  },
}));

import { MeshCoreConfigurationView } from './MeshCoreConfigurationView';
import type { ConnectionStatus, MeshCoreActions } from './hooks/useMeshCore';

function makeActions(overrides: Partial<MeshCoreActions> = {}): MeshCoreActions {
  const ok = () => vi.fn().mockResolvedValue(true);
  return {
    connect: ok(), disconnect: vi.fn().mockResolvedValue(undefined), refreshContacts: vi.fn().mockResolvedValue(undefined),
    sendAdvert: vi.fn().mockResolvedValue(undefined), sendMessage: ok(), setDeviceName: ok(), setRadioParams: ok(),
    setCoords: ok(), setAdvertLocPolicy: ok(), setTelemetryModeBase: ok(), setTelemetryModeLoc: ok(),
    setTelemetryModeEnv: ok(), refreshAll: vi.fn().mockResolvedValue(undefined), clearError: vi.fn(),
    getDefaultPathHashSize: vi.fn().mockResolvedValue(1), setDefaultPathHashSize: vi.fn().mockResolvedValue(1),
    getDefaultScope: vi.fn().mockResolvedValue(''), setDefaultScope: vi.fn().mockResolvedValue(''),
    discoverRegions: vi.fn().mockResolvedValue(null), discoverNodes: vi.fn().mockResolvedValue(null),
    fetchSavedRegions: vi.fn().mockResolvedValue([]), addSavedRegion: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeStatus(connected = true): ConnectionStatus {
  return {
    connected,
    deviceType: 1,
    deviceTypeName: 'companion',
    config: null,
    localNode: {
      publicKey: 'pk', name: 'test', advType: 1, latitude: 26.1, longitude: -80.1,
      telemetryModeBase: 'always', telemetryModeLoc: 'device', telemetryModeEnv: 'never',
    },
  } as ConnectionStatus;
}

describe('MeshCoreConfigurationView location map pin', () => {
  it('shows the map at the node\'s current coordinates, with MeshCore precision', () => {
    render(<MeshCoreConfigurationView status={makeStatus()} actions={makeActions()} />);
    expect(screen.getByTestId('meshcore-location-map')).toBeTruthy();
    expect(pickerProps?.lat).toBe(26.1);
    expect(pickerProps?.lon).toBe(-80.1);
    expect(pickerProps?.decimals).toBe(6);
    expect(pickerProps?.disabled).toBe(false);
  });

  it('a dropped pin fills the fields and Save location sends it', async () => {
    const actions = makeActions();
    render(<MeshCoreConfigurationView status={makeStatus()} actions={actions} />);
    React.act(() => pickerProps!.onChange(35.084386, -106.650422));
    expect((screen.getByLabelText('meshcore.config.latitude') as HTMLInputElement).value).toBe('35.084386');
    expect((screen.getByLabelText('meshcore.config.longitude') as HTMLInputElement).value).toBe('-106.650422');
    expect(actions.setCoords).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('meshcore.config.save_location'));
    await waitFor(() => expect(actions.setCoords).toHaveBeenCalledWith(35.084386, -106.650422));
  });

  it('locks the map when disconnected or without write access', () => {
    render(<MeshCoreConfigurationView status={makeStatus(false)} actions={makeActions()} />);
    expect(pickerProps?.disabled).toBe(true);
    authPermission = (_r, a) => a !== 'write';
    try {
      render(<MeshCoreConfigurationView status={makeStatus()} actions={makeActions()} />);
      expect(pickerProps?.disabled).toBe(true);
    } finally {
      authPermission = () => true;
    }
  });
});
