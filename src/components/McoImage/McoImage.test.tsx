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
  paint: null as unknown as ReturnType<typeof vi.fn>,
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

const mk4 = (w: number, h: number, captions: string[] = []): DecodedMcoImage => ({
  format: 'im4',
  width: w,
  height: h,
  document: {} as never,
  captions,
});

function useImage(image: DecodedMcoImage | null) {
  loader.decode = () => image;
  loader.paint = vi.fn();
  loader.load = () =>
    Promise.resolve({
      decodeMcoImageText: (p: string) => loader.decode(p),
      paintMcoImageV4: loader.paint,
    });
}

const stubDpr = (value: number) => vi.stubGlobal('devicePixelRatio', value);

const canvasOf = async () => (await screen.findByRole('img')) as HTMLCanvasElement;

describe('McoImage', () => {
  beforeEach(() => {
    vi.mocked(copyTextToClipboard).mockReset();
    useImage(mk(2, 2));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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

  it('marks the format on the root and uses the vector class only for im4', async () => {
    const a = render(<McoImage payload={PAYLOAD} />);
    expect((await screen.findByTestId('mco-image')).getAttribute('data-format')).toBe('im3');
    expect((await canvasOf()).className).not.toContain('vector');
    a.unmount();
    useImage(mk4(16, 16));
    render(<McoImage payload="im4:abcde" />);
    expect((await screen.findByTestId('mco-image')).getAttribute('data-format')).toBe('im4');
    expect((await canvasOf()).className).toContain('vector');
  });

  it('sizes the im4 backing store by the device pixel ratio', async () => {
    stubDpr(2);
    useImage(mk4(16, 16));
    render(<McoImage payload="im4:abcde" />);
    const canvas = await canvasOf();
    expect(canvas.style.width).toBe('192px');
    expect(canvas.width).toBe(384);
    expect(canvas.height).toBe(384);
  });

  it('clamps the device pixel ratio to 1..3 and keeps the aspect ratio', async () => {
    stubDpr(5);
    useImage(mk4(64, 32));
    const a = render(<McoImage payload="im4:abcde" />);
    let canvas = await canvasOf();
    expect(canvas.style.width).toBe('192px');
    expect(canvas.width).toBe(576);
    expect(canvas.height).toBe(288);
    a.unmount();
    stubDpr(0.5);
    render(<McoImage payload="im4:abcde" />);
    canvas = await canvasOf();
    expect(canvas.width).toBe(192);
    expect(canvas.height).toBe(96);
  });

  it('shows im4 with text at 256px and im4 without text at 192px', async () => {
    useImage(mk4(48, 22, ['hello']));
    const a = render(<McoImage payload="im4:abcde" />);
    expect((await canvasOf()).style.width).toBe('240px'); // 48 * floor(256 / 48)
    a.unmount();
    useImage(mk4(256, 256, ['hello']));
    const b = render(<McoImage payload="im4:abcde" />);
    expect((await canvasOf()).style.width).toBe('256px');
    b.unmount();
    useImage(mk4(256, 256));
    render(<McoImage payload="im4:abcde" />);
    expect((await canvasOf()).style.width).toBe('192px');
  });

  it('keeps im3 at 192px even when an im4 caption would enlarge it', async () => {
    useImage(mk(256, 256));
    render(<McoImage payload={PAYLOAD} />);
    expect((await canvasOf()).style.width).toBe('192px');
  });

  it('labels an im4 with captions, truncating long text', async () => {
    useImage(mk4(16, 16, ['Queens Weather', 'Sunny']));
    const a = render(<McoImage payload="im4:abcde" />);
    expect((await canvasOf()).getAttribute('aria-label')).toBe(
      'MCOimg image, 16 by 16, text: Queens Weather; Sunny',
    );
    a.unmount();
    useImage(mk4(16, 16, ['x'.repeat(400)]));
    render(<McoImage payload="im4:abcde" />);
    const label = (await canvasOf()).getAttribute('aria-label') ?? '';
    expect(label).toBe(`MCOimg image, 16 by 16, text: ${'x'.repeat(300)}\u2026`);
  });

  it('uses the plain label for an im4 without text', async () => {
    useImage(mk4(16, 16));
    render(<McoImage payload="im4:abcde" />);
    expect((await canvasOf()).getAttribute('aria-label')).toBe('MCOimg image, 16 by 16 pixels');
  });

  it('paints an im4 once with the document and backing size when a context exists', async () => {
    stubDpr(2);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    useImage(mk4(16, 16, ['hi']));
    render(<McoImage payload="im4:abcde" />);
    await canvasOf();
    expect(loader.paint).toHaveBeenCalledTimes(1);
    const [, doc, opts] = loader.paint.mock.calls[0];
    expect(doc).toEqual({});
    expect(opts).toMatchObject({ pixelWidth: 512, pixelHeight: 512 });
    expect(typeof opts.fontFamily).toBe('string');
    expect(opts.fontFamily).not.toBe('');
  });

  it('does not paint an im4 when getContext is null', async () => {
    useImage(mk4(16, 16));
    render(<McoImage payload="im4:abcde" />);
    await canvasOf();
    expect(loader.paint).not.toHaveBeenCalled();
  });

  it('keeps tooltip text and Copy for im4', async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(true);
    useImage(mk4(16, 16, ['hi']));
    render(<McoImage payload="im4:abcde" />);
    const canvas = await canvasOf();
    fireEvent.mouseEnter(canvas);
    expect(screen.getByRole('tooltip').textContent).toBe('im4:abcde');
    fireEvent.click(screen.getByRole('button'));
    await screen.findByText('Copied');
    expect(copyTextToClipboard).toHaveBeenCalledWith('im4:abcde');
  });
});
