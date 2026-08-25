/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NodeDetailsBlock from './NodeDetailsBlock';
import type { DeviceInfo } from '../types/device';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, def?: string) => def ?? key }),
}));
vi.mock('../hooks/useServerData', () => ({
  useChannels: () => ({ channels: [] }),
  useDeviceConfig: () => ({ currentNodeId: null }),
}));
vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ nodeHopsCalculation: 'client' }),
}));
vi.mock('../contexts/MapContext', () => ({
  useMapContext: () => ({ traceroutes: [] }),
}));
vi.mock('./NodeDetailsBlock.css', () => ({}));

const getSignalTrend = vi.fn();
const getMeshtasticContactUrl = vi.fn();
vi.mock('../services/api', () => ({
  default: {
    // Called at import by ../init (pulled in transitively via NodeSkyView's
    // telemetry hook chain, #4729); stubbed so the module loads under this mock.
    setBaseUrl: () => {},
    getSignalTrend: (...args: unknown[]) => getSignalTrend(...args),
    getMeshtasticContactUrl: (...args: unknown[]) => getMeshtasticContactUrl(...args),
  },
}));

const toCanvas = vi.fn();
vi.mock('qrcode', () => ({
  default: {
    toCanvas: (...args: unknown[]) => toCanvas(...args),
  },
}));

const CONTACT_URL = 'https://meshtastic.org/v/#contact';
const baseNode: DeviceInfo = {
  nodeNum: 0x48bff5f5,
  user: {
    id: '!48bff5f5',
    longName: 'WAM8',
    shortName: 'WAM8',
    role: 'ROUTER',
  },
  isUnmessagable: true,
};

describe('NodeDetailsBlock contact sharing', () => {
  beforeEach(() => {
    localStorage.clear();
    getSignalTrend.mockReset();
    getSignalTrend.mockResolvedValue({ trend: 'insufficient' });
    getMeshtasticContactUrl.mockReset();
    getMeshtasticContactUrl.mockResolvedValue(CONTACT_URL);
    toCanvas.mockReset();
    toCanvas.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('loads lazily and renders QR and URL for an unmessagable node', async () => {
    render(<NodeDetailsBlock node={baseNode} sourceId="source-a" />);

    expect(screen.getByText('Share contact')).toBeInTheDocument();
    expect(getMeshtasticContactUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /create qr code/i }));

    expect(await screen.findByDisplayValue(CONTACT_URL)).toBeInTheDocument();
    expect(getMeshtasticContactUrl).toHaveBeenCalledWith(0x48bff5f5, 'source-a');
    await waitFor(() => expect(toCanvas).toHaveBeenCalled());
    expect(screen.getByRole('img', { name: 'Meshtastic contact QR code' }))
      .toBeInTheDocument();
  });

  it('copies the URL and reports clipboard failure', async () => {
    render(<NodeDetailsBlock node={baseNode} sourceId="source-a" />);
    fireEvent.click(screen.getByRole('button', { name: /create qr code/i }));
    await screen.findByDisplayValue(CONTACT_URL);

    fireEvent.click(screen.getByRole('button', { name: /copy url/i }));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CONTACT_URL);

    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: /copied/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to copy contact URL');
  });

  it('shows generation failures and does not offer sharing without a source', async () => {
    getMeshtasticContactUrl.mockRejectedValueOnce(new Error('Invalid contact identity'));
    const { rerender } = render(<NodeDetailsBlock node={baseNode} sourceId="source-a" />);

    fireEvent.click(screen.getByRole('button', { name: /create qr code/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to generate contact URL',
    );

    rerender(<NodeDetailsBlock node={baseNode} />);
    expect(screen.queryByText('Share contact')).not.toBeInTheDocument();
  });

  it('ignores a stale response and resets when the selected node changes', async () => {
    let resolveRequest!: (value: string) => void;
    getMeshtasticContactUrl.mockReturnValueOnce(
      new Promise<string>(resolve => {
        resolveRequest = resolve;
      }),
    );
    const { rerender } = render(
      <NodeDetailsBlock node={baseNode} sourceId="source-a" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /create qr code/i }));
    expect(await screen.findByText('Generating contact…')).toBeInTheDocument();

    rerender(
      <NodeDetailsBlock
        node={{
          ...baseNode,
          nodeNum: 0x12345678,
          user: { ...baseNode.user!, id: '!12345678', longName: 'Other node' },
        }}
        sourceId="source-a"
      />,
    );
    resolveRequest(CONTACT_URL);

    await waitFor(() => expect(screen.queryByDisplayValue(CONTACT_URL)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /create qr code/i }))
      .toHaveAttribute('aria-expanded', 'false');
  });
});
