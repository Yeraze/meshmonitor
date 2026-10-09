/**
 * @vitest-environment jsdom
 *
 * MqttBridgeConfigurationView: the MQTT bridge setup, now a section of the
 * bridge source's Settings page (#5683 follow-up; it was a page of its own).
 *
 * Folding it in must not change what is saved or when:
 *   - it loads with GET /api/sources/:id and saves with PUT /api/sources/:id,
 *     body `{ config }`, the config `buildBridgeConfig` always built;
 *   - nothing is sent on mount, and nothing until the user edits and saves;
 *   - a credential the server masked for a non-admin editor (#5635) is not
 *     blanked by saving the form;
 *   - it is gated on `sources:write`, not on the grant that opened the page;
 *   - it registers with the page's shared save bar as one section.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const { state } = vi.hoisted(() => ({
  state: {
    canWrite: true,
    fetch: null as unknown as ReturnType<typeof import('vitest')['vi']['fn']>,
    saveBar: null as null | {
      id: string;
      sectionName: string;
      hasChanges: boolean;
      isSaving: boolean;
      onSave: () => Promise<void>;
      onDismiss: () => void;
    },
  },
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: (resource: string, action: string) =>
      resource === 'sources' && (action === 'read' || state.canWrite),
  }),
}));
vi.mock('../../hooks/useCsrfFetch', () => {
  // One stable function, as the real hook returns: the section's load effect
  // depends on it, and a new one per render would reload over every edit.
  const csrfFetch = (url: string, init?: RequestInit) => state.fetch(url, init);
  return { useCsrfFetch: () => csrfFetch };
});
vi.mock('../../init', () => ({ appBasename: '' }));
vi.mock('../../hooks/useDashboardData', () => ({ useSourceStatuses: () => new Map() }));
vi.mock('../BBoxMapEditor', () => ({ default: () => <div data-testid="bbox-editor" /> }));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => {
    state.saveBar = options as typeof state.saveBar;
  },
}));

import MqttBridgeConfigurationView, { MQTT_BRIDGE_SETTINGS_SECTION_ID } from './MqttBridgeConfigurationView';
import { buildBridgeConfig, formFromBridgeConfig } from './mqttBridgeConfig';

const SOURCE_ID = 'bridge-1';

/** What an ADMIN gets: the full stored config. */
const STORED_CONFIG = {
  brokerSourceId: 'broker-1',
  upstream: { url: 'mqtt://upstream.example:1883', username: 'bridge-user', password: 'stored-secret' },
  subscriptions: ['msh/US/#'],
  mode: 'subscribe_only',
  // A key this form does not render: a save must carry it through.
  downlinkFilters: { nodes: { allow: ['!abcd1234'] } },
};

/**
 * What a NON-ADMIN EDITOR gets (#5635, sourceConfigRedaction.ts): the secret
 * is left out and named in `maskedConfigFields`.
 */
const MASKED_CONFIG = {
  ...STORED_CONFIG,
  upstream: { url: 'mqtt://upstream.example:1883' },
};
const MASKED_FIELDS = ['upstream.username', 'upstream.password'];

interface Call { method: string; url: string; body: unknown }
let calls: Call[] = [];
const puts = () => calls.filter((call) => call.method === 'PUT');

function installFetch(source: { config: Record<string, unknown>; maskedConfigFields?: string[] }) {
  calls = [];
  state.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const json = (value: unknown) => ({ ok: true, status: 200, json: async () => value });
    if (url === `/api/sources/${SOURCE_ID}`) {
      if (method === 'PUT') {
        // The server answers with what the caller may see of the saved row.
        return json({ id: SOURCE_ID, type: 'mqtt_bridge', ...source, config: { ...source.config, ...(body as { config: object }).config, upstream: source.config.upstream } });
      }
      return json({ id: SOURCE_ID, type: 'mqtt_bridge', ...source });
    }
    if (url === '/api/sources') {
      return json([{ id: 'broker-1', name: 'Local broker', type: 'mqtt_broker' }, { id: SOURCE_ID, name: 'Bridge', type: 'mqtt_bridge' }]);
    }
    return json([]);
  });
}

