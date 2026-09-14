/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ConfigSearchModal from './ConfigSearchModal';
import type { ConfigSurface } from './configSections';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const SURFACES: ConfigSurface[] = [
  {
    key: 'configuration',
    label: 'Configuration',
    path: '/source/abc/configuration',
    items: [
      { id: 'config-lora', label: 'LoRa', keywords: ['radio', 'region'] },
      { id: 'config-mqtt', label: 'MQTT', keywords: ['broker'] },
    ],
  },
  {
    key: 'global-settings',
    label: 'Global Settings',
    path: '/settings',
    items: [{ id: 'settings-map', label: 'Map', keywords: ['tiles'] }],
  },
];

const renderModal = (onClose = vi.fn()) => {
  render(
    <MemoryRouter>
      <ConfigSearchModal isOpen onClose={onClose} surfaces={SURFACES} />
    </MemoryRouter>,
  );
  return onClose;
};

const type = (value: string) =>
  fireEvent.change(screen.getByRole('textbox'), { target: { value } });

const optionLabels = () => screen.queryAllByRole('option').map((o) => o.textContent);

describe('ConfigSearchModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing while closed', () => {
    const { container } = render(
      <MemoryRouter>
        <ConfigSearchModal isOpen={false} onClose={vi.fn()} surfaces={SURFACES} />
      </MemoryRouter>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('lists no results until something is typed', () => {
    renderModal();
    expect(optionLabels()).toEqual([]);
  });

  it('finds a section on a page that is not currently open', () => {
    renderModal();
    type('mqtt');
    expect(optionLabels()).toEqual(['MQTTConfiguration']);
  });

  it('matches on a keyword the label never mentions', () => {
    renderModal();
    type('region');
    expect(optionLabels()).toEqual(['LoRaConfiguration']);
  });

  it('names the page each hit belongs to, so two "Map"s are tellable apart', () => {
    renderModal();
    type('map');
    expect(screen.getByRole('option')).toHaveTextContent('Global Settings');
  });

  it('navigates to the section as a hash deep link and closes', () => {
    const onClose = renderModal();
    type('mqtt');
    fireEvent.click(screen.getByRole('option'));
    expect(navigate).toHaveBeenCalledWith('/source/abc/configuration#config-mqtt');
    expect(onClose).toHaveBeenCalled();
  });

  it('opens the highlighted hit on Enter, moving with the arrow keys', () => {
    renderModal();
    type('a');
    const before = optionLabels();
    expect(before.length).toBeGreaterThan(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0]).toContain('#');
  });

  it('closes on Escape', () => {
    const onClose = renderModal();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('says so when a query matches nothing', () => {
    renderModal();
    type('zzzz');
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(optionLabels()).toEqual([]);
  });
});
