/** @vitest-environment jsdom */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceNotificationToaster from './DeviceNotificationToaster';

type Handler = (data: unknown) => void;
const handlers: Record<string, Handler> = {};
const socket = {
  on: vi.fn((event: string, h: Handler) => { handlers[event] = h; }),
  off: vi.fn(),
};
const showToast = vi.fn();

vi.mock('../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ state: { socket } }),
}));
vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast }),
}));
vi.mock('react-i18next', () => {
  const t = (key: string, opts?: Record<string, string>) => (opts ? `${key} ${JSON.stringify(opts)}` : key);
  return { useTranslation: () => ({ t }) };
});

describe('DeviceNotificationToaster', () => {
  beforeEach(() => {
    showToast.mockClear();
    render(<DeviceNotificationToaster />);
  });

  it('shows the firmware text for an ordinary notice', () => {
    handlers['client-notification']({ level: 30, message: 'Duty cycle limit exceeded' });
    expect(showToast).toHaveBeenCalledWith('Duty cycle limit exceeded', 'warning', 8000);
  });

  it('explains a refused unsigned update in the viewer language (#5944)', () => {
    handlers['client-notification']({
      level: 30,
      message: 'Unsigned update from Hill Top (!0000beef) ignored, due to Strict security setting.',
      kind: 'unsigned_update_ignored',
      nodeNum: 0xbeef,
      nodeName: 'Hill Top',
      policy: 'strict',
    });
    expect(showToast).toHaveBeenCalledWith(
      'device_notification.unsigned_update_ignored {"node":"Hill Top (!0000beef)","level":"signature_policy.level_strict"}',
      'warning',
      8000,
    );
  });

  it('shows the bare id when the firmware gave no name', () => {
    handlers['client-notification']({
      level: 30,
      message: 'Unsigned update from !0000beef ignored, due to Balanced security setting.',
      kind: 'unsigned_update_ignored',
      nodeNum: 0xbeef,
      nodeName: null,
      policy: 'balanced',
    });
    expect(showToast.mock.calls[0][0]).toContain('"node":"!0000beef"');
    expect(showToast.mock.calls[0][0]).toContain('signature_policy.level_balanced');
  });
});