async function renderSection() {
  render(<MqttBridgeConfigurationView sourceId={SOURCE_ID} />);
  await screen.findByDisplayValue('mqtt://upstream.example:1883');
}

const urlField = () => screen.getByDisplayValue('mqtt://upstream.example:1883') as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: 'Save' });

beforeEach(() => {
  state.canWrite = true;
  state.saveBar = null;
  installFetch({ config: STORED_CONFIG });
});

describe('MQTT bridge setup as a Settings section', () => {
  it('is a headed section under the Settings anchor, and says it configures no device', async () => {
    await renderSection();
    const section = document.getElementById(MQTT_BRIDGE_SETTINGS_SECTION_ID)!;
    expect(section).not.toBeNull();
    expect(section.className).toContain('settings-section');
    expect(screen.getByRole('heading', { level: 3, name: 'MQTT Bridge Configuration' })).toBeInTheDocument();
    expect(screen.getByText(/nothing here is sent to a device/)).toBeInTheDocument();
  });

  it('keeps the anchor while it loads, so a deep link has somewhere to land', () => {
    render(<MqttBridgeConfigurationView sourceId={SOURCE_ID} />);
    expect(document.getElementById(MQTT_BRIDGE_SETTINGS_SECTION_ID)).not.toBeNull();
  });

  it('still offers every part of the old page', async () => {
    await renderSection();
    for (const name of ['Connection', 'Forwarding', 'Subscribe (incoming)', 'Geo filter status', 'Publish (outgoing)', 'Topic rewrites']) {
      expect(screen.getByRole('heading', { name }), name).toBeInTheDocument();
    }
    for (const label of ['Parent broker (optional)', 'Upstream URL', 'Username', 'Password', 'Mode', 'Upstream identity', 'Upstream topics (one per line)']) {
      expect(screen.getByText(label), label).toBeInTheDocument();
    }
  });
});

