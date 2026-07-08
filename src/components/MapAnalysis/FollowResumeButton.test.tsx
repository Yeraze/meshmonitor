/**
 * @vitest-environment jsdom
 *
 * FollowResumeButton (issue #3788 P2 WP-D, spec test #4). Mocks
 * useMapAnalysisCtx so each case can drive config/followPaused directly.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FollowResumeButton from './FollowResumeButton';
import { DEFAULT_CONFIG } from '../../hooks/useMapAnalysisConfig';
import type { MapAnalysisConfig } from '../../hooks/useMapAnalysisConfig';

let mockConfig: MapAnalysisConfig;
let mockFollowPaused: boolean;
let setFollowPausedSpy: ReturnType<typeof vi.fn>;
vi.mock('./MapAnalysisContext', () => ({
  useMapAnalysisCtx: () => ({
    config: mockConfig,
    followPaused: mockFollowPaused,
    setFollowPaused: setFollowPausedSpy,
  }),
}));

function setup(overrides: { followMode?: boolean; autoZoom?: boolean; followPaused?: boolean }) {
  mockConfig = {
    ...DEFAULT_CONFIG,
    followMode: overrides.followMode ?? false,
    autoZoom: overrides.autoZoom ?? false,
  };
  mockFollowPaused = overrides.followPaused ?? false;
  setFollowPausedSpy = vi.fn();
  return render(<FollowResumeButton />);
}

describe('FollowResumeButton', () => {
  it('renders nothing when no mode is active, even if paused', () => {
    const { container } = setup({ followMode: false, autoZoom: false, followPaused: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when a mode is active but not paused', () => {
    const { container } = setup({ followMode: true, autoZoom: false, followPaused: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the button when Follow is active and paused', () => {
    setup({ followMode: true, autoZoom: false, followPaused: true });
    expect(screen.getByRole('button', { name: /resume follow/i })).toBeInTheDocument();
  });

  it('renders the button when Auto-zoom is active and paused', () => {
    setup({ followMode: false, autoZoom: true, followPaused: true });
    expect(screen.getByRole('button', { name: /resume follow/i })).toBeInTheDocument();
  });

  it('calls setFollowPaused(false) on click', () => {
    setup({ followMode: true, autoZoom: true, followPaused: true });
    fireEvent.click(screen.getByRole('button', { name: /resume follow/i }));
    expect(setFollowPausedSpy).toHaveBeenCalledWith(false);
  });
});
