/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { decodeImageFile, McoImageFileError, MCO_SOURCE_MAX_BYTES } from './decodeImageFile.js';

const file = (name: string, type: string, size = 10) => {
  const f = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof McoImageFileError ? e.kind : 'other';
  }
  return 'none';
}

describe('decodeImageFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects a GIF by MIME and a wrong extension', async () => {
    expect(await kindOf(decodeImageFile(file('a.gif', 'image/gif')))).toBe('type');
    expect(await kindOf(decodeImageFile(file('a.gif', 'image/png')))).toBe('type');
  });

  it('rejects an oversize file', async () => {
    expect(await kindOf(decodeImageFile(file('a.png', 'image/png', MCO_SOURCE_MAX_BYTES + 1)))).toBe('size');
  });

  it('scales to the max side and returns RGBA', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1024, height: 256, close }));
    const drawImage = vi.fn();
    const ctx = {
      drawImage,
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(7) }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    const out = await decodeImageFile(file('a.jpg', 'image/jpeg'));
    expect([out.width, out.height]).toEqual([512, 128]);
    expect(out.rgba.length).toBe(512 * 128 * 4);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 512, 128);
    expect(close).toHaveBeenCalled();
  });

  it('maps a decode failure to kind decode', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('bad')));
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined });
    class FailImg {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', FailImg);
    expect(await kindOf(decodeImageFile(file('a.png', 'image/png')))).toBe('decode');
  });
});
