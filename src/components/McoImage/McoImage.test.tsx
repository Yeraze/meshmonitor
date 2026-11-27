/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DecodedMcoImage } from '../../utils/mcoImage/types.js';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const loader = vi.hoisted(() => ({
  load: null as unknown as () => Promise<unknown>,
  decode: null as unknown as (p: string) => unknown,
}));

vi.mock('./loadMcoCodec.js', () => ({
  getLoadedMcoCodec: () => null,
  loadMcoCodec: () => loader.load(),
}));

vi.mock('../../utils/clipboard.js', () => ({ copyTextToClipboard: vi.fn() }));

import { copyTextToClipboard } from '../../utils/clipboard.js';
import McoImage from './McoImage';

const PAYLOAD = 'im3:abcdef';
const mk = (w: number, h: number): DecodedMcoImage => ({
  format: 'im3',
  width: w,
  height: h,
  rgba: new Uint8ClampedArray(w * h * 4),
});

function useImage(image: DecodedMcoImage | null) {
  loader.decode = () => image;
  loader.load = () => Promise.resolve({ decodeMcoImageText: (p: string) => loader.decode(p) });
}

const canvasOf = async () => (await screen.findByRole('img')) as HTMLCanvasElement;

describe('McoImage', () => {
  beforeEach(() => {
    vi.mocked(copyTextToClipboard).mockReset();
    useImage(mk(2, 2));
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows text while loading, then the image', async () => {
    render(<McoImage payload={PAYLOAD} />);
    expect(screen.getByTestId('mco-image-text').textContent).toBe(PAYLOAD);
    const el = await screen.findByTestId('mco-image');
    expect(el.getAttribute('data-width')).toBe('2');
    expect(el.getAttribute('data-height')).toBe('2');
  });

  it('keeps the text when decode returns null', async () => {
    useImage(null);
    render(<McoImage payload={PAYLOAD} />);
    await waitFor(() => expect(loader.decode).toBeDefined());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('mco-image-text')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('keeps the text when the load rejects', async () => {
    loader.load = () => Promise.reject(new Error('x'));
    render(<McoImage payload={PAYLOAD} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('mco-image-text').textContent).toBe(PAYLOAD);
  });

  it('exposes accessible canvas wired to the tooltip', async () => {
    render(<McoImage payload={PAYLOAD} />);
    const canvas = await canvasOf();
    expect(canvas.tabIndex).toBe(0);
    expect(canvas.getAttribute('aria-label')).toBe('MCOimg image, 2 by 2 pixels');
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(canvas.getAttribute('aria-describedby')).toBe(tip.id);
  });

  it('shows the tooltip on hover and focus, hides on leave, blur, Escape', async () => {
    render(<McoImage payload={PAYLOAD} />);
    const canvas = await canvasOf();
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(tip.hidden).toBe(true);
    fireEvent.mouseEnter(canvas);
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toBe(PAYLOAD);
    fireEvent.mouseLeave(canvas);
    expect(tip.hidden).toBe(true);
    fireEvent.focus(canvas);
    expect(tip.hidden).toBe(false);
    fireEvent.blur(canvas);
    expect(tip.hidden).toBe(true);
    fireEvent.focus(canvas);
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(tip.hidden).toBe(true);
  });

  it('copies the payload, shows Copied, and does not propagate', async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(true);
    const parent = vi.fn();
    render(
      <div onClick={parent}>
        <McoImage payload={PAYLOAD} />
      </div>,
    );
    await canvasOf();
    fireEvent.click(screen.getByRole('button'));
    await screen.findByText('Copied');
    expect(copyTextToClipboard).toHaveBeenCalledWith(PAYLOAD);
    expect(parent).not.toHaveBeenCalled();
  });

  it('shows Copy failed when copy fails', async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(false);
    render(<McoImage payload={PAYLOAD} />);
    await canvasOf();
    fireEvent.click(screen.getByRole('button'));
    await screen.findByText('Copy failed');
  });

  it('skips drawing when getContext is null', async () => {
    render(<McoImage payload={PAYLOAD} />);
    await expect(canvasOf()).resolves.toBeTruthy();
  });

  it('draws once with the image size when a context exists', async () => {
    const putImageData = vi.fn();
    const createImageData = vi.fn((w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData,
      putImageData,
    } as unknown as CanvasRenderingContext2D);
    render(<McoImage payload={PAYLOAD} />);
    await canvasOf();
    expect(createImageData).toHaveBeenCalledWith(2, 2);
    expect(putImageData).toHaveBeenCalledTimes(1);
  });

  it('targets 192px display width', async () => {
    useImage(mk(48, 22));
    const a = render(<McoImage payload={PAYLOAD} />);
    expect((await canvasOf()).style.width).toBe('192px');
    a.unmount();
    useImage(mk(256, 256));
    render(<McoImage payload={PAYLOAD} />);
    expect((await canvasOf()).style.width).toBe('192px');
  });
});
