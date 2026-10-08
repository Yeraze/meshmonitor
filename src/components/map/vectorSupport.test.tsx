/**
 * @vitest-environment jsdom
 *
 * The WebGL2 probe, the page-wide "vector unavailable" flag, and the
 * one-map-at-a-time notice. `src/test/setup.ts` forces "available" before
 * every test; each test here switches back to the real probe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';
import {
  probeWebGl2,
  isVectorRenderingAvailable,
  reportVectorRenderingFailure,
  useVectorRenderingAvailable,
  useVectorFallbackNotice,
  setVectorRenderingForTests,
  resetVectorSupportForTests,
} from './vectorSupport';

let getContext: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setVectorRenderingForTests(null);
  resetVectorSupportForTests();
  localStorage.clear();
  getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
});
afterEach(() => {
  cleanup();
  getContext.mockRestore();
});

describe('probeWebGl2', () => {
  it('is false when the browser returns no webgl2 context', () => {
    getContext.mockReturnValue(null);
    expect(probeWebGl2()).toBe(false);
    expect(getContext).toHaveBeenCalledWith('webgl2');
  });

  it('does not accept WebGL1: MapLibre GL 6 needs WebGL2', () => {
    getContext.mockImplementation(((type: string) => (type === 'webgl' ? {} : null)) as never);
    expect(probeWebGl2()).toBe(false);
  });

  it('is true with a webgl2 context, and hands the context back', () => {
    const loseContext = vi.fn();
    getContext.mockReturnValue({ getExtension: () => ({ loseContext }) } as never);
    expect(probeWebGl2()).toBe(true);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('is true when the context cannot be released', () => {
    getContext.mockReturnValue({
      getExtension: () => {
        throw new Error('no extension');
      },
    } as never);
    expect(probeWebGl2()).toBe(true);
  });

  it('is false, not a throw, when getContext throws', () => {
    getContext.mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(probeWebGl2()).toBe(false);
  });
});

describe('isVectorRenderingAvailable', () => {
  it('probes once and caches the answer', () => {
    getContext.mockReturnValue(null);
    expect(isVectorRenderingAvailable()).toBe(false);
    expect(isVectorRenderingAvailable()).toBe(false);
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it('turns false for the page after a runtime creation failure', () => {
    getContext.mockReturnValue({ getExtension: () => null } as never);
    expect(isVectorRenderingAvailable()).toBe(true);
    reportVectorRenderingFailure();
    expect(isVectorRenderingAvailable()).toBe(false);
  });

  it('re-renders subscribers when a runtime failure is reported', () => {
    getContext.mockReturnValue({ getExtension: () => null } as never);
    const Probe = () => <span data-testid="v">{String(useVectorRenderingAvailable())}</span>;
    render(<Probe />);
    expect(screen.getByTestId('v').textContent).toBe('true');
    act(() => reportVectorRenderingFailure());
    expect(screen.getByTestId('v').textContent).toBe('false');
  });
});

describe('useVectorFallbackNotice', () => {
  function Map({ name, active = true }: { name: string; active?: boolean }) {
    const { show, dismiss } = useVectorFallbackNotice(active);
    return show ? (
      <button data-testid="notice" onClick={dismiss}>
        {name}
      </button>
    ) : null;
  }

  it('shows nothing on a map that is not falling back', () => {
    render(<Map name="a" active={false} />);
    expect(screen.queryByTestId('notice')).toBeNull();
  });

  it('shows on one map only when several fall back at once', () => {
    render(
      <>
        <Map name="a" />
        <Map name="b" />
        <Map name="c" />
      </>,
    );
    expect(screen.getAllByTestId('notice')).toHaveLength(1);
  });

  it('passes to a waiting map when the owner unmounts', () => {
    const { rerender } = render(
      <>
        <Map key="a" name="a" />
        <Map key="b" name="b" />
      </>,
    );
    expect(screen.getByTestId('notice').textContent).toBe('a');
    rerender(
      <>
        <Map key="b" name="b" />
      </>,
    );
    expect(screen.getByTestId('notice').textContent).toBe('b');
  });

  it('once dismissed it stays away, on every map and after a reload', () => {
    render(
      <>
        <Map name="a" />
        <Map name="b" />
      </>,
    );
    fireEvent.click(screen.getByTestId('notice'));
    expect(screen.queryByTestId('notice')).toBeNull();
    expect(localStorage.getItem('mm-vector-fallback-notice-dismissed')).toBe('1');

    // A "reload": module state is gone, only localStorage is left.
    cleanup();
    resetVectorSupportForTests();
    render(<Map name="c" />);
    expect(screen.queryByTestId('notice')).toBeNull();
  });
});
