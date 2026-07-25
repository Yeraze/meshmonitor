/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QrCodeCanvas } from './QrCodeCanvas';

const toCanvas = vi.fn().mockResolvedValue(undefined);
vi.mock('qrcode', () => ({
  default: {
    toCanvas: (...args: unknown[]) => toCanvas(...args),
  },
}));

describe('QrCodeCanvas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    toCanvas.mockClear();
  });

  it('clears a previously rendered QR code when the value becomes empty', () => {
    const clearRect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect,
    } as unknown as CanvasRenderingContext2D);

    const { rerender } = render(<QrCodeCanvas value="contact-url" />);
    rerender(<QrCodeCanvas value="" />);

    expect(clearRect).toHaveBeenCalledWith(0, 0, 300, 150);
  });
});
