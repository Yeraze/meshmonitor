/**
 * @vitest-environment jsdom
 *
 * #5677: when the selected source's node has hardware MeshMonitor cannot
 * update (meshtasticd / PORTDUINO, a simulator, an unmapped or non-OTA
 * board), the pane shows an explanatory card in place of the update UI. The
 * card follows the CURRENT source, never flashes while a normal node's
 * metadata loads, and never starts, schedules or checks for an update.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

interface PollFixture {
  connection: { connected: boolean; nodeResponsive: boolean };
  config: Record<string, unknown>;
  nodes: unknown[];
}

const NODE_ID = '!9ea3e00c';

/** A connected Meshtastic TCP source whose own node reports `hwModel`. */
function tcpSource(hwModel: number | null | undefined, firmwareVersion = '2.7.26.abcdef0'): PollFixture {
  return {
    connection: { connected: true, nodeResponsive: true },
    config: {
      // /api/poll sends nodeId but no nodeNum; the pane matches the row by id.
      localNodeInfo: { nodeId: NODE_ID },
      meshtasticNodeIp: '10.0.0.2',
      meshtasticTcpPort: 4403,
      meshtasticSourceType: 'meshtastic_tcp',
      deviceMetadata: firmwareVersion ? { firmwareVersion } : {},
    },
    nodes: hwModel === undefined ? [] : [{ nodeNum: 123, user: { id: NODE_ID, hwModel } }],
  };
}

const h = vi.hoisted(() => ({
  sourceId: 'src-a' as string | null,
  poll: {} as Record<string, unknown>,
  status: { state: 'idle', step: null, message: '', logs: [] } as Record<string, unknown>,
  csrfFetch: vi.fn(),
}));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    const key = JSON.stringify(opts.queryKey);
    if (key === JSON.stringify(['firmware', 'status']))
      return { data: { success: true, status: h.status, channel: 'stable', customUrl: '', lastChecked: null } };
    if (key === JSON.stringify(['firmware', 'releases']))
      return {
        data: {
          success: true,
          channel: 'stable',
          releases: [
            { tagName: 'v2.7.27', version: '2.7.27', prerelease: false, publishedAt: '2026-09-01', htmlUrl: '', assets: [] },
          ],
        },
      };
    if (key === JSON.stringify(['firmware', 'backups'])) return { data: { success: true, backups: [] } };
    return { data: undefined };
  },
  useQueryClient: () => ({
    getQueryData: () => undefined,
    invalidateQueries: vi.fn(),
    removeQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));

vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => h.csrfFetch }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
// The real usePoll scopes /api/poll by the selected source; so does this one.
vi.mock('../../hooks/usePoll', () => ({ usePoll: () => ({ data: h.poll[h.sourceId ?? 'legacy'] }) }));
vi.mock('../../contexts/DataContext', () => ({ useData: () => ({ setConnectionStatus: vi.fn() }) }));
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: h.sourceId, sourceName: 'Source' }),
}));

import FirmwareUpdateSection from './FirmwareUpdateSection';
import { MESHTASTICD_DOCS_URL } from '../../utils/firmwareHardwareMap';

const card = () => screen.queryByTestId('firmware-unsupported-card');

/** The update UI: channel picker, release check and the per-release Install. */
function expectUpdateUi(present: boolean) {
  const check = present ? (el: unknown) => expect(el).not.toBeNull() : (el: unknown) => expect(el).toBeNull();
  check(document.getElementById('firmware-channel'));
  check(screen.queryByText('Check Now'));
  check(screen.queryByText('Install'));
}

function setSource(id: string, fixture: PollFixture) {
  h.sourceId = id;
  h.poll = { ...h.poll, [id]: fixture };
}

beforeEach(() => {
  h.csrfFetch.mockReset();
  h.csrfFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
  h.poll = {};
  h.sourceId = 'src-a';
  h.status = { state: 'idle', step: null, message: '', logs: [] };
});

