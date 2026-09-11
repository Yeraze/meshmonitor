/**
 * Serial-port path validation (#5172).
 *
 * The allow-list only matched a single path segment under /dev, so a udev
 * persistent name — the form a Proxmox LXC passthrough hands you, e.g.
 * /dev/serial/by-id/usb-Seeed_Studio_XIAO_nRF52840_<serial>-if00 — was rejected
 * with "Invalid serial port format" and the source reconnect-looped forever.
 * Nested /dev paths are now accepted, while the guard against escaping /dev and
 * against shell/whitespace junk stays in place.
 */
import { describe, it, expect } from 'vitest';
import { MeshCoreManager } from './meshcoreManager.js';

function sanitize(port: string): string {
  const manager = new MeshCoreManager('src-a');
  return (manager as any).sanitizeSerialPort(port);
}

describe('MeshCore serial port validation (#5172)', () => {
  it('accepts udev by-id and by-path persistent names', () => {
    const byId = '/dev/serial/by-id/usb-Seeed_Studio_XIAO_nRF52840_7142450D89DEE83A-if00';
    expect(sanitize(byId)).toBe(byId);

    const byPath = '/dev/serial/by-path/pci-0000:00:14.0-usb-0:2:1.0-port0';
    expect(sanitize(byPath)).toBe(byPath);

    // A real by-id name off the hardware rig, for a CP2102 adapter.
    const rig = '/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0';
    expect(sanitize(rig)).toBe(rig);
  });

  it('still accepts the plain device nodes it always did', () => {
    for (const port of ['/dev/ttyACM0', '/dev/ttyUSB3', '/dev/cu.usbmodem14201', '/dev/rfcomm0']) {
      expect(sanitize(port)).toBe(port);
    }
  });

  it('keeps accepting underscores, which the by-id names lean on heavily', () => {
    // A single-segment underscore name, accepted by the old allow-list.
    expect(sanitize('/dev/tty_custom')).toBe('/dev/tty_custom');
    expect(sanitize('/dev/cu.usbmodem_1')).toBe('/dev/cu.usbmodem_1');
  });

  it('still accepts Windows COM ports and host:port pairs', () => {
    expect(sanitize('COM3')).toBe('COM3');
    expect(sanitize('192.168.1.50:5000')).toBe('192.168.1.50:5000');
  });

  it('rejects a path that walks back out of /dev', () => {
    expect(() => sanitize('/dev/../etc/passwd')).toThrow(/Invalid serial port format/);
    expect(() => sanitize('/dev/serial/../../etc/shadow')).toThrow(/Invalid serial port format/);
    expect(() => sanitize('/dev/./tty/../../tmp/x')).toThrow(/Invalid serial port format/);
  });

  it('rejects paths outside /dev and shell/whitespace junk', () => {
    for (const port of [
      '/etc/passwd',
      'ttyACM0',
      '/dev/ttyACM0; rm -rf /',
      '/dev/tty ACM0',
      '/dev/tty$(id)',
      '/dev/',
      '',
    ]) {
      expect(() => sanitize(port)).toThrow(/Invalid serial port format/);
    }
  });
});
