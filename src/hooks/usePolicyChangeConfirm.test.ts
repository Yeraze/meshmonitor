/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { LAST_RESORT_CONFIRM_WORD, usePolicyChangeConfirm } from './usePolicyChangeConfirm';

const COMPATIBLE = 0;
const BALANCED = 1;
const STRICT = 2;
const node = { label: 'Base Station', shortName: 'BASE', fallbackWord: '!a1b2c3d4' };

describe('usePolicyChangeConfirm', () => {
  it('resolves true at once when the change needs no confirm', async () => {
    const { result } = renderHook(() => usePolicyChangeConfirm());

    await expect(result.current.confirmPolicyChange(STRICT, COMPATIBLE, node)).resolves.toBe(true);
    await expect(result.current.confirmPolicyChange(BALANCED, BALANCED, node)).resolves.toBe(true);
    expect(result.current.dialogProps.pending).toBeNull();
  });

  it('opens the dialog for Strict with the short name as the word, and resolves on confirm', async () => {
    const { result } = renderHook(() => usePolicyChangeConfirm());
    let answer!: Promise<boolean>;

    act(() => {
      answer = result.current.confirmPolicyChange(COMPATIBLE, STRICT, node);
    });
    expect(result.current.dialogProps.pending).toEqual({ to: STRICT, nodeLabel: 'Base Station', confirmWord: 'BASE' });

    act(() => result.current.dialogProps.onConfirm());

    await expect(answer).resolves.toBe(true);
    expect(result.current.dialogProps.pending).toBeNull();
  });

  it('resolves false on cancel', async () => {
    const { result } = renderHook(() => usePolicyChangeConfirm());
    let answer!: Promise<boolean>;
    act(() => {
      answer = result.current.confirmPolicyChange(COMPATIBLE, BALANCED, node);
    });

    act(() => result.current.dialogProps.onCancel());

    await expect(answer).resolves.toBe(false);
  });

  it.each([
    ['no short name', { label: 'X', shortName: '  ', fallbackWord: '!a1b2c3d4' }, '!a1b2c3d4'],
    ['no short name and no fallback', { label: '', shortName: '', fallbackWord: ' ' }, LAST_RESORT_CONFIRM_WORD],
  ])('Strict never loses its typed word: %s', (_name, bare, word) => {
    const { result } = renderHook(() => usePolicyChangeConfirm());

    act(() => {
      void result.current.confirmPolicyChange(COMPATIBLE, STRICT, bare);
    });

    expect(result.current.dialogProps.pending?.confirmWord).toBe(word);
  });

  it('an unmount while the dialog is open counts as a cancel', async () => {
    const { result, unmount } = renderHook(() => usePolicyChangeConfirm());
    let answer!: Promise<boolean>;
    act(() => {
      answer = result.current.confirmPolicyChange(COMPATIBLE, STRICT, node);
    });

    unmount();

    await expect(answer).resolves.toBe(false);
  });
});
