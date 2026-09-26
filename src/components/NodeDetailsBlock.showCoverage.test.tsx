/**
 * @vitest-environment jsdom
 *
 * "Show coverage" deep link (#5277 P4a WP5, spec §2a.8) on the Meshtastic
 * node details block. See `ShowCoverageLink.test.tsx` for the link's own
 * behaviour; these tests only check that `NodeDetailsBlock` wires it up
 * correctly (present with `node.user.id`, absent without one) and — since
 * this suite renders without a Router, like its siblings — that it falls
 * back to a plain `<a>` rather than throwing.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

const baseNode: DeviceInfo = {
  nodeNum: 0x0000007b,
  user: { id: '!0000007b', longName: 'Node', shortName: 'N', role: 'CLIENT' },
};

describe('NodeDetailsBlock "Show coverage" link', () => {
  it('shows the link, built from node.user.id, when rendered inside a Router', () => {
    render(
      <MemoryRouter>
        <NodeDetailsBlock node={baseNode} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /show coverage/i });
    expect(decodeURIComponent(link.getAttribute('href') ?? '')).toBe(
      '/reports?report=coverage&sender=!0000007b&range=24h',
    );
  });

  it('falls back to a plain <a> without throwing when rendered without a Router (matches sibling suites)', () => {
    render(<NodeDetailsBlock node={baseNode} />);
    const link = screen.getByRole('link', { name: /show coverage/i });
    expect(link.tagName).toBe('A');
    expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain(
      'sender=!0000007b',
    );
  });

  it('hides the link when the node has no user.id', () => {
    render(<NodeDetailsBlock node={{ ...baseNode, user: undefined }} />);
    expect(screen.queryByRole('link', { name: /show coverage/i })).not.toBeInTheDocument();
  });

  it('renders nothing at all (including the link) when node is null', () => {
    const { container } = render(<NodeDetailsBlock node={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
