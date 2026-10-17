/**
 * @vitest-environment jsdom
 *
 * MeshCoreLocalConsole — Companion catalog by firmware (#5868). Protocol 14+
 * (fw 1.18.0) has its own text CLI, so it gets the larger catalog; older or
 * not-yet-read firmware keeps the five-verb shim catalog.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MeshCoreLocalConsole } from './MeshCoreLocalConsole';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const actions = () => ({ sendLocalCliCommand: vi.fn().mockResolvedValue({ reply: 'ok' }) });

describe('MeshCoreLocalConsole Companion catalog (#5868)', () => {
  it('shows the firmware-CLI catalog on protocol 14', () => {
    render(<MeshCoreLocalConsole sourceId="s" deviceType={1} firmwareVer={14} connected actions={actions()} />);
    for (const label of ['Version', 'Stats', 'Clock', 'Radio', 'TX power', 'Time zone', 'Zero-hop advert', 'Help', 'Reboot']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByPlaceholderText(/get radio, set tx/)).toBeInTheDocument();
  });

  it.each([13, undefined])('keeps the shim catalog on protocol %s', (firmwareVer) => {
    render(<MeshCoreLocalConsole sourceId="s" deviceType={1} firmwareVer={firmwareVer} connected actions={actions()} />);
    expect(screen.queryByText('Radio')).not.toBeInTheDocument();
    expect(screen.queryByText('Reboot')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Type a command \(ver, stats, clock/)).toBeInTheDocument();
  });

  it('ignores the protocol byte on a Repeater', () => {
    render(<MeshCoreLocalConsole sourceId="s" deviceType={2} firmwareVer={14} connected actions={actions()} />);
    expect(screen.getByText('Neighbors')).toBeInTheDocument();
    expect(screen.queryByText('Radio')).not.toBeInTheDocument();
  });

  it('disables only the zero-hop advert while receive-only', () => {
    render(<MeshCoreLocalConsole sourceId="s" deviceType={1} firmwareVer={14} connected actions={actions()} receiveOnly />);
    expect(screen.getByText('Zero-hop advert').closest('button')).toBeDisabled();
    for (const label of ['Radio', 'TX power', 'Reboot']) {
      expect(screen.getByText(label).closest('button')).not.toBeDisabled();
    }
  });
});
