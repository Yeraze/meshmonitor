/**
 * Regression test for MeshCoreManager.sanitizeSerialPort() (#5172).
 *
 * The validation regex rejected nested udev symlinks like
 * /dev/serial/by-id/usb-... and /dev/serial/by-path/pci-..., which is the
 * recommended stable device path for USB passthrough in Docker/LXC (it
 * survives replug/reboot renumbering, unlike /dev/ttyACM0).
 */
import { describe, expect, it } from 'vitest';
import { MeshCoreManager } from './meshcoreManager.js';

function sanitize(port: string): string {
  const m = new MeshCoreManager('test-source');
  return (m as any).sanitizeSerialPort(port);
}

describe('MeshCoreManager.sanitizeSerialPort()', () => {
  it('accepts /dev/serial/by-id/... udev symlinks', () => {
    const port = '/dev/serial/by-id/usb-Seeed_Studio_XIAO_nRF52840_7142450D89DEE83A-if00';
    expect(sanitize(port)).toBe(port);
  });

  it('accepts /dev/serial/by-path/... udev symlinks with colons and dots', () => {
    const port = '/dev/serial/by-path/pci-0000:00:14.0-usb-0:1:1.0-port0';
    expect(sanitize(port)).toBe(port);
  });

  it('still accepts plain device nodes', () => {
    expect(sanitize('/dev/ttyACM0')).toBe('/dev/ttyACM0');
    expect(sanitize('/dev/ttyUSB0')).toBe('/dev/ttyUSB0');
  });

  it('still accepts COM ports and host:port', () => {
    expect(sanitize('COM3')).toBe('COM3');
    expect(sanitize('192.168.1.10:4403')).toBe('192.168.1.10:4403');
  });

  it('still accepts macOS cu. device nodes', () => {
    expect(sanitize('/dev/cu.usbserial-1410')).toBe('/dev/cu.usbserial-1410');
  });

  it('rejects paths outside /dev and path traversal', () => {
    expect(() => sanitize('/etc/passwd')).toThrow('Invalid serial port format');
    expect(() => sanitize('/dev/../etc/passwd')).toThrow('Invalid serial port format');
    expect(() => sanitize('')).toThrow('Invalid serial port format');
  });
});