describe('FirmwareUpdateSection — hardware that cannot be updated (#5677)', () => {
  it('PORTDUINO (meshtasticd): card with package-manager guidance and the official docs link', () => {
    setSource('src-a', tcpSource(37));
    render(<FirmwareUpdateSection baseUrl="" />);

    const el = card()!;
    expect(el.getAttribute('data-reason')).toBe('linux-native');
    expect(el.textContent).toContain('This node is updated on its Linux host');
    expect(el.textContent).toContain(
      'Update the meshtasticd package with your system package manager, or pull a newer container image.',
    );
    const link = el.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(MESHTASTICD_DOCS_URL);
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');

    expectUpdateUi(false);
    // The pane itself, and its config backups, stay where they were.
    expect(screen.getByText('Firmware Updates')).toBeTruthy();
    expect(screen.getByText('Configuration Backups')).toBeTruthy();
  });

  it('the card offers nothing that starts, checks for or saves an update', () => {
    setSource('src-a', tcpSource(37));
    const { container } = render(<FirmwareUpdateSection baseUrl="" />);

    expect(card()!.querySelectorAll('button, input, select')).toHaveLength(0);
    for (const button of Array.from(container.querySelectorAll('button'))) fireEvent.click(button);
    expect(h.csrfFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['UNSET, once the node has finished reporting', 0, 'unset', 'This node reports no hardware model', true],
    ['ANDROID_SIM', 38, 'simulator', 'This node is a simulator', false],
    ['a model number with no name', 200, 'unknown-model', 'MeshMonitor does not know hardware model 200', true],
    ['PRIVATE_HW (no build mapped)', 255, 'unmapped-board', 'No firmware build is mapped for PRIVATE_HW', true],
    ['RAK4631 (nRF52840)', 9, 'platform-not-ota', 'RAK4631 cannot be updated over Wi-Fi', true],
  ])('%s: its own card', (_label, hwModel, reason, title, hasFlasherLink) => {
    setSource('src-a', tcpSource(hwModel));
    render(<FirmwareUpdateSection baseUrl="" />);

    const el = card()!;
    expect(el.getAttribute('data-reason')).toBe(reason);
    expect(el.textContent).toContain(title);
    expect(el.querySelector('a')?.getAttribute('href') ?? null).toBe(
      hasFlasherLink ? 'https://flasher.meshtastic.org/' : null,
    );
    expectUpdateUi(false);
  });

  it('names the platform on the non-OTA card', () => {
    setSource('src-a', tcpSource(9));
    render(<FirmwareUpdateSection baseUrl="" />);
    expect(card()!.textContent).toContain('Its platform (nrf52840) has no Wi-Fi OTA update');
  });

  it('a supported board keeps the normal update UI, and Install sends its model', async () => {
    setSource('src-a', tcpSource(43));
    render(<FirmwareUpdateSection baseUrl="" />);

    expect(card()).toBeNull();
    expectUpdateUi(true);
    const install = screen.getByText('Install') as HTMLButtonElement;
    expect(install.disabled).toBe(false);

    fireEvent.click(install);
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
    const [url, init] = h.csrfFetch.mock.calls[0];
    expect(String(url)).toContain('/api/firmware/update');
    expect(JSON.parse(init.body as string)).toMatchObject({ hwModel: 43, sourceId: 'src-a' });
  });

  it('an ambiguous model keeps the update UI: a custom URL or upload still works (#5423)', () => {
    setSource('src-a', tcpSource(39)); // DIY_V1
    render(<FirmwareUpdateSection baseUrl="" />);
    expect(card()).toBeNull();
    expectUpdateUi(true);
  });
});

describe('FirmwareUpdateSection — the card waits for a settled model (#5677)', () => {
  it('hw model 0 before DeviceMetadata arrives is "not known yet", not UNSET', () => {
    // First connect: the local node row is stored with hw model 0 until the
    // node's own NodeInfo arrives, which firmware sends before DeviceMetadata.
    setSource('src-a', tcpSource(0, ''));
    const { rerender } = render(<FirmwareUpdateSection baseUrl="" />);
    expect(card()).toBeNull();
    expectUpdateUi(true);

    // NodeInfo, then DeviceMetadata, land: a normal Heltec V3. No card at any point.
    setSource('src-a', tcpSource(43, ''));
    rerender(<FirmwareUpdateSection baseUrl="" />);
    expect(card()).toBeNull();

    setSource('src-a', tcpSource(43));
    rerender(<FirmwareUpdateSection baseUrl="" />);
    expect(card()).toBeNull();
    expectUpdateUi(true);
  });

  it('a meshtasticd node shows the card as soon as its model is known', () => {
    setSource('src-a', tcpSource(0, ''));
    const { rerender } = render(<FirmwareUpdateSection baseUrl="" />);
    expect(card()).toBeNull();

    setSource('src-a', tcpSource(37, ''));
    rerender(<FirmwareUpdateSection baseUrl="" />);
    expect(card()!.getAttribute('data-reason')).toBe('linux-native');
  });

  it.each([
    ['no poll data yet', undefined],
    ['the local node row is missing', tcpSource(undefined)],
    ['the row has a null model', tcpSource(null)],
  ])('%s: no card', (_label, fixture) => {
    h.sourceId = 'src-a';
    h.poll = fixture ? { 'src-a': fixture } : {};
    render(<FirmwareUpdateSection baseUrl="" />);
    expect(card()).toBeNull();
    expectUpdateUi(true);
  });
});

describe('FirmwareUpdateSection — the card follows the selected source (#5677)', () => {
  it('swaps card and update UI when the source changes', () => {
    setSource('src-b', tcpSource(43));
    setSource('src-a', tcpSource(37));
    const { rerender } = render(<FirmwareUpdateSection baseUrl="" />);
    expect(card()!.getAttribute('data-reason')).toBe('linux-native');
    expectUpdateUi(false);

    h.sourceId = 'src-b';
    rerender(<FirmwareUpdateSection baseUrl="" />);
    expect(card()).toBeNull();
    expectUpdateUi(true);

    h.sourceId = 'src-a';
    rerender(<FirmwareUpdateSection baseUrl="" />);
    expect(card()!.getAttribute('data-reason')).toBe('linux-native');
    expectUpdateUi(false);
  });

  it('a non-Meshtastic source keeps its existing notice and gets no card', () => {
    setSource('src-mc', {
      connection: { connected: true, nodeResponsive: true },
      config: { meshtasticNodeIp: '', meshtasticSourceType: 'meshcore' },
      // A MeshCore/MQTT source has no local Meshtastic node to match a row by.
      nodes: [{ nodeNum: 0, user: { id: '', hwModel: 37 } }],
    });
    render(<FirmwareUpdateSection baseUrl="" />);

    expect(card()).toBeNull();
    expect(
      screen.getByText(
        'OTA firmware update is only available for TCP sources. The active source (meshcore) cannot be flashed from MeshMonitor.',
      ),
    ).toBeTruthy();
    expect((screen.getByText('Install') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the card once, without the bridged notice, for a bridged non-OTA board', () => {
    const fixture = tcpSource(9);
    (fixture.config.deviceMetadata as Record<string, unknown>).isBridged = true;
    setSource('src-a', fixture);
    render(<FirmwareUpdateSection baseUrl="" />);

    expect(card()!.getAttribute('data-reason')).toBe('platform-not-ota');
    expect(screen.queryByText(/serial\/BLE-to-TCP bridge/)).toBeNull();
  });

  it('a bridged node with a supported board keeps the bridged notice', () => {
    const fixture = tcpSource(43);
    (fixture.config.deviceMetadata as Record<string, unknown>).isBridged = true;
    setSource('src-a', fixture);
    render(<FirmwareUpdateSection baseUrl="" />);

    expect(card()).toBeNull();
    expect(screen.getByText(/serial\/BLE-to-TCP bridge/)).toBeTruthy();
    expect((screen.getByText('Install') as HTMLButtonElement).disabled).toBe(true);
  });

  it("never hides this source's running wizard behind the card", () => {
    setSource('src-a', tcpSource(37));
    h.status = { state: 'error', step: 'flash', message: 'Flash failed', logs: [], sourceId: 'src-a' };
    render(<FirmwareUpdateSection baseUrl="" />);

    expect(card()).toBeNull();
    expect(screen.getByText('Dismiss')).toBeTruthy();
  });

  it('shows the card beside the notice when the update runs on another source', () => {
    setSource('src-a', tcpSource(37));
    h.status = { state: 'in-progress', step: 'flash', message: 'Flashing', logs: [], sourceId: 'src-b' };
    render(<FirmwareUpdateSection baseUrl="" />);

    expect(card()!.getAttribute('data-reason')).toBe('linux-native');
    expect(screen.getByText(/A firmware update is running on another source/)).toBeTruthy();
    expect(screen.queryByText('Cancel Update')).toBeNull();
  });
});
