/**
 * @vitest-environment jsdom
 *
 * Remote admin number fields (#5649).
 *
 * Every Save in this tab sends an admin packet to a node over the mesh. The
 * fields are now `NumberInput`s: they can be cleared, and while one is blank
 * or under its minimum its own Save is off and nothing is sent. A blank field
 * used to be sent as NaN or swapped for 0 / a default; a below-minimum interval
 * used to be raised silently at save time.
 *
 * Nothing here reaches a radio: `apiService` is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const h = vi.hoisted(() => ({
  showToast: vi.fn(),
  apiPost: vi.fn(),
  apiSendAdminCommand: vi.fn(),
}));

// `t` must keep one identity across renders (see AdminCommandsTab.txDisabled.test.tsx).
vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: string | Record<string, unknown>) => (typeof fallback === 'string' ? fallback : key);
  return { useTranslation: () => ({ t }) };
});
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock('../hooks/useResolvedSourceId', () => ({ useResolvedSourceId: () => 'source-1' }));
vi.mock('../hooks/useTxStatus', () => ({ useTxStatus: () => ({ isTxDisabled: false }) }));
vi.mock('../services/api', () => ({
  default: {
    setBaseUrl: vi.fn(),
    post: h.apiPost,
    sendAdminCommand: h.apiSendAdminCommand,
    exportChannel: vi.fn(),
    importChannel: vi.fn(),
    getAllChannels: vi.fn().mockResolvedValue([]),
    ensureSessionPasskey: vi.fn().mockResolvedValue({ success: true, hasPasskey: true, remainingSeconds: 300 }),
  },
}));
vi.mock('./SectionNav', () => ({ default: () => null }));
vi.mock('./configuration/ImportConfigModal', () => ({ ImportConfigModal: () => null }));
vi.mock('./configuration/ExportConfigModal', () => ({ ExportConfigModal: () => null }));
vi.mock('./admin-commands/AutoFavoriteManagementSection', () => ({ default: () => null }));

import AdminCommandsTab from './AdminCommandsTab';

const LOCAL_NODE_ID = '!00000064';
const localNode = { nodeNum: 100, user: { id: LOCAL_NODE_ID, longName: 'Local Node', shortName: 'LOC1' } };

const SECTION_IDS = [
  'radio-config', 'device-config', 'module-config',
  'admin-device-config', 'admin-lora-config', 'admin-position-config', 'admin-telemetry-config',
  'admin-reboot-purge',
];

function renderTab() {
  const expanded: Record<string, boolean> = {};
  for (const id of SECTION_IDS) expanded[id] = true;
  localStorage.setItem('adminCommandsExpandedSections', JSON.stringify(expanded));
  render(<AdminCommandsTab nodes={[localNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);
}

function section(id: string): HTMLElement {
  const el = document.getElementById(id);
  expect(el, `${id} is rendered`).not.toBeNull();
  return el as HTMLElement;
}

const saveButton = (id: string, name: string) =>
  within(section(id)).getByRole('button', { name }) as HTMLButtonElement;

/** The number field holding `value` in a section. */
const field = (id: string, value: string) =>
  within(section(id)).getByDisplayValue(value) as HTMLInputElement;

/** The device-metrics interval only shows once device telemetry is switched on. */
function telemetryDeviceInterval(): HTMLInputElement {
  const telemetry = within(section('admin-telemetry-config'));
  fireEvent.click(telemetry.getAllByRole('checkbox')[0]);
  return telemetry.getAllByRole('spinbutton')[0] as HTMLInputElement;
}

