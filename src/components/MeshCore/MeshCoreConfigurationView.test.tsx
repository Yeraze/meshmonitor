/**
 * @vitest-environment jsdom
 *
 * Tests for the telemetry section of MeshCoreConfigurationView. The setup file
 * mocks react-i18next so `t(key, fallback)` returns the key, which is what
 * the tests query against.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Auth: default to write-permitted; individual tests can override before
// rendering by reassigning `authPermission`.
let authPermission: (resource: string, action: string) => boolean = () => true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (r: string, a: string) => authPermission(r, a) }),
}));

import { MeshCoreConfigurationView } from './MeshCoreConfigurationView';
import type { ConnectionStatus, MeshCoreActions } from './hooks/useMeshCore';

function makeActions(overrides: Partial<MeshCoreActions> = {}): MeshCoreActions {
  return {
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    refreshContacts: vi.fn().mockResolvedValue(undefined),
    sendAdvert: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(true),
    setDeviceName: vi.fn().mockResolvedValue(true),
    setRadioParams: vi.fn().mockResolvedValue(true),
    setCoords: vi.fn().mockResolvedValue(true),
    setAdvertLocPolicy: vi.fn().mockResolvedValue(true),
    setTelemetryModeBase: vi.fn().mockResolvedValue(true),
    setTelemetryModeLoc: vi.fn().mockResolvedValue(true),
    setTelemetryModeEnv: vi.fn().mockResolvedValue(true),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(),
    ...overrides,
  };
}

function makeStatus(
  overrides: Partial<NonNullable<ConnectionStatus['localNode']>> & { advType?: number } = {},
  { connected = true } = {},
): ConnectionStatus {
  return {
    connected,
    deviceType: overrides.advType ?? 1,
    deviceTypeName: 'companion',
    config: null,
    localNode: {
      publicKey: 'pk',
      name: 'test',
      advType: overrides.advType ?? 1,
      telemetryModeBase: 'always',
      telemetryModeLoc: 'device',
      telemetryModeEnv: 'never',
      ...overrides,
    },
  };
}

describe('MeshCoreConfigurationView telemetry section', () => {
  it('renders three telemetry selects with mode options', () => {
    render(<MeshCoreConfigurationView status={makeStatus()} actions={makeActions()} />);

    const base = screen.getByLabelText('meshcore.config.telemetry_base') as HTMLSelectElement;
    const loc = screen.getByLabelText('meshcore.config.telemetry_loc') as HTMLSelectElement;
    const env = screen.getByLabelText('meshcore.config.telemetry_env') as HTMLSelectElement;

    expect(base.value).toBe('always');
    expect(loc.value).toBe('device');
    expect(env.value).toBe('never');

    // Every select should offer the same three options
    for (const sel of [base, loc, env]) {
      const values = Array.from(sel.options).map(o => o.value);
      expect(values).toEqual(['always', 'device', 'never']);
    }
  });

  it('save button calls all three telemetry actions in parallel with the current selections', async () => {
    const actions = makeActions();
    render(<MeshCoreConfigurationView status={makeStatus()} actions={actions} />);

    fireEvent.change(screen.getByLabelText('meshcore.config.telemetry_base'), {
      target: { value: 'device' },
    });
    fireEvent.change(screen.getByLabelText('meshcore.config.telemetry_loc'), {
      target: { value: 'never' },
    });
    fireEvent.change(screen.getByLabelText('meshcore.config.telemetry_env'), {
      target: { value: 'always' },
    });

    fireEvent.click(screen.getByText('meshcore.config.save_telemetry'));

    await waitFor(() => {
      expect(actions.setTelemetryModeBase).toHaveBeenCalledWith('device');
      expect(actions.setTelemetryModeLoc).toHaveBeenCalledWith('never');
      expect(actions.setTelemetryModeEnv).toHaveBeenCalledWith('always');
    });
  });

  it('disables the section when disconnected', () => {
    render(
      <MeshCoreConfigurationView
        status={makeStatus({}, { connected: false })}
        actions={makeActions()}
      />,
    );
    expect(screen.getByLabelText('meshcore.config.telemetry_base')).toBeDisabled();
    expect(screen.getByLabelText('meshcore.config.telemetry_loc')).toBeDisabled();
    expect(screen.getByLabelText('meshcore.config.telemetry_env')).toBeDisabled();
    expect(screen.getByText('meshcore.config.save_telemetry')).toBeDisabled();
  });

  it('disables the section and shows the companion-only hint on a repeater', () => {
    render(
      <MeshCoreConfigurationView
        status={makeStatus({ advType: 2 })}
        actions={makeActions()}
      />,
    );
    expect(screen.getByLabelText('meshcore.config.telemetry_base')).toBeDisabled();
    expect(screen.getByText('meshcore.config.telemetry_companion_only')).toBeDefined();
  });

  it('disables the section on a room server (advType=3)', () => {
    render(
      <MeshCoreConfigurationView
        status={makeStatus({ advType: 3 })}
        actions={makeActions()}
      />,
    );
    expect(screen.getByLabelText('meshcore.config.telemetry_base')).toBeDisabled();
  });
});

describe('MeshCoreConfigurationView permission gating', () => {
  it('disables every save control and surfaces a hint when configuration:write is denied', () => {
    authPermission = (_resource, action) => action !== 'write';
    try {
      render(<MeshCoreConfigurationView status={makeStatus()} actions={makeActions()} />);

      // Permission-denied hint is visible. (i18n mocked to return the key.)
      expect(screen.getByText('meshcore.config.permission_denied')).toBeDefined();

      // All four save buttons disabled.
      expect(screen.getByText('meshcore.config.save_name')).toBeDisabled();
      expect(screen.getByText('meshcore.config.save_location')).toBeDisabled();
      expect(screen.getByText('meshcore.config.save_radio')).toBeDisabled();
      expect(screen.getByText('meshcore.config.save_telemetry')).toBeDisabled();
    } finally {
      authPermission = () => true;
    }
  });
});

describe('MeshCoreConfigurationView radio preset picker (#5137)', () => {
  it('offers the Philadelphia preset and applies its parameters when chosen', () => {
    render(<MeshCoreConfigurationView status={makeStatus()} actions={makeActions()} />);

    const picker = screen.getByLabelText('meshcore.config.preset') as HTMLSelectElement;
    expect(Array.from(picker.options).map(o => o.value)).toContain('us-philly');

    fireEvent.change(picker, { target: { value: 'us-philly' } });

    // 500 kHz is the whole point — it is what makes the preset FCC-compliant,
    // and the only entry in the table that uses it.
    expect(screen.getByLabelText('meshcore.config.frequency')).toHaveValue(902.25);
    expect(screen.getByLabelText('meshcore.config.bandwidth')).toHaveValue('500');
    expect(screen.getByLabelText('meshcore.config.sf')).toHaveValue('11');
    expect(screen.getByLabelText('meshcore.config.cr')).toHaveValue('5');
  });

  it('shows the path-hash note only while the Philadelphia preset is resolved', () => {
    render(<MeshCoreConfigurationView status={makeStatus()} actions={makeActions()} />);

    expect(screen.queryByTestId('mc-cfg-preset-note')).toBeNull();

    fireEvent.change(screen.getByLabelText('meshcore.config.preset'), {
      target: { value: 'us-philly' },
    });
    expect(screen.getByTestId('mc-cfg-preset-note').textContent).toMatch(/path hash/i);

    // A preset with nothing extra to say must not leave the note behind.
    fireEvent.change(screen.getByLabelText('meshcore.config.preset'), {
      target: { value: 'us-ca' },
    });
    expect(screen.queryByTestId('mc-cfg-preset-note')).toBeNull();
  });

  it('shows the note for a node that already arrived on the Philadelphia parameters', () => {
    // Keyed off the resolved preset, not the last click — a node flashed
    // elsewhere and then connected here still needs to see the requirement.
    render(
      <MeshCoreConfigurationView
        status={makeStatus({ radioFreq: 902.25, radioBw: 500, radioSf: 11, radioCr: 5 })}
        actions={makeActions()}
      />,
    );

    expect(
      (screen.getByLabelText('meshcore.config.preset') as HTMLSelectElement).value,
    ).toBe('us-philly');
    expect(screen.getByTestId('mc-cfg-preset-note').textContent).toMatch(/path hash/i);
  });
});
