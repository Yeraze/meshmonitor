/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../services/api', () => ({ default: api }));

import { MeshCoreFirmwareUpdateSection } from './MeshCoreFirmwareUpdateSection';

describe('MeshCoreFirmwareUpdateSection (#4943)', () => {
  beforeEach(() => {
    api.get.mockReset().mockResolvedValue({
      success: true,
      data: { role: 'repeater', channel: 'stable', latest: { version: '1.18.0', tagName: 'repeater-v1.18.0', htmlUrl: 'https://mc/r' } },
    });
  });

  it('shows the newest release for the role and asks the console to confirm Start OTA', async () => {
    const onStart = vi.fn();
    render(<MeshCoreFirmwareUpdateSection sourceId="s1" deviceType="repeater" result={null} onStart={onStart} />);
    expect(await screen.findByText(/1\.18\.0/)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/sources/s1/meshcore/admin/firmware/latest?role=repeater');
    fireEvent.click(screen.getByText('Start OTA mode…'));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('turns an ESP32 reply into WiFi upload steps', () => {
    render(
      <MeshCoreFirmwareUpdateSection
        sourceId="s1"
        deviceType="room"
        result={{ ok: true, reply: 'Started: http://192.168.4.1/update' }}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByText(/http:\/\/192\.168\.4\.1\/update/)).toBeInTheDocument();
    expect(screen.getByText(/MeshCore-OTA" \(no password\)/)).toBeInTheDocument();
  });

  it('turns an nRF52 reply into DFU app steps with the address', () => {
    render(
      <MeshCoreFirmwareUpdateSection sourceId="s1" deviceType="repeater" result={{ ok: true, reply: 'OK - mac: C4:AA:01:02:03:FE' }} onStart={vi.fn()} />,
    );
    expect(screen.getByText(/nRF Device Firmware Update/)).toBeInTheDocument();
    expect(screen.getByText(/C4:AA:01:02:03:FE/)).toBeInTheDocument();
  });

  it('warns that a timeout may still have started OTA', () => {
    render(
      <MeshCoreFirmwareUpdateSection sourceId="s1" deviceType="repeater" result={{ ok: false, error: 'x', code: 'CLI_TIMEOUT' }} onStart={vi.fn()} />,
    );
    expect(screen.getByText(/may still have entered update mode/)).toBeInTheDocument();
  });

  it('is disabled when the console is blocked', () => {
    render(<MeshCoreFirmwareUpdateSection sourceId="s1" deviceType="repeater" disabled result={null} onStart={vi.fn()} />);
    expect((screen.getByText('Start OTA mode…') as HTMLButtonElement).disabled).toBe(true);
  });
});
