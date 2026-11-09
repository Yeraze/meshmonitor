/**
 * @vitest-environment jsdom
 *
 * Export/Import config modals: `protocol="meshcore"` mode (#6257 S4) and the
 * unchanged Meshtastic mode. The global i18n mock returns keys, so we assert on keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../hooks/useResolvedSourceId', () => ({ useResolvedSourceId: () => 'src-default' }));
vi.mock('../common/QrCodeCanvas', () => ({ QrCodeCanvas: ({ value }: { value: string }) => <div data-testid="qr">{value}</div> }));

const api = vi.hoisted(() => ({
  encodeChannelUrl: vi.fn(),
  decodeChannelUrl: vi.fn(),
  importConfig: vi.fn(),
  getAllChannels: vi.fn(),
  get: vi.fn(),
  getConnectionStatus: vi.fn(),
  refreshNodes: vi.fn(),
}));
vi.mock('../../services/api', () => ({ default: api }));

import { ExportConfigModal } from './ExportConfigModal';
import { ImportConfigModal } from './ImportConfigModal';

const SECRET = '00112233445566778899aabbccddeeff';

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
});

describe('ExportConfigModal', () => {
  const mcChannels = [
    { id: 1, name: 'Alpha', psk: 'AAECAwQFBgcICQoLDA0ODw==' },
    { id: 2, name: 'Beta', psk: 'EBESExQVFhcYGRobHB0eHw==' },
    { id: 3, name: 'NoKey', psk: null },
  ];

  it('meshcore: single-select, no LoRa option, encodes one channel for the named source', async () => {
    api.encodeChannelUrl.mockResolvedValue(`meshcore://channel/add?name=Alpha&secret=${SECRET}`);
    render(
      <ExportConfigModal
        isOpen onClose={() => {}} channels={mcChannels} deviceConfig={{ lora: {} }}
        protocol="meshcore" initialChannelId={1} sourceId="mc-src"
      />,
    );
    expect(screen.getByText('export_config.meshcore_title')).toBeTruthy();
    expect(screen.queryByText('export_config.lora_config')).toBeNull();
    // Channels without a secret are not offered (2 of 3 rows).
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios[0].checked).toBe(true);

    await waitFor(() => expect(api.encodeChannelUrl).toHaveBeenCalledWith([1], false, undefined, 'mc-src'));
    expect(await screen.findByTestId('qr')).toBeTruthy();

    fireEvent.click(radios[1]);
    await waitFor(() => expect(api.encodeChannelUrl).toHaveBeenLastCalledWith([2], false, undefined, 'mc-src'));
    expect((screen.getAllByRole('radio') as HTMLInputElement[]).map((r) => r.checked)).toEqual([false, true]);
  });

  it('meshtastic (default): checkboxes, LoRa option, resolved source, LoRa included', async () => {
    api.encodeChannelUrl.mockResolvedValue('https://meshtastic.org/e/#abc');
    render(
      <ExportConfigModal
        isOpen onClose={() => {}} deviceConfig={{ lora: {} }}
        channels={[{ id: 0, name: 'Primary', role: 1, psk: 'x' }, { id: 1, name: 'Two', role: 2, psk: 'y' }]}
      />,
    );
    expect(screen.getByText('export_config.title')).toBeTruthy();
    expect(screen.getByText('export_config.lora_config')).toBeTruthy();
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThanOrEqual(3);
    await waitFor(() => expect(api.encodeChannelUrl).toHaveBeenCalledWith([0, 1], true, undefined, 'src-default'));
  });
});

describe('ImportConfigModal', () => {
  const decodeResult = (target?: unknown) => ({
    protocol: 'meshcore',
    channels: [{ name: 'Beta', secretHex: SECRET, regionScope: 'ost' }],
    ...(target ? { target } : {}),
  });

  async function decode() {
    fireEvent.change(screen.getByPlaceholderText('import_config.meshcore_url_placeholder'), {
      target: { value: `meshcore://channel/add?name=Beta&secret=${SECRET}&region_scope=ost` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'import_config.decode_button' }));
    await screen.findByTestId('meshcore-import-preview');
  }

  it('meshcore: previews name, masked secret, scope and target slot, then imports without polling', async () => {
    api.decodeChannelUrl.mockResolvedValue(decodeResult({ kind: 'new', slot: 3 }));
    api.importConfig.mockResolvedValue({ success: true, protocol: 'meshcore', slot: 3, imported: { channels: 1, channelDetails: [], loraConfig: false } });
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    render(<ImportConfigModal isOpen onClose={onClose} onImportSuccess={onSuccess} protocol="meshcore" sourceId="mc-src" />);
    await decode();

    expect(api.decodeChannelUrl).toHaveBeenCalledWith(expect.stringContaining('meshcore://'), 'mc-src');
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByTestId('meshcore-import-secret').textContent).toBe('00' + '*'.repeat(28) + 'ff');
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByText('ost')).toBeTruthy();
    expect(screen.getByTestId('meshcore-import-target').textContent).toBe('import_config.meshcore_target_new');
    expect(screen.queryByText('import_config.lora_settings')).toBeNull();

    fireEvent.click(screen.getByTestId('meshcore-import-confirm'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.importConfig).toHaveBeenCalledWith(expect.stringContaining('meshcore://'), undefined, 'mc-src');
    // The Meshtastic follow-up (poll / reconnect wait) never runs.
    expect(api.get).not.toHaveBeenCalled();
    expect(api.getConnectionStatus).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'full', maxChannels: 8 }, 'import_config.meshcore_target_full'],
    [{ kind: 'existing', slot: 2 }, 'import_config.meshcore_target_existing'],
  ])('meshcore: blocks the import for %j', async (target, text) => {
    api.decodeChannelUrl.mockResolvedValue(decodeResult(target));
    render(<ImportConfigModal isOpen onClose={() => {}} onImportSuccess={() => {}} protocol="meshcore" sourceId="mc-src" />);
    await decode();
    expect(screen.getByTestId('meshcore-import-target').textContent).toBe(text);
    expect((screen.getByTestId('meshcore-import-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('meshcore: refuses a Meshtastic decode result', async () => {
    api.decodeChannelUrl.mockResolvedValue({ channels: [{ name: 'x', psk: 'y' }] });
    render(<ImportConfigModal isOpen onClose={() => {}} onImportSuccess={() => {}} protocol="meshcore" sourceId="mc-src" />);
    fireEvent.change(screen.getByPlaceholderText('import_config.meshcore_url_placeholder'), { target: { value: 'https://meshtastic.org/e/#x' } });
    fireEvent.click(screen.getByRole('button', { name: 'import_config.decode_button' }));
    await screen.findByText('import_config.error_decode_failed');
    expect(screen.queryByTestId('meshcore-import-preview')).toBeNull();
  });

  it('meshtastic (default): channel + LoRa preview is unchanged', async () => {
    api.decodeChannelUrl.mockResolvedValue({
      channels: [{ name: 'Primary', psk: 'abc' }],
      loraConfig: { modemPreset: 0, region: 1, hopLimit: 3, txPower: 20 },
    });
    render(<ImportConfigModal isOpen onClose={() => {}} onImportSuccess={() => {}} />);
    expect(screen.getByText('import_config.title')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('import_config.url_placeholder'), { target: { value: 'https://meshtastic.org/e/#abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'import_config.decode_button' }));
    await screen.findByText('import_config.lora_settings');
    expect(api.decodeChannelUrl).toHaveBeenCalledWith('https://meshtastic.org/e/#abc', undefined);
    expect(screen.getByRole('button', { name: 'import_config.import_selected' })).toBeTruthy();
    expect(screen.queryByTestId('meshcore-import-preview')).toBeNull();
  });
});
