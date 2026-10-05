/**
 * NodeInfoModal — the connection address line.
 *
 * The server sends the node address only to a signed-in viewer with
 * `sources:read`. Everyone else gets an empty host, and the modal must say the
 * address is hidden rather than print a bare ":4403".
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeInfoModal } from './NodeInfoModal';

const baseProps = {
  isOpen: true,
  onClose: vi.fn(),
  nodeInfo: { longName: 'Base Station', shortName: 'BASE', nodeId: '!aabbccdd' },
  nodeIp: '10.0.0.7',
  tcpPort: 4403,
  defaultIp: '192.168.1.100',
  defaultPort: 4403,
  isOverridden: false,
  isAdmin: false,
  onChangeIp: vi.fn(),
};

const addressValue = () =>
  screen.getByText('node_info.address').parentElement!.querySelector('.node-info-value')!.textContent;

describe('NodeInfoModal address', () => {
  it('shows host:port when the server sent the address', () => {
    render(<NodeInfoModal {...baseProps} />);
    expect(addressValue()).toBe('10.0.0.7:4403');
  });

  it('says "hidden" when the address was withheld', () => {
    render(<NodeInfoModal {...baseProps} nodeIp="" defaultIp="" />);
    expect(addressValue()).toBe('node_info.address_hidden');
    expect(document.body.textContent).not.toContain(':4403');
  });

  it('hides a withheld default address too', () => {
    render(<NodeInfoModal {...baseProps} nodeIp="" defaultIp="" isOverridden />);
    const row = screen.getByText('node_info.default_address').parentElement!;
    expect(row.querySelector('.node-info-value')!.textContent).toBe('node_info.address_hidden');
  });
});