const sentCommands = () => h.apiSendAdminCommand.mock.calls.map(([body]) => body as { command: string; config?: Record<string, unknown> });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.apiPost.mockResolvedValue({});
  h.apiSendAdminCommand.mockResolvedValue({ success: true, message: 'ok' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('AdminCommandsTab number fields (#5649)', () => {
  it('lets the position interval be cleared, and blocks Save while it is blank', async () => {
    renderTab();
    const interval = field('admin-position-config', '900');
    const save = () => saveButton('admin-position-config', 'admin_commands.save_position_config');
    expect(save()).not.toBeDisabled();

    fireEvent.change(interval, { target: { value: '' } });

    // The field stays blank: nothing puts 900 (or NaN, or 0) back.
    expect(interval.value).toBe('');
    expect(interval).toHaveAttribute('aria-invalid', 'true');
    expect(save()).toBeDisabled();
    fireEvent.click(save());
    expect(h.apiSendAdminCommand).not.toHaveBeenCalled();

    fireEvent.change(interval, { target: { value: '600' } });
    expect(interval).not.toHaveAttribute('aria-invalid');
    expect(save()).not.toBeDisabled();
    fireEvent.click(save());

    await waitFor(() => expect(h.apiSendAdminCommand).toHaveBeenCalledTimes(1));
    const [sent] = sentCommands();
    expect(sent.command).toBe('setPositionConfig');
    expect(sent.config?.positionBroadcastSecs).toBe(600);
    expect(Number.isInteger(sent.config?.positionBroadcastSecs)).toBe(true);
  });

  it('never sends a position interval under the 32 s floor, and never swaps it for 0', async () => {
    renderTab();
    const interval = field('admin-position-config', '900');
    const save = () => saveButton('admin-position-config', 'admin_commands.save_position_config');

    fireEvent.change(interval, { target: { value: '5' } });

    // Outlined as typed, not clamped on the keystroke.
    expect(interval.value).toBe('5');
    expect(interval).toHaveAttribute('aria-invalid', 'true');
    expect(save()).toBeDisabled();
    fireEvent.click(save());
    expect(h.apiSendAdminCommand).not.toHaveBeenCalled();

    // 0 is what a node reports for "firmware default", so a loaded 0 is not
    // red. It still never goes out: the save handler raises it to the floor,
    // as it did before #5649.
    fireEvent.change(interval, { target: { value: '0' } });
    expect(interval).not.toHaveAttribute('aria-invalid');
    expect(save()).not.toBeDisabled();
    fireEvent.click(save());
    await waitFor(() => expect(h.apiSendAdminCommand).toHaveBeenCalledTimes(1));
    const [sent] = sentCommands();
    expect(sent.config?.positionBroadcastSecs).toBe(32);
  });

  it('never sends a node-info interval under the 3600 s floor', async () => {
    renderTab();
    const interval = field('admin-device-config', '3600');
    const save = () => saveButton('admin-device-config', 'admin_commands.save_device_config');

    fireEvent.change(interval, { target: { value: '60' } });
    expect(interval).toHaveAttribute('aria-invalid', 'true');
    expect(save()).toBeDisabled();
    fireEvent.click(save());
    expect(h.apiSendAdminCommand).not.toHaveBeenCalled();

    fireEvent.change(interval, { target: { value: '7200' } });
    expect(save()).not.toBeDisabled();
    fireEvent.click(save());
    await waitFor(() => expect(h.apiSendAdminCommand).toHaveBeenCalledTimes(1));
    const [sent] = sentCommands();
    expect(sent.command).toBe('setDeviceConfig');
    expect(sent.config?.nodeInfoBroadcastSecs).toBe(7200);
  });

  it('rejects a decimal in an integer field', () => {
    renderTab();
    const interval = field('admin-position-config', '900');
    fireEvent.change(interval, { target: { value: '60.5' } });
    expect(interval).toHaveAttribute('aria-invalid', 'true');
    expect(saveButton('admin-position-config', 'admin_commands.save_position_config')).toBeDisabled();
  });

  it('blocks only the group that holds the invalid field', () => {
    renderTab();
    fireEvent.change(telemetryDeviceInterval(), { target: { value: '' } });

    expect(saveButton('admin-telemetry-config', 'Save Telemetry Config')).toBeDisabled();
    // Position and Device are separate admin writes: they stay available.
    expect(saveButton('admin-position-config', 'admin_commands.save_position_config')).not.toBeDisabled();
    expect(saveButton('admin-device-config', 'admin_commands.save_device_config')).not.toBeDisabled();
  });

  it('sends a telemetry interval as an integer once the field is fixed', async () => {
    renderTab();
    const deviceInterval = telemetryDeviceInterval();
    const save = () => saveButton('admin-telemetry-config', 'Save Telemetry Config');

    fireEvent.change(deviceInterval, { target: { value: '' } });
    fireEvent.click(save());
    expect(h.apiSendAdminCommand).not.toHaveBeenCalled();

    fireEvent.change(deviceInterval, { target: { value: '1800' } });
    fireEvent.click(save());
    await waitFor(() => expect(h.apiSendAdminCommand).toHaveBeenCalledTimes(1));
    const [sent] = sentCommands();
    expect(sent.command).toBe('setTelemetryConfig');
    expect(sent.config?.deviceUpdateInterval).toBe(1800);
  });

  it('blocks Reboot while the delay is blank or out of range', () => {
    renderTab();
    const rebootButton = screen.getByRole('button', { name: /admin_commands\.reboot_device/ }) as HTMLButtonElement;
    const delay = rebootButton.parentElement!.querySelector('input[type="number"]') as HTMLInputElement;
    expect(delay.value).toBe('5');
    expect(rebootButton).not.toBeDisabled();

    fireEvent.change(delay, { target: { value: '' } });
    expect(rebootButton).toBeDisabled();
    fireEvent.click(rebootButton);
    expect(h.apiSendAdminCommand).not.toHaveBeenCalled();

    fireEvent.change(delay, { target: { value: '120' } });
    expect(rebootButton).toBeDisabled();

    fireEvent.change(delay, { target: { value: '10' } });
    expect(rebootButton).not.toBeDisabled();
  });

  it('treats the retry-attempts override as optional, and ignores it while out of range', async () => {
    renderTab();
    const override = document.getElementById('adminRetryAttemptsOverride') as HTMLInputElement;
    expect(override.value).toBe('');
    // Blank is the legal "use the configured default".
    expect(override).not.toHaveAttribute('aria-invalid');

    fireEvent.change(override, { target: { value: '50' } });
    expect(override.value).toBe('50');
    expect(override).toHaveAttribute('aria-invalid', 'true');

    fireEvent.click(saveButton('admin-position-config', 'admin_commands.save_position_config'));
    await waitFor(() => expect(h.apiSendAdminCommand).toHaveBeenCalledTimes(1));
    expect(h.apiSendAdminCommand.mock.calls[0][0]).not.toHaveProperty('retryAttempts');

    // The field is disabled while a command runs; wait for it to come back.
    await waitFor(() => expect(override).not.toBeDisabled());
    fireEvent.change(override, { target: { value: '4' } });
    expect(override).not.toHaveAttribute('aria-invalid');
    fireEvent.click(saveButton('admin-position-config', 'admin_commands.save_position_config'));
    await waitFor(() => expect(h.apiSendAdminCommand).toHaveBeenCalledTimes(2));
    expect(h.apiSendAdminCommand.mock.calls[1][0]).toMatchObject({ retryAttempts: 4 });
  });
});

// A node reports 0 for "not set". The field accepts it and says what a save
// sends; the handler's floor is what makes that sentence true.
describe('AdminCommandsTab: a 0 in a firmware-default field', () => {
  it('explains a 0 hop limit and sends the 1 the hint promises', async () => {
    renderTab();
    const hopLimit = field('admin-lora-config', '3');
    const lora = within(section('admin-lora-config'));
    expect(lora.queryByText('zero_hint.hop_limit')).toBeNull();

    fireEvent.change(hopLimit, { target: { value: '0' } });

    expect(lora.getByText('zero_hint.hop_limit')).toBeInTheDocument();
    expect(hopLimit).toHaveAccessibleDescription('zero_hint.hop_limit');
    expect(hopLimit).not.toHaveAttribute('aria-invalid');
    const save = saveButton('admin-lora-config', 'admin_commands.save_lora_config');
    expect(save).not.toBeDisabled();

    fireEvent.click(save);
    await waitFor(() => expect(sentCommands().some(c => c.command === 'setLoRaConfig')).toBe(true));
    expect(sentCommands().find(c => c.command === 'setLoRaConfig')!.config!.hopLimit).toBe(1);

    fireEvent.change(hopLimit, { target: { value: '4' } });
    expect(lora.queryByText('zero_hint.hop_limit')).toBeNull();
  });

  it('explains a 0 position interval and sends the 32 seconds the hint promises', async () => {
    renderTab();
    const interval = field('admin-position-config', '900');
    const position = within(section('admin-position-config'));

    fireEvent.change(interval, { target: { value: '0' } });

    expect(position.getByText('zero_hint.position_broadcast')).toBeInTheDocument();
    fireEvent.click(saveButton('admin-position-config', 'admin_commands.save_position_config'));
    await waitFor(() => expect(sentCommands().some(c => c.command === 'setPositionConfig')).toBe(true));
    expect(sentCommands().find(c => c.command === 'setPositionConfig')!.config!.positionBroadcastSecs).toBe(32);
  });
});