describe('MQTT bridge setup: what is sent, and when', () => {
  it('loads with GET /api/sources/:id and sends no PUT on mount', async () => {
    await renderSection();
    expect(calls.some((call) => call.method === 'GET' && call.url === `/api/sources/${SOURCE_ID}`)).toBe(true);
    expect(puts()).toEqual([]);
    expect(state.saveBar?.hasChanges).toBe(false);
  });

  it('saves through PUT /api/sources/:id with the body the old page sent', async () => {
    await renderSection();
    fireEvent.change(urlField(), { target: { value: 'mqtt://other.example:1883' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts()).toHaveLength(1));

    const put = puts()[0];
    expect(put.url).toBe(`/api/sources/${SOURCE_ID}`);
    // Exactly what buildBridgeConfig makes of the loaded config plus the edit:
    // the helper is untouched, so this is the pre-move body.
    const form = { ...formFromBridgeConfig(STORED_CONFIG), url: 'mqtt://other.example:1883' };
    const expected = buildBridgeConfig(form, { editing: true, base: STORED_CONFIG }).config;
    expect(put.body).toEqual({ config: JSON.parse(JSON.stringify(expected)) });
    // A config key the form does not render is carried through.
    expect((put.body as { config: Record<string, unknown> }).config.downlinkFilters).toEqual({ nodes: { allow: ['!abcd1234'] } });
  });

  it('an untouched password field sends no password: the server keeps the stored one', async () => {
    await renderSection();
    fireEvent.change(urlField(), { target: { value: 'mqtt://upstream.example:1884' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const upstream = (puts()[0].body as { config: { upstream: Record<string, unknown> } }).config.upstream;
    expect('password' in upstream).toBe(false);
  });

  it('a typed password is sent as typed', async () => {
    await renderSection();
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'new-secret' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect((puts()[0].body as { config: { upstream: { password: string } } }).config.upstream.password).toBe('new-secret');
  });

  it('a form that fails validation sends nothing and says why', async () => {
    await renderSection();
    fireEvent.change(urlField(), { target: { value: '' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText('Upstream URL is required')).toBeInTheDocument();
    expect(puts()).toEqual([]);
  });
});

describe('MQTT bridge setup: a non-admin editor does not blank a masked secret (#5635)', () => {
  beforeEach(() => {
    installFetch({ config: MASKED_CONFIG, maskedConfigFields: MASKED_FIELDS });
  });

  it('never shows the stored secret', async () => {
    await renderSection();
    expect(screen.queryByDisplayValue('stored-secret')).toBeNull();
    expect(screen.queryByDisplayValue('bridge-user')).toBeNull();
    expect((screen.getByPlaceholderText('••••••••') as HTMLInputElement).value).toBe('');
  });

  it('saving an unrelated edit leaves the masked fields out of the body: not "", not null', async () => {
    await renderSection();
    fireEvent.change(screen.getByDisplayValue('msh/US/#'), { target: { value: 'msh/US/FL/#' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts()).toHaveLength(1));

    const config = (puts()[0].body as { config: Record<string, unknown> }).config;
    const upstream = config.upstream as Record<string, unknown>;
    // Missing is the "keep the stored value" signal of mergeSourceConfigOnSave;
    // an empty string or null would clear it.
    expect('password' in upstream).toBe(false);
    expect('username' in upstream).toBe(false);
    expect(upstream).toEqual({ url: 'mqtt://upstream.example:1883' });
    expect(config.subscriptions).toEqual(['msh/US/FL/#']);
    expect(JSON.stringify(puts()[0].body)).not.toContain('stored-secret');
    // And it is the body the old page built from the same masked config.
    const form = { ...formFromBridgeConfig(MASKED_CONFIG), subscriptions: 'msh/US/FL/#' };
    const expected = buildBridgeConfig(form, { editing: true, base: MASKED_CONFIG }).config;
    expect(puts()[0].body).toEqual({ config: JSON.parse(JSON.stringify(expected)) });
  });

  it('saving through the shared save bar sends the same body', async () => {
    await renderSection();
    fireEvent.change(screen.getByDisplayValue('msh/US/#'), { target: { value: 'msh/US/FL/#' } });
    await waitFor(() => expect(state.saveBar?.hasChanges).toBe(true));
    await state.saveBar!.onSave();
    await waitFor(() => expect(puts()).toHaveLength(1));
    const upstream = (puts()[0].body as { config: { upstream: Record<string, unknown> } }).config.upstream;
    expect(upstream).toEqual({ url: 'mqtt://upstream.example:1883' });
  });
});

describe('MQTT bridge setup: one section of the shared save bar', () => {
  it('registers under its own id and name, clean until edited', async () => {
    await renderSection();
    expect(state.saveBar).toMatchObject({
      id: 'mqtt-bridge-settings',
      sectionName: 'MQTT Bridge Configuration',
      hasChanges: false,
      isSaving: false,
    });
  });

  it('an edit makes it dirty; Dismiss puts the loaded value back and sends nothing', async () => {
    await renderSection();
    fireEvent.change(urlField(), { target: { value: 'mqtt://typo.example' } });
    await waitFor(() => expect(state.saveBar?.hasChanges).toBe(true));
    state.saveBar!.onDismiss();
    await waitFor(() => expect(state.saveBar?.hasChanges).toBe(false));
    expect(screen.getByDisplayValue('mqtt://upstream.example:1883')).toBeInTheDocument();
    expect(puts()).toEqual([]);
  });

  it('is clean again after a save', async () => {
    await renderSection();
    fireEvent.change(screen.getByDisplayValue('msh/US/#'), { target: { value: 'msh/EU/#' } });
    await waitFor(() => expect(state.saveBar?.hasChanges).toBe(true));
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts()).toHaveLength(1));
    await waitFor(() => expect(state.saveBar?.hasChanges).toBe(false));
    expect(screen.getByDisplayValue('msh/EU/#')).toBeInTheDocument();
  });

  it('an unsaved edit survives until it is saved or dismissed: a re-render does not reset it', async () => {
    const view = render(<MqttBridgeConfigurationView sourceId={SOURCE_ID} />);
    await screen.findByDisplayValue('mqtt://upstream.example:1883');
    fireEvent.change(urlField(), { target: { value: 'mqtt://draft.example' } });
    view.rerender(<MqttBridgeConfigurationView sourceId={SOURCE_ID} />);
    expect(screen.getByDisplayValue('mqtt://draft.example')).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'GET' && call.url === `/api/sources/${SOURCE_ID}`)).toHaveLength(1);
    expect(puts()).toEqual([]);
  });
});

describe('MQTT bridge setup: gated on sources:write', () => {
  beforeEach(() => {
    state.canWrite = false;
  });

  it('a reader sees the setup with every field and Save disabled, and the reason', async () => {
    await renderSection();
    expect(urlField()).toBeDisabled();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/needs the Sources write permission/);
  });

  it('a reader is never offered a save through the shared bar', async () => {
    await renderSection();
    expect(state.saveBar?.hasChanges).toBe(false);
    expect(puts()).toEqual([]);
  });
});

describe('MQTT bridge setup: broker presets (#5689)', () => {
  const presetSelect = () => screen.getByTestId('broker-preset-select') as HTMLSelectElement;
  const passwordField = () => screen.getByPlaceholderText('••••••••') as HTMLInputElement;

  it('opens on Custom… for a URL that matches no preset, and on the preset for one that does', async () => {
    await renderSection();
    expect(presetSelect().value).toBe('custom');
    fireEvent.change(urlField(), { target: { value: 'mqtts://mqtt.meshtastic.org:8883' } });
    expect(presetSelect().value).toBe('meshtastic_public_tls');
  });

  it('fills the URL with scheme and port, sends nothing, and keeps the typed username', async () => {
    await renderSection();
    fireEvent.change(presetSelect(), { target: { value: 'meshtastic_public_tls' } });
    expect(screen.getByDisplayValue('mqtts://mqtt.meshtastic.org:8883')).toBeInTheDocument();
    expect(screen.getByDisplayValue('bridge-user')).toBeInTheDocument();
    // A password is stored (admin view), so the field stays blank and says why.
    expect(passwordField().value).toBe('');
    expect(screen.getByTestId('broker-preset-kept').textContent).toMatch(/password is saved/);
    // Only the filter and mode fields it does not own are as loaded.
    expect(screen.getByDisplayValue('msh/US/#')).toBeInTheDocument();
    expect(puts()).toHaveLength(0);
    await waitFor(() => expect(state.saveBar?.hasChanges).toBe(true));
  });

  it('fills an empty login when no password is stored, and Save sends it', async () => {
    installFetch({ config: { ...STORED_CONFIG, upstream: { url: 'mqtt://upstream.example:1883' } } });
    await renderSection();
    fireEvent.change(presetSelect(), { target: { value: 'meshtastic_public' } });
    expect(passwordField().value).toBe('large4cats');
    expect(screen.queryByTestId('broker-preset-kept')).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const upstream = (puts()[0].body as { config: { upstream: unknown } }).config.upstream;
    expect(upstream).toEqual({ url: 'mqtt://mqtt.meshtastic.org:1883', username: 'meshdev', password: 'large4cats' });
  });

  it('a non-admin editor: the preset neither blanks nor replaces the masked secret', async () => {
    installFetch({ config: MASKED_CONFIG, maskedConfigFields: MASKED_FIELDS });
    await renderSection();
    fireEvent.change(presetSelect(), { target: { value: 'meshtastic_public' } });
    expect(passwordField().value).toBe('');
    expect(screen.getByTestId('broker-preset-kept')).toBeInTheDocument();
    expect(puts()).toHaveLength(0);

    fireEvent.click(saveButton());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const upstream = (puts()[0].body as { config: { upstream: Record<string, unknown> } }).config.upstream;
    // Missing, not '' or null or the preset's password: the server's merge
    // decides about the stored secret, exactly as for a hand-typed URL.
    expect('password' in upstream).toBe(false);
    expect('username' in upstream).toBe(false);
    expect(upstream).toEqual({ url: 'mqtt://mqtt.meshtastic.org:1883' });
  });

  it('Custom… leaves the URL as typed', async () => {
    await renderSection();
    fireEvent.change(presetSelect(), { target: { value: 'custom' } });
    expect(urlField().value).toBe('mqtt://upstream.example:1883');
    expect(puts()).toHaveLength(0);
  });

  it('a reader cannot pick a preset', async () => {
    state.canWrite = false;
    await renderSection();
    expect(presetSelect().disabled).toBe(true);
  });
});
