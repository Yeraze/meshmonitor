/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { copyTextToClipboard } from './clipboard.js';

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

describe('copyTextToClipboard', () => {
  afterEach(() => {
    setClipboard(undefined);
    vi.restoreAllMocks();
  });

  it('uses navigator.clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    expect(await copyTextToClipboard('abc')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('abc');
  });

  it('falls back to execCommand when writeText rejects', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('no')) });
    document.execCommand = vi.fn().mockReturnValue(true);
    expect(await copyTextToClipboard('abc')).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('uses execCommand when there is no clipboard, and removes the textarea', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn().mockReturnValue(true);
    expect(await copyTextToClipboard('abc')).toBe(true);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('returns false when execCommand fails', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn().mockReturnValue(false);
    expect(await copyTextToClipboard('abc')).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('returns false when execCommand throws', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => {
      throw new Error('boom');
    });
    expect(await copyTextToClipboard('abc')).toBe(false);
  });
});
